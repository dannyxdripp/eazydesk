const crypto = require('crypto');
const { Client, GatewayIntentBits, ActivityType, REST, Routes } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const storageMonitor = require('../utils/storage-monitor');

const clients = new Map();
let hostClient = null;
let commandMap = null;
let commandPayloads = [];
let handleInteraction = null;
let handleMessage = null;
let syncTimer = null;

function tokenFingerprint(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}

function commandPayloadFingerprint() {
    try {
        return crypto
            .createHash('sha256')
            .update(JSON.stringify(commandPayloads || []))
            .digest('hex')
            .slice(0, 16);
    } catch {
        return '';
    }
}

function shouldDeployCommands(entry, access) {
    const fingerprint = commandPayloadFingerprint();
    if (!fingerprint) return false;
    if (!entry || entry.commandFingerprint !== fingerprint) return true;

    const customBot = access?.customBot && typeof access.customBot === 'object' ? access.customBot : {};
    const requestedAt = Date.parse(customBot.lastCommandSyncRequestedAt || '');
    const syncedAt = Date.parse(customBot.lastCommandSyncAt || '');
    return !Number.isNaN(requestedAt) && (Number.isNaN(syncedAt) || requestedAt > syncedAt);
}

function getIntervalMs() {
    return Math.max(15000, Number(process.env.CUSTOM_BOT_SYNC_INTERVAL_MS || 30000));
}

function isEligible(access) {
    const customBot = access?.customBot && typeof access.customBot === 'object' ? access.customBot : {};
    return ['custom', 'custom_trial'].includes(String(access?.plan || '')) &&
        access.enabled !== false &&
        customBot.enabled !== false &&
        Boolean(String(customBot.token || '').trim());
}

function applyPresence(client, customBot) {
    const statusText = String(customBot.statusText || 'Handling support').trim().slice(0, 120) || 'Handling support';
    client.user.setPresence({
        status: 'online',
        activities: [{ name: statusText, type: ActivityType.Watching }]
    });
}

function patchCustomBot(guildId, patch) {
    const storage = ticketStore.getActiveStorage();
    const current = ticketStore.getGuildAiAccess(guildId, storage);
    const currentCustomBot = current.customBot && typeof current.customBot === 'object' ? current.customBot : {};
    return ticketStore.setGuildAiAccess(guildId, {
        customBot: {
            ...currentCustomBot,
            ...patch
        }
    }, storage);
}

async function deployCommands(token, appId, guildId) {
    if (!appId || !commandPayloads.length) return { global: false, guild: false, count: 0 };
    const rest = new REST({ version: '10' }).setToken(token);
    const deployGlobal = process.env.CUSTOM_BOT_DEPLOY_GLOBAL_COMMANDS === 'true';
    if (guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commandPayloads });
    }
    if (deployGlobal) {
        await rest.put(Routes.applicationCommands(appId), { body: commandPayloads });
    } else if (process.env.CUSTOM_BOT_CLEAR_GLOBAL_COMMANDS !== 'false') {
        await rest.put(Routes.applicationCommands(appId), { body: [] });
    }
    return {
        global: deployGlobal,
        clearedGlobal: !deployGlobal && process.env.CUSTOM_BOT_CLEAR_GLOBAL_COMMANDS !== 'false',
        guild: Boolean(guildId),
        count: commandPayloads.length
    };
}

async function announceStartup(guildId, customBot, runtimeClient) {
    const current = ticketStore.getGuildAiAccess(guildId);
    if (current.customBot?.startupAnnouncedAt) return;

    const botName = String(customBot.botName || runtimeClient.user?.username || 'Support Bot').trim();
    const lines = [
        `[00:00] Booting ${botName}`,
        '[00:01] Loading brand profile',
        '[00:02] Connecting Discord gateway',
        '[00:03] Syncing ticket commands',
        '[OK] Custom support bot is online'
    ];
    const content = [
        `**${botName} is online**`,
        '```text',
        ...lines,
        '```'
    ].join('\n');

    try {
        const guild = hostClient?.guilds?.cache?.get(String(guildId));
        const owner = guild ? await guild.fetchOwner().catch(() => null) : null;
        await owner?.send?.({ content }).catch(() => null);
        patchCustomBot(guildId, { startupAnnouncedAt: new Date().toISOString() });
    } catch {}
}

