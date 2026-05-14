const { Client, GatewayIntentBits, ActivityType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const ticketStore = require('./utils/ticket-store');
const transcriptionHandler = require('./handlers/transcription-handler');
const closeRequestCommand = require('./commands/closerequest');
const tagCommand = require('./commands/tag');
const feedbackCommand = require('./commands/feedback');
const { startDashboard } = require('./dashboard/server');
const { loadEnv } = require('./utils/load-env');
const { pruneTranscriptArchives, getTranscriptRetentionDays } = require('./utils/transcript-archive');
const { getPublicBaseUrl } = require('./utils/public-url');
const { resolveEmbedByTitle } = require('./utils/embed-config');
const { buildV2FromTemplate } = require('./utils/components-v2-messages');
const {
    TWELVE_HOURS_MS,
    getLastActivityMs,
    touchTicket,
    updateTicketChannelMetadata
} = require('./utils/ticket-metadata');
const loadedEnvFiles = loadEnv();

// Warm JSON caches early to reduce latency on first interactions (especially modal opens).
ticketStore.getTicketTypes();
ticketStore.getSupportTeams();
ticketStore.getTags();
// If this installation previously stored per-guild configs inside active-storage.json, migrate them out.
try {
    const activeStorage = ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    if (botConfig?.guilds && typeof botConfig.guilds === 'object') {
        for (const [guildId, cfg] of Object.entries(botConfig.guilds)) {
            if (!/^\d{17,20}$/.test(String(guildId))) continue;
            if (!cfg || typeof cfg !== 'object') continue;
            ticketStore.setGuildConfig(guildId, cfg, activeStorage);
        }
        delete botConfig.guilds;
        activeStorage.botConfig = botConfig;
        ticketStore.saveActiveStorage(activeStorage);
    }
} catch (error) {
    console.error('[Event 🔔] Guild config migration failed:', error);
}

try {
    const retentionDays = getTranscriptRetentionDays();
    pruneTranscriptArchives({ retentionDays });
    setInterval(() => pruneTranscriptArchives({ retentionDays: getTranscriptRetentionDays() }), 24 * 60 * 60 * 1000);
} catch (error) {
    console.error('[Event \u{1F514}] Transcript retention sweep failed:', error);
}

const rawConsoleError = console.error.bind(console);
const rawConsoleWarn = console.warn.bind(console);
console.error = (...args) => {
    rawConsoleError('[Error \u274C] An error occoured.. standby...');
    rawConsoleError(...args);
};
console.warn = (...args) => {
    rawConsoleWarn('[Warning \u26A0\uFE0F]');
    rawConsoleWarn(...args);
};

function appLog(message) {
    console.log('[Application \u{1F916}] ' + message);
}

function eventLog(message) {
    console.log('[Event \u{1F514}] ' + message);
}

function deployLog(message) {
    console.log('[Deploying \u{1F504}\uFE0F] ' + message);
}

function loginLog(message) {
    console.log('[Logging In \u{1F5DD}\uFE0F] ' + message);
}

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function splitCsv(value, fallback = []) {
    const source = String(value || '').trim();
    if (!source) return fallback;
    return source.split(',').map(item => item.trim()).filter(Boolean);
}

function toPresenceStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    if (['online', 'idle', 'dnd', 'invisible'].includes(status)) return status;
    return 'online';
}

function toActivityType(value) {
    const map = {
        PLAYING: ActivityType.Playing,
        STREAMING: ActivityType.Streaming,
        LISTENING: ActivityType.Listening,
        WATCHING: ActivityType.Watching,
        COMPETING: ActivityType.Competing,
        CUSTOM: ActivityType.Custom
    };
    return map[String(value || '').trim().toUpperCase()] ?? ActivityType.Playing;
}

function configurePresenceRotation(client) {
    const statuses = splitCsv(process.env.STATUS_ROTATION, [process.env.STATUS || 'online']).map(toPresenceStatus);
    const activities = splitCsv(process.env.ACTIVITY_ROTATION, [process.env.ACTIVITY || 'Helping users']);
    const activityTypes = splitCsv(process.env.ACTIVITY_TYPE_ROTATION, [process.env.ACTIVITY_TYPE || 'PLAYING']).map(toActivityType);
    const maxCount = Math.max(statuses.length, activities.length, activityTypes.length);
    const intervalSeconds = Math.max(15, Number(process.env.PRESENCE_ROTATION_INTERVAL_SEC || 60));
    let index = 0;

    const applyPresence = () => {
        const status = statuses[index % statuses.length] || 'online';
        const activity = activities[index % activities.length] || 'Helping users';
        const activityType = activityTypes[index % activityTypes.length] ?? ActivityType.Playing;

        client.user.setPresence({
            activities: [{ name: activity, type: activityType }],
            status
        });
    };

    applyPresence();
    if (maxCount > 1) {
        setInterval(() => {
            index += 1;
            applyPresence();
        }, intervalSeconds * 1000);
    }
}

