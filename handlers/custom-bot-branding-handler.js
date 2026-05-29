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

async function deployCommands(token, appId) {
    if (!appId || !commandPayloads.length) return;
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(appId), { body: commandPayloads });
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

function attachRuntimeHandlers(runtimeClient) {
    runtimeClient.commands = commandMap || new Map();
    if (typeof handleInteraction === 'function') {
        runtimeClient.on('interactionCreate', interaction => handleInteraction(interaction, runtimeClient));
    }
    if (typeof handleMessage === 'function') {
        runtimeClient.on('messageCreate', handleMessage);
    }
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
    attachRuntimeHandlers(runtimeClient);

    const botName = String(customBot.botName || 'Custom Support Bot').trim().slice(0, 80);
    const appId = String(customBot.appId || '').trim();
    clients.set(String(guildId), { client: runtimeClient, fingerprint, botName, appId, ready: false });
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
            const targetGuild = runtimeClient.guilds.cache.get(String(guildId)) || await runtimeClient.guilds.fetch(String(guildId)).catch(() => null);
            if (!targetGuild) {
                throw new Error('Custom bot logged in, but it is not invited to the target server.');
            }
            applyPresence(runtimeClient, customBot);
            let deployError = null;
            try {
                await deployCommands(token, resolvedAppId);
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
                    : `${runtimeClient.user?.tag || botName} connected and command deployment completed.`
            }).catch(() => null);
        } catch (error) {
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