async function notifyAndLeaveUnauthorizedGuild(runtimeClient, guild, targetGuildId) {
    const content = [
        `**${runtimeClient.user?.username || 'This custom support bot'} is not enabled for this server.**`,
        `This custom bot is locked to server ID \`${targetGuildId}\`.`,
        '',
        'Ask the bot owner to add this server as a Custom server if this is intentional.'
    ].join('\n');

    try {
        const owner = await guild.fetchOwner().catch(() => null);
        await owner?.send?.({ content }).catch(() => null);
    } catch {}

    try {
        const systemChannel = guild.systemChannel || guild.publicUpdatesChannel || null;
        await systemChannel?.send?.({ content }).catch(() => null);
    } catch {}

    storageMonitor.reportCustomBotEvent('unauthorized_guild', {
        guildId: targetGuildId,
        unauthorizedGuildId: guild?.id,
        unauthorizedGuildName: guild?.name
    }).catch(() => null);

    try {
        await guild.leave();
    } catch {}
}

async function enforceGuildLock(runtimeClient, targetGuildId) {
    const allowed = String(targetGuildId || '');
    const guilds = [...runtimeClient.guilds.cache.values()];
    for (const guild of guilds) {
        if (String(guild.id) !== allowed) {
            await notifyAndLeaveUnauthorizedGuild(runtimeClient, guild, allowed);
        }
    }
}

function describeJoinedGuildIds(runtimeClient) {
    const ids = [...(runtimeClient?.guilds?.cache?.keys?.() || [])].map(String).filter(Boolean);
    return ids.length ? ids.join(', ') : 'none';
}

async function getTargetGuild(runtimeClient, guildId) {
    const id = String(guildId || '').trim();
    if (!id) return null;
    return runtimeClient.guilds.cache.get(id) || await runtimeClient.guilds.fetch(id).catch(() => null);
}

function attachRuntimeHandlers(runtimeClient, targetGuildId) {
    runtimeClient.commands = commandMap || new Map();
    if (typeof handleInteraction === 'function') {
        runtimeClient.on('interactionCreate', async interaction => {
            try {
                if (interaction.guildId && String(interaction.guildId) !== String(targetGuildId)) {
                    const payload = {
                        content: 'This custom bot is not enabled for this server. Ask the bot owner to add this server as a Custom server if this is intentional.',
                        ephemeral: true
                    };
                    if (interaction.isRepliable?.()) {
                        await interaction.reply(payload).catch(() => null);
                    }
                    return;
                }
                return await handleInteraction(interaction, runtimeClient);
            } catch (error) {
                storageMonitor.reportCustomBotEvent('error', {
                    guildId: targetGuildId,
                    customId: interaction?.customId || null,
                    commandName: interaction?.commandName || null,
                    reason: 'interaction handler failed'
                }, error).catch(() => null);
                if (interaction?.isRepliable?.()) {
                    const payload = { content: 'That action failed before it could complete. Please try again in a moment.', ephemeral: true };
                    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
                    else await interaction.reply(payload).catch(() => null);
                }
            }
        });
    }
    if (typeof handleMessage === 'function') {
        runtimeClient.on('messageCreate', message => {
            if (message.guildId && String(message.guildId) !== String(targetGuildId)) return;
            return handleMessage(message);
        });
    }
    runtimeClient.on('guildCreate', guild => notifyAndLeaveUnauthorizedGuild(runtimeClient, guild, targetGuildId));
}

async function stopGuild(guildId, reason = 'disabled') {
    const entry = clients.get(String(guildId));
    if (!entry) return { ok: true, stopped: false };
    clients.delete(String(guildId));
    try {
        entry.client.destroy();
    } catch {}
    patchCustomBot(guildId, {
        runtimeStatus: 'stopped',
        lastStoppedAt: new Date().toISOString(),
        lastStopReason: reason
    });
    storageMonitor.reportCustomBotEvent('stopped', {
        guildId,
        botName: entry.botName,
        appId: entry.appId,
        reason
    }).catch(() => null);
    return { ok: true, stopped: true };
}