function getMissingRequiredEnvVars() {
    const required = ['TOKEN', 'APP_ID'];
    return required.filter(key => !String(process.env[key] || '').trim());
}

function logStartupWarnings() {
    const warnings = [];

    if (loadedEnvFiles.length) {
        console.log(`[Startup] Loaded env from: ${loadedEnvFiles.join(', ')}`);
    } else {
        console.warn('[Startup] No .env file found at project root or src/.env; using process environment only.');
    }

    if (!String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim()) {
        warnings.push('PUBLIC_BASE_URL is not set. Transcript/dashboard links will fall back to localhost-style URLs.');
    }

    if (String(process.env.DASHBOARD_REQUIRE_OAUTH || '').trim().toLowerCase() === 'true') {
        if (!String(process.env.DISCORD_OAUTH_CLIENT_ID || '').trim() || !String(process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim()) {
            warnings.push('Dashboard OAuth is enabled but DISCORD_OAUTH_CLIENT_ID / DISCORD_OAUTH_CLIENT_SECRET are missing.');
        }
    }

    for (const warning of warnings) {
        console.warn(`[Startup] ${warning}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableDiscordStartupError(error) {
    const status = Number(error?.status || 0);
    if ([429, 500, 502, 503, 504].includes(status)) return true;

    const code = String(error?.code || '').trim().toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;

    const message = String(error?.message || '').toLowerCase();
    return message.includes('service unavailable') || message.includes('gateway');
}

async function loginWithRetry(clientInstance, token) {
    const retryBaseMs = Math.max(5000, Number(process.env.LOGIN_RETRY_BASE_MS || 15000));
    const retryMaxMs = Math.max(retryBaseMs, Number(process.env.LOGIN_RETRY_MAX_MS || 120000));
    let attempt = 0;

    while (true) {
        attempt += 1;
        try {
            loginLog(`Discord client login attempt started${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);
            await clientInstance.login(token);
            return;
        } catch (error) {
            if (!isRetriableDiscordStartupError(error)) {
                throw error;
            }

            const delayMs = Math.min(retryMaxMs, retryBaseMs * Math.max(1, attempt));
            console.warn(`[Startup] Discord login failed with ${error?.status || error?.code || 'unknown error'}; retrying in ${Math.round(delayMs / 1000)}s.`);
            await sleep(delayMs);
        }
    }
}

const BOT_OWNER_ID = String(process.env.BOT_OWNER_ID || process.env.OWNER_USER_ID || process.env.OWNER_ID || '').trim();
const OWNER_COMMAND_PREFIX = 't!';
const OWNER_COMMAND_HIDE = String(process.env.OWNER_COMMAND_HIDE || 'true').toLowerCase() === 'true';
const RATE_LIMIT_DURATION_MS = 60 * 60 * 1000;
const INACTIVITY_SWEEP_MS = 10 * 60 * 1000;
const AUTO_CLOSE_REQUEST_TIMER_MIN = Number(process.env.AUTO_CLOSE_REQUEST_TIMER_MIN || 360);
const COMMAND_COOLDOWN_MS = Math.max(0, Number(process.env.COMMAND_COOLDOWN_MS || 2500));
const COMMAND_BURST_WINDOW_MS = Math.max(1000, Number(process.env.COMMAND_BURST_WINDOW_MS || 10000));
const COMMAND_BURST_MAX = Math.max(1, Number(process.env.COMMAND_BURST_MAX || 5));
const TICKET_OPEN_COOLDOWN_MS = Math.max(0, Number(process.env.TICKET_OPEN_COOLDOWN_MS || 15000));
const commandCooldowns = new Map();
const commandBurstBuckets = new Map();
const ticketOpenCooldowns = new Map();
const quickviewTimers = new Map();
const QUICKVIEW_DURATION_MS = 5 * 60 * 1000;

function parseCommandCooldownOverrides(raw) {
    const output = new Map();
    const source = String(raw || '').trim();
    if (!source) return output;

    for (const pair of source.split(',')) {
        const [nameRaw, msRaw] = String(pair || '').split(':');
        const name = String(nameRaw || '').trim().toLowerCase();
        const ms = Number(String(msRaw || '').trim());
        if (!name || Number.isNaN(ms) || ms < 0) continue;
        output.set(name, ms);
    }
    return output;
}

const COMMAND_COOLDOWN_OVERRIDES = parseCommandCooldownOverrides(process.env.COMMAND_LIMITS);

function formatDurationMs(ms) {
    const safe = Math.max(0, Number(ms || 0));
    const seconds = Math.ceil(safe / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes}m`;
}

function checkAndTrackCommandRateLimit(interaction) {
    const now = Date.now();
    const guildId = interaction.guildId || 'dm';
    const userId = interaction.user?.id || 'unknown';
    const commandName = interaction.commandName || 'unknown';
    const commandCooldownMs = Number(COMMAND_COOLDOWN_OVERRIDES.get(String(commandName).toLowerCase()) ?? COMMAND_COOLDOWN_MS);
    const cooldownKey = `${guildId}:${userId}:${commandName}`;
    const cooldownUntil = Number(commandCooldowns.get(cooldownKey) || 0);
    if (cooldownUntil > now) {
        return {
            limited: true,
            retryAfterMs: cooldownUntil - now,
            reason: 'cooldown'
        };
    }

    const burstKey = `${guildId}:${userId}`;
    const bucket = Array.isArray(commandBurstBuckets.get(burstKey))
        ? commandBurstBuckets.get(burstKey)
        : [];
    const recent = bucket.filter(timestamp => (now - timestamp) <= COMMAND_BURST_WINDOW_MS);
    if (recent.length >= COMMAND_BURST_MAX) {
        const oldest = recent[0];
        return {
            limited: true,
            retryAfterMs: Math.max(0, COMMAND_BURST_WINDOW_MS - (now - oldest)),
            reason: 'burst'
        };
    }

    commandCooldowns.set(cooldownKey, now + Math.max(0, commandCooldownMs));
    recent.push(now);
    commandBurstBuckets.set(burstKey, recent);
    return { limited: false, retryAfterMs: 0, reason: null };
}

function extractChannelId(raw) {
    const source = String(raw || '').trim();
    const mention = source.match(/^<#(\d{17,20})>$/);
    if (mention) return mention[1];
    if (/^\d{17,20}$/.test(source)) return source;
    return null;
}

async function sendOwnerOnlyNotice(message, payload) {
    try {
        await message.author.send(payload);
        return true;
    } catch {
        await message.channel.send(payload).catch(() => null);
        return false;
    }
}

async function handleOwnerPrefixCommand(message, input, activeStorage) {
    if (!BOT_OWNER_ID || message.author.id !== BOT_OWNER_ID) return false;

    if (OWNER_COMMAND_HIDE) {
        await message.delete().catch(() => null);
    }

    const trimmed = String(input || '').trim();
    const parts = trimmed ? trimmed.split(/\s+/g) : [];
    const command = String(parts.shift() || 'help').toLowerCase();
    const args = parts;

    const send = (title, description, color) => sendOwnerOnlyNotice(message, buildMessage(title, description, color));
    const baseUrl = getPublicBaseUrl();

    if (command === 'help') {
        const lines = [
            `\`${OWNER_COMMAND_PREFIX}help\` — show this help`,
            `\`${OWNER_COMMAND_PREFIX}ping\` — websocket ping + uptime`,
            `\`${OWNER_COMMAND_PREFIX}dashboard\` — dashboard URL hints`,
            `\`${OWNER_COMMAND_PREFIX}tickets\` — active ticket overview`,
            `\`${OWNER_COMMAND_PREFIX}close [#channel|id] [reason...]\` — close ticket with transcript`,
            `\`${OWNER_COMMAND_PREFIX}transcript [#channel|id]\` — generate transcript (no close)`,
            `\`${OWNER_COMMAND_PREFIX}ai <enable|disable|ratelimit>\` — control AI responder`,
            `\`${OWNER_COMMAND_PREFIX}reload\` — reload JSON caches`
        ];
        await send('Owner Commands', lines.join('\n'), 0x5865F2);
        return true;
    }

    if (command === 'ping') {
        const ws = Math.round(Number(message.client.ws.ping || 0));
        const up = Math.floor(process.uptime());
        await send('Pong', `WS: **${ws}ms**\nUptime: **${up}s**`, 0x57F287);
        return true;
    }

    if (command === 'dashboard') {
        const port = Number(process.env.DASHBOARD_PORT || 3100);
        const host = String(process.env.DASHBOARD_HOST || (process.env.DASHBOARD_TOKEN ? '0.0.0.0' : '127.0.0.1')).trim();
        const localUrl = `http://localhost:${port}/overview`;
        const bindUrl = `http://${host}:${port}/overview`;
        const dashboardUrl = `${baseUrl}/dashboard`;
        const controllerUrl = `${baseUrl}/controller`;
        const setupUrl = `${baseUrl}/setup`;
        await send('Dashboard', `Local: ${localUrl}\nBind: ${bindUrl}\nDashboard: ${dashboardUrl}\nController: ${controllerUrl}\nSetup: ${setupUrl}`, 0x5865F2);
        return true;
    }

    if (command === 'reload') {
        ticketStore.getTicketTypes();
        ticketStore.getSupportTeams();
        ticketStore.getTags();
        await send('Reloaded', 'Reloaded cached JSON (ticket types, teams, tags).', 0x57F287);
        return true;
    }

    if (command === 'tickets') {
        const tickets = Array.isArray(activeStorage?.tickets) ? activeStorage.tickets : [];
        const head = `Active tickets: **${tickets.length}**`;
        const sample = tickets.slice(0, 10).map(t => {
            const id = String(t?.channelId || '');
            const type = String(t?.ticketType || 'Unknown');
            const who = t?.createdBy ? `<@${t.createdBy}>` : '(unknown)';
            return id ? `- <#${id}> — **${type}** — ${who}` : null;
        }).filter(Boolean);
        await send('Tickets', [head, ...(sample.length ? sample : ['No active tickets.'])].join('\n'), 0x5865F2);
        return true;
    }

    if (command === 'close') {
        const maybeChannel = extractChannelId(args[0]);
        const targetChannelId = maybeChannel || message.channel.id;
        const reason = (maybeChannel ? args.slice(1) : args).join(' ').trim() || 'Closed by owner.';
        const ticket = ticketStore.getTicketByChannelId(targetChannelId, activeStorage);
        if (!ticket) {
            await send('Not a Ticket', `Channel <#${targetChannelId}> is not an active ticket.`, 0xED4245);
            return true;
        }

        const ticketChannel = await message.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!ticketChannel) {
            await send('Channel Missing', 'Unable to fetch that channel.', 0xED4245);
            return true;
        }

        await send('Closing Ticket', `Closing <#${targetChannelId}>...\nReason: ${reason}`, 0xFEE75C);
        await closeRequestCommand.closeTicketWithTranscript(ticketChannel, String(reason).slice(0, 900), message.author.id);
        return true;
    }

    if (command === 'quickview') {
        const targetChannelId = extractChannelId(args[0]);
        if (!targetChannelId) {
            await send('Usage', `\`${OWNER_COMMAND_PREFIX}quickview <#channel|id>\``, 0x5865F2);
            return true;
        }

        const ticket = ticketStore.getTicketByChannelId(targetChannelId, activeStorage);
        if (!ticket) {
            await send('Not a Ticket', `Channel <#${targetChannelId}> is not an active ticket.`, 0xED4245);
            return true;
        }

        const channel = await message.client.channels.fetch(targetChannelId).catch(() => null);
        if (!channel || !channel.isTextBased?.() || !channel.guild || !channel.permissionOverwrites) {
            await send('Channel Missing', 'Unable to fetch that channel.', 0xED4245);
            return true;
        }

        const existing = channel.permissionOverwrites.cache.get(BOT_OWNER_ID) || null;
        if (existing) {
            await send('Quickview Blocked', 'You already have an explicit permission overwrite in that channel, so quickview will not modify permissions.', 0xFEE75C);
            return true;
        }

        const key = `${channel.guild.id}:${targetChannelId}`;
        const currentTimer = quickviewTimers.get(key);
        if (currentTimer) {
            clearTimeout(currentTimer);
            quickviewTimers.delete(key);
        }

        try {
            await channel.permissionOverwrites.create(
                BOT_OWNER_ID,
                { ViewChannel: true, ReadMessageHistory: true, SendMessages: false },
                { reason: 'Owner quickview (5 minutes)' }
            );
        } catch (error) {
            console.error('[Owner] quickview failed:', error);
            await send('Quickview Failed', 'Could not add temporary permissions. Ensure the bot has Manage Channels.', 0xED4245);
            return true;
        }

        const expiresAt = new Date(Date.now() + QUICKVIEW_DURATION_MS).toLocaleString('en-GB', { hour12: false });
        await send('Quickview Enabled', `You can view <#${targetChannelId}> until **${expiresAt}**.`, 0x57F287);

        const timer = setTimeout(async () => {
            quickviewTimers.delete(key);
            await channel.permissionOverwrites.delete(BOT_OWNER_ID, 'Owner quickview expired').catch(() => null);
        }, QUICKVIEW_DURATION_MS);
        timer.unref?.();
        quickviewTimers.set(key, timer);
        return true;
    }

    if (command === 'restartsetup') {
        const guildId = String(args[0] || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            await send('Usage', `\`${OWNER_COMMAND_PREFIX}restartsetup <serverId>\``, 0x5865F2);
            return true;
        }

        const now = new Date().toISOString();
        if (typeof ticketStore.setGuildConfig === 'function') {
            ticketStore.setGuildConfig(guildId, {
                setup: {
                    completed: false,
                    restartedAt: now,
                    restartedBy: BOT_OWNER_ID
                }
            }, activeStorage);
        }

        const url = `${baseUrl}/setup?guild=${encodeURIComponent(guildId)}`;
        await send('Setup Restarted', `Server: \`${guildId}\`\nSetup URL: ${url}`, 0x57F287);
        return true;
    }

    if (command === 'transcript') {
        const maybeChannel = extractChannelId(args[0]);
        const targetChannelId = maybeChannel || message.channel.id;
        const ticket = ticketStore.getTicketByChannelId(targetChannelId, activeStorage);
        if (!ticket) {
            await send('Not a Ticket', `Channel <#${targetChannelId}> is not an active ticket.`, 0xED4245);
            return true;
        }

        const ticketChannel = await message.guild.channels.fetch(targetChannelId).catch(() => null);
        if (!ticketChannel) {
            await send('Channel Missing', 'Unable to fetch that channel.', 0xED4245);
            return true;
        }

        await send('Transcript', `Generating transcript for <#${targetChannelId}>...`, 0x5865F2);
        const transcriptPath = await transcriptionHandler.createTranscript(ticketChannel);
        await transcriptionHandler.sendTranscript(ticketChannel, transcriptPath, { keepFile: false });
        await send('Transcript', 'Transcript sent to the transcripts channel.', 0x57F287);
        return true;
    }

    if (command === 'ai') {
        const action = String(args[0] || '').trim().toLowerCase();
        const aiControl = ticketStore.getAiControl(activeStorage);

        if (action === 'ratelimit') {
            const until = new Date(Date.now() + RATE_LIMIT_DURATION_MS).toISOString();
            ticketStore.setAiControl({ ...aiControl, rateLimitedUntil: until }, activeStorage);
            const readable = new Date(until).toLocaleString('en-GB', { hour12: false });
            await send('AI Rate-Limited', `AI responses are disabled until **${readable}** (approximately 1 hour).`, 0xFEE75C);
            return true;
        }

        if (action === 'disable' || action === 'cancel') {
            ticketStore.setAiControl({ ...aiControl, manualDisabled: true }, activeStorage);
            await send('AI Disabled', 'AI support agent responses are now disabled until manually re-enabled.', 0xED4245);
            return true;
        }

        if (action === 'enable') {
            ticketStore.setAiControl({ ...aiControl, manualDisabled: false, rateLimitedUntil: null }, activeStorage);
            await send('AI Enabled', 'AI support agent responses are now enabled.', 0x57F287);
            return true;
        }

        await send('AI', `Usage: \`${OWNER_COMMAND_PREFIX}ai <enable|disable|ratelimit>\``, 0x5865F2);
        return true;
    }

    await send('Unknown Command', `Try \`${OWNER_COMMAND_PREFIX}help\`.`, 0xED4245);
    return true;
}

function checkAndTrackTicketOpenRateLimit(interaction) {
    const now = Date.now();
    const guildId = interaction.guildId || 'dm';
    const userId = interaction.user?.id || 'unknown';
    const key = `${guildId}:${userId}`;
    const until = Number(ticketOpenCooldowns.get(key) || 0);
    if (until > now) {
        return { limited: true, retryAfterMs: until - now };
    }

    ticketOpenCooldowns.set(key, now + TICKET_OPEN_COOLDOWN_MS);
    return { limited: false, retryAfterMs: 0 };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, until] of commandCooldowns.entries()) {
        if (Number(until) <= now) commandCooldowns.delete(key);
    }

    for (const [key, timestamps] of commandBurstBuckets.entries()) {
        const recent = (Array.isArray(timestamps) ? timestamps : []).filter(ts => (now - ts) <= COMMAND_BURST_WINDOW_MS);
        if (recent.length === 0) {
            commandBurstBuckets.delete(key);
        } else {
            commandBurstBuckets.set(key, recent);
        }
    }

    for (const [key, until] of ticketOpenCooldowns.entries()) {
        if (Number(until) <= now) ticketOpenCooldowns.delete(key);
    }
}, 60 * 1000);

async function runTicketInactivitySweep(client) {
    if (!client?.isReady?.()) return;
    const activeStorage = ticketStore.getActiveStorage();
    const tickets = Array.isArray(activeStorage.tickets) ? activeStorage.tickets : [];
    const now = Date.now();

    for (const ticket of tickets) {
        if (!ticket?.channelId) continue;
        const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        await updateTicketChannelMetadata(channel, ticket, now);

        const inactiveFor12Hours = (now - getLastActivityMs(ticket)) >= TWELVE_HOURS_MS;
        if (!inactiveFor12Hours) continue;

        const notifiedAtMs = Date.parse(ticket.inactivityNotifiedAt || '');
        if (!Number.isNaN(notifiedAtMs) && (now - notifiedAtMs) < TWELVE_HOURS_MS) continue;

        const activeRequest = ticketStore.getCloseRequest(ticket.channelId, activeStorage);
        if (activeRequest?.status === 'pending') continue;

        const requestedAt = new Date(now).toISOString();
        ticketStore.setCloseRequest(ticket.channelId, {
            reason: 'Ticket inactive for 12+ hours without updates',
            timer: AUTO_CLOSE_REQUEST_TIMER_MIN,
            requestedBy: ticket.claimedBy || ticket.createdBy || null,
            requestedAt,
            status: 'pending',
            source: 'auto-notifier'
        }, activeStorage);

        ticket.inactivityNotifiedAt = requestedAt;
        ticketStore.saveActiveStorage(activeStorage);

        const mentions = [...new Set([ticket.createdBy, ticket.claimedBy].filter(Boolean))]
            .map(id => `<@${id}>`)
            .join(' ');

        const base = buildMessage(
                'Inactivity Notice',
                [
                    mentions || null,
                    `This ticket has been inactive for 12+ hours.`,
                    `A close request was created and will auto-close in **${AUTO_CLOSE_REQUEST_TIMER_MIN} minutes** unless the ticket opener acts.`
                ].filter(Boolean).join('\n\n'),
                0xFEE75C
            );

        await channel.send({
            ...base,
            components: [...base.components, closeRequestCommand.buildCloseRequestButtons()]
        }).catch(() => null);

        closeRequestCommand.scheduleCloseRequestTimer(channel, AUTO_CLOSE_REQUEST_TIMER_MIN);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.commands = new Map();

client.on('guildCreate', async guild => {
    try {
        const now = new Date().toISOString();
        const activeStorage = ticketStore.getActiveStorage();
        const existing = ticketStore.bootstrapGuildConfig(guild.id, { storage: activeStorage }) || {};
        ticketStore.setGuildConfig(guild.id, {
            ...existing,
            setup: {
                ...(existing.setup || {}),
                completed: false,
                createdAt: existing.setup?.createdAt || now,
                guildName: guild.name
            }
        }, activeStorage);

        const baseUrl = getPublicBaseUrl();
        const setupUrl = `${baseUrl}/setup?guild=${encodeURIComponent(guild.id)}`;
        const payload = buildMessage(
            'Setup Required',
            `Joined **${guild.name}** (\`${guild.id}\`).\n\nSetup: ${setupUrl}`,
            0x5865F2
        );

        if (BOT_OWNER_ID) {
            const owner = await client.users.fetch(BOT_OWNER_ID).catch(() => null);
            if (owner) await owner.send(payload).catch(() => null);
        }
    } catch (error) {
        console.error('[Event 🔔] guildCreate handler failed:', error);
    }
});

// Load commands dynamically
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
const commands = [];

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if (command.data && command.execute) {
        client.commands.set(command.data.name, command);
        commands.push(command.data.toJSON());
    }
}

// Start dashboard as soon as the process boots so panel access does not depend on Discord ready/login.
startDashboard(client);

const missingRequiredEnvVars = getMissingRequiredEnvVars();
if (missingRequiredEnvVars.length) {
    throw new Error(`Missing required environment variables: ${missingRequiredEnvVars.join(', ')}`);
}

logStartupWarnings();

client.once('clientReady', async () => {
    loginLog(`Logged in as ${client.user.tag}`);
    appLog('Application startup complete.');

    configurePresenceRotation(client);

    // Refresh and deploy commands
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        deployLog('Deploying commands globally...');
        await rest.put(Routes.applicationCommands(process.env.APP_ID), { body: commands });
        deployLog('Successfully deployed commands globally.');

        if (process.env.TEST_GUILD_ID) {
            deployLog('Deploying commands to testing server...');
            await rest.put(Routes.applicationGuildCommands(process.env.APP_ID, process.env.TEST_GUILD_ID), { body: commands });
            deployLog('Successfully deployed commands to testing server.');
        }
    } catch (error) {
        console.error('[Deploying \u{1F504}\uFE0F] Error deploying commands:', error);
    }

    runTicketInactivitySweep(client).catch(error => {
        console.error('[Event \u{1F514}] Initial inactivity sweep failed:', error);
    });
    setInterval(() => {
        runTicketInactivitySweep(client).catch(error => {
            console.error('[Event \u{1F514}] Inactivity sweep failed:', error);
        });
    }, INACTIVITY_SWEEP_MS);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command || typeof command.autocomplete !== 'function') return;

        try {
            await command.autocomplete(interaction);
        } catch (error) {
            console.error(`[Event \u{1F514}] Error handling autocomplete for ${interaction.commandName}:`, error);
        }
    } else if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`[Event \u{1F514}] No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            const commandRateLimit = checkAndTrackCommandRateLimit(interaction);
            if (commandRateLimit.limited) {
                const reasonText = commandRateLimit.reason === 'burst'
                    ? `You are sending commands too quickly. Please wait **${formatDurationMs(commandRateLimit.retryAfterMs)}**.`
                    : `Please wait **${formatDurationMs(commandRateLimit.retryAfterMs)}** before using \`/${interaction.commandName}\` again.`;
                const base = buildMessage('Slow Down', reasonText, 0xFEE75C);
                await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
                return;
            }
            await command.execute(interaction);
        } catch (error) {
            console.error(`[Event \u{1F514}] Error executing ${interaction.commandName}:`, error);
            if (interaction.replied || interaction.deferred) {
                const base = buildMessage('Command Error', 'There was an error while executing this command.', 0xED4245);
                await interaction.followUp({ ...base, flags: MessageFlags.Ephemeral | base.flags }).catch(() => null);
            } else {
                const base = buildMessage('Command Error', 'There was an error while executing this command.', 0xED4245);
                await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags }).catch(() => null);
            }
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId === feedbackCommand.MODAL_ID) {
            await feedbackCommand.handleModalSubmit(interaction);
        } else {
            const ticketOpenLimit = checkAndTrackTicketOpenRateLimit(interaction);
            if (ticketOpenLimit.limited) {
                const base = buildMessage('Slow Down', `Please wait **${formatDurationMs(ticketOpenLimit.retryAfterMs)}** before opening another ticket.`, 0xFEE75C);
                await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags }).catch(() => null);
                return;
            }
            const ticketHandler = require('./handlers/ticket-handler');
            await ticketHandler.handleTicketReasonSubmit(interaction);
        }
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select-ticket-type') {
            const ticketHandler = require('./handlers/ticket-handler');
            await ticketHandler.handleTicketSelection(interaction);
        }
    } else if (interaction.isButton()) {
        const ticketHandler = require('./handlers/ticket-handler');
        if (interaction.customId === 'open-support-flow' || interaction.customId === 'p_275287590028972042') {
            await ticketHandler.handleOpenSupportFlow(interaction);
        } else if (interaction.customId.startsWith('open-ticket-type:')) {
            await ticketHandler.handleTicketTypeButton(interaction);
        } else if (interaction.customId.startsWith('create-ticket-')) {
            const ticketType = interaction.customId.replace('create-ticket-', '').replace(/-/g, ' ');
            const resolvedTicketType = ticketStore.findTicketType(ticketType, interaction.guildId);
            if (!resolvedTicketType) {
                const base = buildMessage('Invalid Team', 'Invalid support team specified.', 0xED4245);
                return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
            }

            try {
                const selectedType = ticketHandler.toTicketSelectValue(resolvedTicketType.name);
                await ticketHandler.showTicketReasonModal(interaction, selectedType);
            } catch (error) {
                console.error('[Event \u{1F514}] Error creating ticket:', error);
                const base = buildMessage('Ticket Error', 'There was an error creating your ticket. Please try again later.', 0xED4245);
                await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
            }
        } else if (interaction.customId.startsWith('urgent-ticket:')) {
            await ticketHandler.handleUrgentTicketConfirmation(interaction);
        } else if (interaction.customId === ticketHandler.AI_RESOLVED_BUTTON_ID) {
            const ticketChannel = interaction.channel;
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id);
            if (!ticket) {
                const base = buildMessage('Invalid Channel', 'This action is only available in an active ticket channel.', 0xED4245);
                return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
            }

            await interaction.update(buildMessage('Resolution Confirmed', 'The requester confirmed the issue is resolved. This ticket will now be closed.', 0x57F287));

            await closeRequestCommand.closeTicketWithTranscript(
                ticketChannel,
                'The requester confirmed the issue is resolved.',
                interaction.user.id
            );
        } else if (interaction.customId === ticketHandler.AI_SUPPORT_BUTTON_ID) {
            await interaction.update(buildMessage('AI Prompted Response', 'The requester indicated that support is still required. A representative will continue assisting shortly.', 0x5865F2));
        } else if (interaction.customId === tagCommand.TAG_CREATE_CONFIRM_ID || interaction.customId === tagCommand.TAG_CREATE_CANCEL_ID) {
            await tagCommand.handleButton(interaction);
        } else if (interaction.customId === closeRequestCommand.CLOSE_NOW_ID || interaction.customId === closeRequestCommand.CANCEL_ID) {
            await closeRequestCommand.handleButton(interaction);
        } else if (interaction.customId === 'close_ticket') {
            const reason = 'User-initiated ticket closure';
            await ticketHandler.handleCloseRequest(interaction, reason);
        }
    }
});