async function startGuild(guildId, access) {
    const customBot = access?.customBot && typeof access.customBot === 'object' ? access.customBot : {};
    const token = String(customBot.token || '').trim();
    const fingerprint = tokenFingerprint(token);
    const existing = clients.get(String(guildId));
    if (existing && existing.fingerprint === fingerprint) {
        if (existing.ready) {
            const resolvedAppId = existing.appId || existing.client.application?.id || existing.client.user?.id || '';
            const targetGuild = await getTargetGuild(existing.client, guildId);
            if (!targetGuild) {
                const message = `Custom bot is not in assigned server ${guildId}. Joined server IDs: ${describeJoinedGuildIds(existing.client)}.`;
                clients.delete(String(guildId));
                try { existing.client.destroy(); } catch {}
                patchCustomBot(guildId, {
                    runtimeStatus: 'error',
                    lastError: message,
                    lastErrorAt: new Date().toISOString()
                });
                storageMonitor.reportCustomBotEvent('error', { guildId, botName: existing.botName, appId: resolvedAppId, reason: 'target guild missing' }, new Error(message)).catch(() => null);
                return { ok: false, reused: true, error: new Error(message) };
            }
            if (!shouldDeployCommands(existing, access)) {
                patchCustomBot(guildId, {
                    runtimeStatus: 'online',
                    lastError: null
                });
                return { ok: true, reused: true, synced: false };
            }
            try {
                const result = await deployCommands(token, resolvedAppId, String(guildId));
                existing.commandFingerprint = commandPayloadFingerprint();
                patchCustomBot(guildId, {
                    runtimeStatus: 'online',
                    lastCommandSyncAt: new Date().toISOString(),
                    lastCommandSyncCount: result.count,
                    lastError: null
                });
                return { ok: true, reused: true, synced: true, commands: result.count };
            } catch (error) {
                patchCustomBot(guildId, {
                    runtimeStatus: 'online',
                    lastError: `Command sync failed: ${error?.message || error}`,
                    lastErrorAt: new Date().toISOString()
                });
                storageMonitor.reportCustomBotEvent('error', { guildId, botName: existing.botName, appId: resolvedAppId, reason: 'manual command sync failed' }, error).catch(() => null);
                return { ok: false, reused: true, error };
            }
        }
        return { ok: true, reused: true };
    }
    if (existing) {
        await stopGuild(guildId, 'token or configuration changed');
    }

    const runtimeClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers
        ]
    });
    attachRuntimeHandlers(runtimeClient, String(guildId));

    const botName = String(customBot.botName || 'Custom Support Bot').trim().slice(0, 80);
    const appId = String(customBot.appId || '').trim();
    clients.set(String(guildId), { client: runtimeClient, fingerprint, botName, appId, ready: false, commandFingerprint: '' });
    patchCustomBot(guildId, {
        runtimeStatus: 'starting',
        lastStartAttemptAt: new Date().toISOString(),
        lastError: null
    });

    runtimeClient.once('clientReady', async () => {
        const entry = clients.get(String(guildId));
        if (entry) entry.ready = true;
        const resolvedAppId = appId || runtimeClient.application?.id || runtimeClient.user?.id || '';
        try {
            const targetGuild = await getTargetGuild(runtimeClient, guildId);
            if (!targetGuild) {
                await enforceGuildLock(runtimeClient, String(guildId));
                throw new Error(`Custom bot logged in, but it is not invited to assigned server ${guildId}. Joined server IDs: ${describeJoinedGuildIds(runtimeClient)}.`);
            }
            await enforceGuildLock(runtimeClient, String(guildId));
            applyPresence(runtimeClient, customBot);
            let deployError = null;
            let deployResult = null;
            try {
                deployResult = await deployCommands(token, resolvedAppId, String(guildId));
                const entryAfterDeploy = clients.get(String(guildId));
                if (entryAfterDeploy) entryAfterDeploy.commandFingerprint = commandPayloadFingerprint();
            } catch (error) {
                deployError = error;
                storageMonitor.reportCustomBotEvent('error', {
                    guildId,
                    botName,
                    appId: resolvedAppId,
                    reason: 'slash command deployment failed'
                }, error).catch(() => null);
            }
            patchCustomBot(guildId, {
                runtimeStatus: 'online',
                lastStartedAt: new Date().toISOString(),
                lastError: deployError ? `Command sync failed: ${deployError?.message || deployError}` : null,
                lastCommandSyncAt: new Date().toISOString(),
                lastCommandSyncCount: deployResult?.count || 0,
                appId: customBot.appId || resolvedAppId
            });
            await announceStartup(guildId, customBot, runtimeClient);
            storageMonitor.reportCustomBotEvent('online', {
                guildId,
                botName,
                appId: resolvedAppId,
                userTag: runtimeClient.user?.tag,
                description: deployError
                    ? `${runtimeClient.user?.tag || botName} connected, but slash command deployment failed.`
                    : `${runtimeClient.user?.tag || botName} connected and ${deployResult?.count || 0} slash command(s) were synced to the server.`
            }).catch(() => null);
        } catch (error) {
            clients.delete(String(guildId));
            try { runtimeClient.destroy(); } catch {}
            patchCustomBot(guildId, {
                runtimeStatus: 'error',
                lastError: error?.message || String(error),
                lastErrorAt: new Date().toISOString()
            });
            storageMonitor.reportCustomBotEvent('error', { guildId, botName, appId: resolvedAppId }, error).catch(() => null);
        }
    });

    const onRuntimeError = error => {
        patchCustomBot(guildId, {
            runtimeStatus: 'error',
            lastError: error?.message || String(error),
            lastErrorAt: new Date().toISOString()
        });
        storageMonitor.reportCustomBotEvent('error', { guildId, botName, appId }, error).catch(() => null);
    };
    runtimeClient.on('error', onRuntimeError);
    runtimeClient.on('shardError', onRuntimeError);

    try {
        await runtimeClient.login(token);
        return { ok: true, started: true };
    } catch (error) {
        clients.delete(String(guildId));
        try { runtimeClient.destroy(); } catch {}
        patchCustomBot(guildId, {
            runtimeStatus: 'error',
            lastError: error?.message || String(error),
            lastErrorAt: new Date().toISOString()
        });
        storageMonitor.reportCustomBotEvent('error', { guildId, botName, appId }, error).catch(() => null);
        return { ok: false, error };
    }
}