client.on('messageCreate', async message => {
    eventLog(`messageCreate in ${message.guild?.id || 'DM'} from ${message.author?.id || 'unknown'}`);
    if (!message.guild || message.author.bot) return;

    const activeStorage = ticketStore.getActiveStorage();
    const ticket = ticketStore.getTicketByChannelId(message.channel.id, activeStorage);
    if (ticket) {
        const lastActivityMs = Date.parse(ticket.lastActivityAt || '');
        const shouldPersistNow = Number.isNaN(lastActivityMs) || (Date.now() - lastActivityMs) >= 30000;
        touchTicket(ticket, message.author.id);
        if (shouldPersistNow) ticketStore.saveActiveStorage(activeStorage);
    }

    const rawContent = message.content.trim();
    if (rawContent.toLowerCase().startsWith(OWNER_COMMAND_PREFIX)) {
        const handled = await handleOwnerPrefixCommand(message, rawContent.slice(OWNER_COMMAND_PREFIX.length), activeStorage);
        if (handled) return;
    }

    const content = rawContent.toLowerCase();
    if (content !== '!ratelimited-ai' && content !== '!cancel-ai' && content !== '!enable-ai') return;

    if (message.author.id !== BOT_OWNER_ID) {
        appLog('Rejected owner-only AI command from unauthorized user.');
        await message.reply(buildMessage('Permission Denied', 'This command is restricted to the configured developer account.', 0xED4245));
        return;
    }

    const aiControl = ticketStore.getAiControl(activeStorage);

    if (content === '!ratelimited-ai') {
        const until = new Date(Date.now() + RATE_LIMIT_DURATION_MS).toISOString();
        ticketStore.setAiControl({ ...aiControl, rateLimitedUntil: until }, activeStorage);

        const readable = new Date(until).toLocaleString('en-GB', { hour12: false });
        await message.reply(buildMessage('AI Rate-Limited', `AI responses are disabled until **${readable}** (approximately 1 hour).`, 0xFEE75C));
        return;
    }

    if (content === '!cancel-ai') {
        ticketStore.setAiControl({ ...aiControl, manualDisabled: true }, activeStorage);
        await message.reply(buildMessage('AI Disabled', 'AI support agent responses are now disabled until manually re-enabled.', 0xED4245));
        return;
    }

    if (content === '!enable-ai') {
        ticketStore.setAiControl({ ...aiControl, manualDisabled: false, rateLimitedUntil: null }, activeStorage);
        await message.reply(buildMessage('AI Enabled', 'AI support agent responses are now enabled.', 0x57F287));
    }
});

loginWithRetry(client, process.env.TOKEN).catch(error => {
    console.error('[Startup] Discord client failed to start:', error);
    process.exit(1);
});