async function syncGuild(guildId, access = null) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return { ok: false, error: new Error('Invalid guild id') };
    const current = access || ticketStore.getEffectiveGuildAiAccess(id);
    if (!isEligible(current)) {
        return stopGuild(id, 'custom bot disabled or missing token');
    }
    return startGuild(id, current);
}

async function syncAll() {
    const storage = ticketStore.getActiveStorage();
    const configured = storage.aiGuildAccess && typeof storage.aiGuildAccess === 'object' ? storage.aiGuildAccess : {};
    const desired = new Set();
    for (const [guildId, rawAccess] of Object.entries(configured)) {
        const access = ticketStore.getEffectiveGuildAiAccess(guildId, storage);
        if (!isEligible(access)) continue;
        desired.add(String(guildId));
        await startGuild(guildId, access);
    }
    for (const guildId of clients.keys()) {
        if (!desired.has(guildId)) await stopGuild(guildId, 'removed from configuration');
    }
}

async function start(options = {}) {
    hostClient = options.hostClient || hostClient;
    commandMap = options.commandMap || commandMap;
    commandPayloads = Array.isArray(options.commandPayloads) ? options.commandPayloads : commandPayloads;
    handleInteraction = options.handleInteraction || handleInteraction;
    handleMessage = options.handleMessage || handleMessage;
    await syncAll();
    if (!syncTimer) {
        syncTimer = setInterval(() => syncAll().catch(error => {
            storageMonitor.reportCustomBotEvent('error', { reason: 'periodic sync failed' }, error).catch(() => null);
        }), getIntervalMs());
        if (typeof syncTimer.unref === 'function') syncTimer.unref();
    }
}

function getStatus(guildId) {
    const entry = clients.get(String(guildId || ''));
    if (!entry) return null;
    return {
        online: Boolean(entry.ready),
        botName: entry.botName,
        appId: entry.appId
    };
}

module.exports = {
    getStatus,
    start,
    stopGuild,
    syncAll,
    syncGuild
};
