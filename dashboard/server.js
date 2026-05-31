const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { MessageFlags, ChannelType, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { getPublicBaseUrl } = require('../utils/public-url');
const { DEFAULT_EMBED_TEMPLATES } = require('../utils/embed-config');
const ticketHandler = require('../handlers/ticket-handler');
const { getEffectiveAvailability } = ticketHandler;
const { buildV2Notice } = require('../utils/components-v2-messages');
const closeRequestCommand = require('../commands/closerequest');
const { getTranscriptRetentionDays, resolveTranscriptPath, deleteTranscriptArchive } = require('../utils/transcript-archive');

let dashboardServer = null;
const ASSETS_DIR = path.join(__dirname, 'assets');
const COPYRIGHT_NAME = 'Sync Development';
let cachedHomeCss = { mtimeMs: 0, value: '' };

const transcriptOauthStates = new Map();
const transcriptSessions = new Map();
const TRANSCRIPT_SESSION_COOKIE = 'transcript_session';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TRANSCRIPT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const dashboardOauthStates = new Map();
const dashboardSessions = new Map();
const dashboardApiRequests = [];
const DASHBOARD_SESSION_COOKIE = 'dashboard_session';
const DASHBOARD_SESSION_TTL_MS = Math.max(
    24 * 60 * 60 * 1000,
    Number(process.env.DASHBOARD_SESSION_DAYS || 30) * 24 * 60 * 60 * 1000
);
const BRAND_NAME = 'eazyDesk';
const STAFF_COMMUNITY_GUILD_ID = '1009499668734017617';
const SENIOR_STAFF_ROLE_IDS = [
    '1060974176413962350',
    '1183890711335161887',
    '1183890337106759690',
    '1060975791120326666',
    '1183890622852120636',
    '1016056762761216001',
    '1016049847767420999',
    '1060975293424222288'
];
const STAFF_ROLE_GROUPS = {
    executive: ['1060974176413962350', '1183890711335161887'],
    supportOperations: ['1183890337106759690', '1060975791120326666'],
    qualityAssurance: ['1183890622852120636', '1016056762761216001'],
    communityManagement: ['1016049847767420999', '1060975293424222288']
};

function parseRoleIdList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(roleId => roleId.trim())
        .filter(roleId => /^\d{17,20}$/.test(roleId));
}
const GUILD_CATALOG_CACHE_TTL_MS = 20 * 1000;
const guildCatalogCache = new Map();
const staffActionRateLimits = new Map();

const DEFAULT_TUTORIALS = [
    {
        id: 'posting-your-first-panel',
        title: 'Post Your First Panel',
        summary: 'Place the opener, test the button, and confirm tickets land in the right place.',
        badge: 'Getting Started',
        coverImage: '',
        steps: [
            { title: 'Choose the right channel', body: 'Pick the public channel where members should see the ticket opener.', imageUrl: '' },
            { title: 'Post the panel', body: 'Use the dashboard or `/set-panel` to publish the opener message.', imageUrl: '' },
            { title: 'Test it once', body: 'Open a test ticket and verify the category, permissions, and transcript flow.', imageUrl: '' }
        ]
    },
    {
        id: 'claiming-and-handing-off',
        title: 'Claiming And Handoffs',
        summary: 'Keep ownership clear and make staff handoffs less messy.',
        badge: 'Staff Flow',
        coverImage: '',
        steps: [
            { title: 'Claim quickly', body: 'Have support members claim tickets as soon as they start actively helping.', imageUrl: '' },
            { title: 'Use tags for repeat answers', body: 'Save time with tags for known fixes, policy reminders, or links.', imageUrl: '' },
            { title: 'Escalate when needed', body: 'Loop in high or immediate escalation roles if the request needs senior eyes.', imageUrl: '' }
        ]
    },
    {
        id: 'closing-with-transcripts',
        title: 'Closing With Transcripts',
        summary: 'Close tickets cleanly so the archive stays useful later.',
        badge: 'Operations',
        coverImage: '',
        steps: [
            { title: 'Capture the reason', body: 'Use a clear close reason so trends in the statistics view actually mean something.', imageUrl: '' },
            { title: 'Archive the history', body: 'Make sure the transcript channel is configured so every close leaves a record.', imageUrl: '' },
            { title: 'Review follow-ups', body: 'If a ticket revealed a common issue, turn it into a tag or tutorial update.', imageUrl: '' }
        ]
    },
    {
        id: 'queue-health-and-availability',
        title: 'Queue Health And Availability',
        summary: 'Use availability states to set expectations when queues spike.',
        badge: 'Queue Health',
        coverImage: '',
        steps: [
            { title: 'Watch active counts', body: 'Keep an eye on active tickets and close reasons to catch bottlenecks early.', imageUrl: '' },
            { title: 'Adjust availability', body: 'Set ticket types to increased volume or reduced assistance when staff load shifts.', imageUrl: '' },
            { title: 'Communicate the change', body: 'Use announcements or panel copy to explain what users should expect.', imageUrl: '' }
        ]
    }
];

const DEFAULT_DOC_SECTIONS = [
    {
        title: 'Getting Started',
        body: 'Use Setup to choose the ticket category, transcript channel, manager role, support teams, and first panel. After setup is complete, staff should use the dashboard modules instead of rerunning setup.'
    },
    {
        title: 'Ticket Flow',
        body: 'Members open tickets from a panel. Staff claim tickets with /claim, add notes or tags when needed, then close tickets with a clear reason so transcripts and statistics stay useful.'
    },
    {
        title: 'Transcript Links',
        body: 'Closed tickets generate transcript archives. Public transcript links use /t/<token>. Add the exact OAuth redirect URI shown by your deployment to the Discord Developer Portal when transcript OAuth is enabled.'
    },
    {
        title: 'Custom Branded Bots',
        body: 'Custom branded bots are locked to their assigned server and deploy guild commands only by default. Bot names, avatars, and profiles are managed in the Discord Developer Portal.'
    },
    {
        title: 'Minimal Permissions',
        body: 'Recommended invite permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, Manage Roles, Use Slash Commands, Create Public Threads, Send Messages in Threads, and Manage Messages only if staff tooling needs cleanup actions.'
    }
];

function createDocumentTitle(pageName = 'Home') {
    const clean = String(pageName || 'Home').trim() || 'Home';
    return `${BRAND_NAME} - ${clean}`;
}

function dashboardIcon(name) {
    const icons = {
        servers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        staff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 8v6M17 11h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        owner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.6 5.3 5.9.9-4.3 4.2 1 5.9L12 16.7 6.8 19.3l1-5.9L3.5 9.2l5.9-.9L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
        dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-10h8V3h-8v8Z" fill="currentColor"/></svg>',
        setup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
        logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 17l5-5-5-5M21 12H9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 14 21 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        invite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8M12 8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
        remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M10 11v6M14 11v6M6 6l1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        repair: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 6.3 3 3L8 19H5v-3l9.7-9.7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m12 4 2-2 4 4-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
        restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 2v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20.5 13a8.5 8.5 0 1 1-2.5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        diagnostics: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m7 15 3-3 3 2 4-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
        tickets: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 9h6M9 15h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        panels: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        transcripts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5M10 12h6M10 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10 10 20l-6-6L14 4h6v6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="17" cy="7" r="1" fill="currentColor"/></svg>',
        feedback: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
        embed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h8M8 13h4M16 15h1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        pricing: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 13h2M6 11h6M6 15h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        docs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    };
    return icons[name] || icons.dashboard;
}

function normalizeTutorials(input) {
    const list = Array.isArray(input) ? input : DEFAULT_TUTORIALS;
    return list
        .map((tutorial, index) => {
            const steps = Array.isArray(tutorial?.steps) ? tutorial.steps : [];
            return {
                id: String(tutorial?.id || `tutorial-${index + 1}`).trim() || `tutorial-${index + 1}`,
                title: String(tutorial?.title || `Tutorial ${index + 1}`).trim().slice(0, 90),
                summary: String(tutorial?.summary || '').trim().slice(0, 220),
                badge: String(tutorial?.badge || '').trim().slice(0, 40),
                coverImage: /^https?:\/\//i.test(String(tutorial?.coverImage || '').trim()) ? String(tutorial.coverImage).trim() : '',
                steps: steps.map((step, stepIndex) => ({
                    title: String(step?.title || `Step ${stepIndex + 1}`).trim().slice(0, 90),
                    body: String(step?.body || '').trim().slice(0, 2000),
                    imageUrl: /^https?:\/\//i.test(String(step?.imageUrl || '').trim()) ? String(step.imageUrl).trim() : '',
                    videoUrl: /^https?:\/\//i.test(String(step?.videoUrl || '').trim()) ? String(step.videoUrl).trim() : ''
                })).filter(step => step.title || step.body || step.imageUrl || step.videoUrl)
            };
        })
        .filter(tutorial => tutorial.title && tutorial.steps.length)
        .slice(0, 24);
}

function normalizeSiteAnnouncement(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const link = String(raw.linkUrl || '').trim();
    return {
        enabled: Boolean(raw.enabled && String(raw.text || '').trim()),
        text: String(raw.text || '').trim().slice(0, 240),
        ctaLabel: String(raw.ctaLabel || '').trim().slice(0, 40),
        linkUrl: /^https?:\/\//i.test(link) ? link : ''
    };
}

function randomToken(bytes = 24) {
    return crypto.randomBytes(Math.max(16, Number(bytes) || 24)).toString('base64url');
}

function getDashboardSessionSecret() {
    return String(
        process.env.DASHBOARD_SESSION_SECRET ||
        process.env.SESSION_SECRET ||
        process.env.COOKIE_SECRET ||
        process.env.DISCORD_OAUTH_CLIENT_SECRET ||
        process.env.DISCORD_CLIENT_SECRET ||
        process.env.OAUTH_CLIENT_SECRET ||
        process.env.TOKEN ||
        ''
    ).trim();
}

function signDashboardSessionPayload(payload) {
    const secret = getDashboardSessionSecret();
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createDashboardSessionCookieValue(entry) {
    const payload = {
        v: 1,
        userId: String(entry?.userId || '').trim(),
        csrfToken: String(entry?.csrfToken || '').trim(),
        guildIds: Array.isArray(entry?.guildIds) ? entry.guildIds.map(String) : [],
        oauthGuilds: Array.isArray(entry?.oauthGuilds) ? entry.oauthGuilds : [],
        createdAt: Number(entry?.createdAt || Date.now())
    };
    if (!/^\d{17,20}$/.test(payload.userId)) return '';

    try {
        const json = JSON.stringify(payload);
        const packed = zlib.deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url');
        const sig = signDashboardSessionPayload(packed);
        return sig ? `${packed}.${sig}` : '';
    } catch {
        return '';
    }
}

function parseDashboardSessionCookieValue(value) {
    const raw = String(value || '').trim();
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;

    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = signDashboardSessionPayload(payload);
    if (!expected) return null;

    try {
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

        const json = zlib.inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object') return null;

        const userId = String(parsed.userId || '').trim();
        if (!/^\d{17,20}$/.test(userId)) return null;

        return {
            userId,
            csrfToken: String(parsed.csrfToken || '').trim() || randomToken(18),
            guildIds: Array.isArray(parsed.guildIds) ? parsed.guildIds.map(String).filter(id => /^\d{17,20}$/.test(id)) : [],
            oauthGuilds: Array.isArray(parsed.oauthGuilds)
                ? parsed.oauthGuilds.map(g => ({
                    id: String(g?.id || '').trim(),
                    name: String(g?.name || '').trim(),
                    icon: String(g?.icon || '').trim() || null,
                    owner: Boolean(g?.owner),
                    permissions: String(g?.permissions || '0').trim() || '0'
                })).filter(g => /^\d{17,20}$/.test(g.id))
                : [],
            createdAt: Number(parsed.createdAt || 0)
        };
    } catch {
        return null;
    }
}

function getDiscordOAuthClientId() {
    return String(process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || process.env.OAUTH_CLIENT_ID || '').trim();
}

function getDiscordOAuthClientSecret() {
    return String(process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET || '').trim();
}

function hasDiscordOAuthConfigured() {
    return Boolean(getDiscordOAuthClientId() && getDiscordOAuthClientSecret());
}

function getBotInviteUrl(guildId = '') {
    const clientId = getDiscordOAuthClientId() || String(process.env.APP_ID || process.env.APPLICATION_ID || '').trim();
    if (!/^\d{17,20}$/.test(clientId)) return '';
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', 'bot applications.commands');
    url.searchParams.set('permissions', String(process.env.BOT_INVITE_PERMISSIONS || '311653682192'));
    const id = String(guildId || '').trim();
    if (/^\d{17,20}$/.test(id)) {
        url.searchParams.set('guild_id', id);
        url.searchParams.set('disable_guild_select', 'true');
    }
    return url.toString();
}

function isTranscriptOAuthRequired() {
    const raw = String(process.env.TRANSCRIPT_REQUIRE_OAUTH ?? 'true').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getBotOwnerId() {
    return String(process.env.BOT_OWNER_ID || process.env.OWNER_USER_ID || process.env.OWNER_ID || '').trim();
}

function parseCsvUserIds(raw) {
    const out = [];
    for (const part of String(raw || '').split(',')) {
        const value = String(part || '').trim();
        if (/^\d{17,20}$/.test(value)) out.push(value);
    }
    return [...new Set(out)];
}

function getDashboardAllowedUserIds() {
    return parseCsvUserIds(process.env.DASHBOARD_ALLOWED_USER_IDS || process.env.DASHBOARD_OAUTH_ALLOWED_USER_IDS || '');
}

function isDashboardOAuthRequired() {
    const raw = String(process.env.DASHBOARD_REQUIRE_OAUTH ?? 'true').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function cleanupTranscriptAuthMaps() {
    const now = Date.now();

    for (const [state, entry] of transcriptOauthStates.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > OAUTH_STATE_TTL_MS) transcriptOauthStates.delete(state);
    }

    for (const [sessionId, entry] of transcriptSessions.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > TRANSCRIPT_SESSION_TTL_MS) transcriptSessions.delete(sessionId);
    }

    for (const [state, entry] of dashboardOauthStates.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > OAUTH_STATE_TTL_MS) dashboardOauthStates.delete(state);
    }

    for (const [sessionId, entry] of dashboardSessions.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > DASHBOARD_SESSION_TTL_MS) dashboardSessions.delete(sessionId);
    }
}

setInterval(cleanupTranscriptAuthMaps, 5 * 60 * 1000).unref?.();

function getHomeCss() {
    try {
        const cssPath = path.join(ASSETS_DIR, 'styles.css');
        const stat = fs.statSync(cssPath);
        if (cachedHomeCss && cachedHomeCss.mtimeMs === stat.mtimeMs) return cachedHomeCss.value;
        const raw = fs.readFileSync(cssPath, 'utf8');
        const safe = String(raw || '').replace(/<\/style/gi, '<\\/style');
        cachedHomeCss = { mtimeMs: stat.mtimeMs, value: safe };
        return safe;
    } catch {
        return cachedHomeCss?.value || '';
    }
}

function getDashboardEnabled() {
    const configured = String(process.env.DASHBOARD_ENABLED || '').trim().toLowerCase();
    if (configured) return configured === 'true';
    return Boolean(process.env.PORT || process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
}

function getDashboardPort() {
    return Number(process.env.PORT || process.env.DASHBOARD_PORT || 3100);
}

function isDashboardPortConfigured() {
    return Boolean(String(process.env.PORT || process.env.DASHBOARD_PORT || '').trim());
}

function getDashboardHost() {
    const configured = String(process.env.DASHBOARD_HOST || '').trim();
    if (configured) return configured;

    if (process.env.PORT || process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
        return '0.0.0.0';
    }

    // Safer default: keep an unauthenticated dashboard bound to localhost.
    // If a token is configured, we allow remote access by default (0.0.0.0) unless overridden.
    return getDashboardToken() ? '0.0.0.0' : '127.0.0.1';
}

function getDashboardToken() {
    return String(process.env.DASHBOARD_TOKEN || '').trim();
}

function getDashboardOwnerToken() {
    return String(process.env.DASHBOARD_OWNER_TOKEN || '').trim();
}

function getDefaultAppealsChannelId() {
    return '';
}

function dashboardLog(message) { console.log(`[Dashboard \u{1F4E1}] ${message}`); }
function sendHtml(res, code, html) { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); } }
function sendJson(res, code, payload, headers = {}) { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(payload)); } }

function safeNextPath(value) {
    const next = String(value || '').trim();
    if (!next) return '/';
    if (next.startsWith('/t/')) return next;
    return '/';
}

function safeDashboardNextPath(value) {
    const next = String(value || '').trim();
    if (!next) return '/dashboard';
    if (!next.startsWith('/')) return '/dashboard';
    if (next.startsWith('//')) return '/dashboard';

    const basePath = next.split('?')[0].split('#')[0];
    const allowed = new Set([
        '/',
        '/dashboard',
        '/staff',
        '/owner',
        '/overview',
        '/settings',
        '/availability',
        '/tutorials',
        '/tickets',
        '/transcripts',
        '/commands/ticket-types',
        '/commands/tag',
        '/commands/feedback',
        '/statistics',
        '/embed-editor',
        '/pricing',
        '/documentation',
        '/privacy',
        '/terms',
        '/upgrade',
        '/setup',
        '/controller'
    ]);

    if (allowed.has(basePath)) return next;
    if (basePath.startsWith('/t/')) return next;
    return '/dashboard';
}

function createHomeHtml(options = {}) {
    const year = new Date().getFullYear();
    const protectedMode = Boolean(getDashboardToken());
    const botConfig = ticketStore.getBotConfig();
    const inviteUrl = getBotInviteUrl();
    const supportUrl = String(process.env.SUPPORT_SERVER_URL || process.env.DISCORD_SUPPORT_URL || 'https://discord.gg/JSUX9GQP6J').trim();
    const homeImages = Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [];
    const safeImages = homeImages
        .map(url => String(url || '').trim())
        .filter(url => /^https?:\/\//i.test(url))
        .slice(0, 6);
    const securityNote = protectedMode
        ? 'Dashboard access requires a token.'
        : 'Dashboard is running without a token (local-only by default).';
    const siteAnnouncement = normalizeSiteAnnouncement(botConfig.siteAnnouncement);
    const announcementHtml = siteAnnouncement.enabled
        ? `<section class="hero-card" style="margin-bottom:14px;padding:18px 22px"><div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:12px"><div><div class="kicker">Announcement</div><p style="margin-top:10px">${siteAnnouncement.text}</p></div>${siteAnnouncement.ctaLabel && siteAnnouncement.linkUrl ? `<a class="btn primary" href="${siteAnnouncement.linkUrl}" target="_blank" rel="noreferrer">${siteAnnouncement.ctaLabel}</a>` : ''}</div></section>`
        : '';

    const gallery = safeImages.length
        ? `<section class="gallery">
      <h2>Highlights</h2>
      <a class="shot featured-shot" href="${safeImages[0]}" target="_blank" rel="noreferrer"><img id="homeRotatingImage" src="${safeImages[0]}" alt="Preview" loading="eager" /></a>
      <div class="gallery-grid">
        ${safeImages.map((url, index) => `<button type="button" class="shot home-shot-pick${index === 0 ? ' active' : ''}" data-url="${url}"><img src="${url}" alt="Preview" loading="lazy" /></button>`).join('')}
      </div>
    </section>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${createDocumentTitle('Home')}</title>
  <link rel="icon" href="/assets/sync.png" />
  <style>${getHomeCss()}</style>
</head>
<body class="home">
  <div class="bg">
    <div class="orb o1"></div>
    <div class="orb o2"></div>
    <div class="orb o3"></div>
    <div class="grid"></div>
  </div>

  <header class="top">
    <div class="brand">
      <img src="/assets/sync.png" alt="eazyDesk" />
      <div class="brand-text">
        <div class="brand-title">eazyDesk</div>
        <div class="brand-sub">Support your customers with ease.</div>
      </div>
    </div>
    <nav class="nav">
      ${inviteUrl ? `<a class="nav-link" href="${inviteUrl}" target="_blank" rel="noreferrer">Invite Bot</a>` : ''}
      <a class="nav-link" href="${supportUrl}" target="_blank" rel="noreferrer">Support</a>
      <a class="nav-link" href="/pricing">Plans</a>
      <a class="nav-link" href="/documentation">Documentation</a>
      <a class="nav-link" href="/privacy">Privacy</a>
      <a class="nav-link" href="/terms">Terms</a>
      <a class="nav-link" href="/dashboard">Dashboard</a>
    </nav>
  </header>

  <main class="hero">
    ${announcementHtml}
    <section class="hero-card">
      <div class="kicker">Support &bull; Tickets &bull; Automations</div>
      <h1>Run support like a <span class="accent">pro.</span></h1>
      <p>
        Manage all the things for your bot with our new and improved sleek dashboard, no more bulky commands or confusing setups. Get it all in one place, and back doing what you do best.
      </p>
      <div class="cta">
        <a class="btn primary" href="/dashboard">Visit your Dashboard</a>
        ${inviteUrl ? `<a class="btn ghost" href="${inviteUrl}" target="_blank" rel="noreferrer">Invite the Bot</a>` : ''}
        <a class="btn ghost" href="/documentation">Documentation</a>
      </div>
      <div class="quick-access" aria-label="Quick access">
        ${inviteUrl ? `<a class="quick-card" href="${inviteUrl}" target="_blank" rel="noreferrer"><span>Invite</span><strong>Add eazyDesk to a server</strong></a>` : ''}
        <a class="quick-card" href="${supportUrl}" target="_blank" rel="noreferrer"><span>Support</span><strong>Join our support server</strong></a>
        <a class="quick-card" href="/pricing"><span>Plans</span><strong>Upgrade plans</strong></a>
      </div>
      <div class="note">
        <span class="pill">${securityNote}</span>
      </div>
    </section>

    <section class="feature-grid">
      <div class="feature">
        <div class="feature-title">Simple UI</div>
        <div class="feature-desc">Enjoy our pristine, modern UI with various themes to suit you. Access tickets and manage them without the hassle.</div>
      </div>
      <div class="feature">
        <div class="feature-title">Safer by default</div>
        <div class="feature-desc">Our tickets bot continually adds security updates to ensure the protection of your server's data.</div>
      </div>
      <div class="feature">
        <div class="feature-title">Free AI Support Agents</div>
        <div class="feature-desc">Quickly respond to tickets and engage with your customers, even if nobody's online.</div>
      </div>
    </section>

    ${gallery}
  </main>

  <footer class="footer">
      <div class="footer-inner">
        <div class="muted">&copy; ${year} ${COPYRIGHT_NAME}</div>
        <div class="muted">eazyDesk, a product under Sync Development - <a href="/privacy">Privacy</a> - <a href="/terms">Terms</a></div>
      </div>
  </footer>
  <script>
    (function(){
      try{
        var key='dash_theme';
        var value=(localStorage.getItem(key)||'dark').toLowerCase();
        var allowed=['dark','light','ocean','sunset','diamond','hacker'];
        document.body.dataset.theme=allowed.includes(value)?value:'dark';
      }catch(e){
        document.body.dataset.theme='dark';
      }
    })();
    (function(){
      var urls=${JSON.stringify(safeImages)};
      var img=document.getElementById('homeRotatingImage');
      var picks=Array.prototype.slice.call(document.querySelectorAll('.home-shot-pick'));
      if(!img||!urls.length)return;
      var idx=0;
      function show(next){
        idx=(next+urls.length)%urls.length;
        img.src=urls[idx];
        if(img.parentElement) img.parentElement.href=urls[idx];
        picks.forEach(function(btn,i){btn.classList.toggle('active',i===idx)});
      }
      picks.forEach(function(btn,i){btn.onclick=function(){show(i)}});
      if(urls.length>1)setInterval(function(){show(idx+1)},5000);
    })();
  </script>
</body>
</html>`;
}

function baseDashboardPage({ title, body, script = '', ownerView = false, staffView = false, showStaffLink = false }) {
    const siteAnnouncement = normalizeSiteAnnouncement(ticketStore.getBotConfig()?.siteAnnouncement);
    const announcementHtml = siteAnnouncement.enabled
        ? `<div class="wrap" style="padding-top:14px;padding-bottom:0"><div class="card" style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px"><div><strong>Announcement</strong><div class="muted">${siteAnnouncement.text}</div></div>${siteAnnouncement.ctaLabel && siteAnnouncement.linkUrl ? `<a class="btn primary" href="${siteAnnouncement.linkUrl}" target="_blank" rel="noreferrer">${siteAnnouncement.ctaLabel}</a>` : ''}</div></div>`
        : '';
    const css = `
    :root{color-scheme:dark;--bg:#0b1020;--bg2:#090d1a;--panel:rgba(17,20,36,.78);--tx:#f7f8ff;--mut:rgba(247,248,255,.66);--bd:rgba(255,255,255,.10);--acc:#38bdf8;--acc2:#60a5fa;--shadow:0 18px 50px rgba(0,0,0,.55);--cardGlow:0 0 0 1px rgba(96,165,250,.12) inset,0 20px 50px rgba(8,15,35,.45);--cardOutline:rgba(96,165,250,.24)}
    *{box-sizing:border-box}html,body{font-family:"Inter","Readex Pro","Segoe UI",system-ui,-apple-system,sans-serif}body{margin:0;background:radial-gradient(700px 380px at 20% 10%,rgba(56,189,248,.18),transparent 55%),radial-gradient(650px 360px at 78% 20%,rgba(37,99,235,.16),transparent 60%),linear-gradient(180deg,var(--bg),var(--bg2));color:var(--tx);font:14px/1.45 "Inter","Readex Pro","Segoe UI",system-ui,-apple-system,sans-serif}
    body[data-theme="light"]{--bg:#f7f0e4;--bg2:#f3e6d0;--panel:rgba(255,250,243,.82);--tx:#111827;--mut:rgba(17,24,39,.66);--bd:rgba(17,24,39,.12);--acc:#2563eb;--acc2:#38bdf8;--shadow:0 16px 40px rgba(17,24,39,.12);--cardGlow:0 0 0 1px rgba(37,99,235,.10) inset,0 18px 38px rgba(17,24,39,.12);--cardOutline:rgba(37,99,235,.22);background:radial-gradient(700px 380px at 20% 10%,rgba(56,189,248,.14),transparent 55%),radial-gradient(650px 360px at 78% 20%,rgba(37,99,235,.12),transparent 60%),linear-gradient(180deg,var(--bg),var(--bg2))}
    body[data-theme="ocean"]{--bg:#061421;--bg2:#071b2c;--panel:rgba(10,29,44,.80);--tx:#ecfeff;--mut:rgba(236,254,255,.68);--bd:rgba(125,211,252,.14);--acc:#22d3ee;--acc2:#14b8a6;--shadow:0 18px 44px rgba(3,10,22,.52);--cardGlow:0 0 0 1px rgba(34,211,238,.14) inset,0 22px 56px rgba(4,16,28,.50);--cardOutline:rgba(34,211,238,.28);background:radial-gradient(760px 420px at 16% 12%,rgba(34,211,238,.18),transparent 58%),radial-gradient(680px 360px at 82% 18%,rgba(20,184,166,.15),transparent 62%),linear-gradient(180deg,var(--bg),var(--bg2))}
    body[data-theme="sunset"]{--bg:#1b1020;--bg2:#2a1422;--panel:rgba(43,19,31,.78);--tx:#fff7ed;--mut:rgba(255,247,237,.72);--bd:rgba(251,146,60,.16);--acc:#fb7185;--acc2:#fb923c;--shadow:0 18px 48px rgba(30,10,20,.52);--cardGlow:0 0 0 1px rgba(251,146,60,.14) inset,0 22px 54px rgba(31,10,18,.52);--cardOutline:rgba(251,146,60,.28);background:radial-gradient(720px 400px at 18% 10%,rgba(251,113,133,.18),transparent 58%),radial-gradient(650px 340px at 82% 18%,rgba(251,146,60,.15),transparent 62%),linear-gradient(180deg,var(--bg),var(--bg2))}
    body[data-theme="hacker"]{--bg:#020607;--bg2:#010b07;--panel:rgba(0,12,7,.84);--tx:#d7ffe9;--mut:rgba(215,255,233,.72);--bd:rgba(0,255,136,.18);--acc:#00ff88;--acc2:#00e5ff;--shadow:0 18px 48px rgba(0,0,0,.62);--cardGlow:0 0 0 1px rgba(0,255,136,.14) inset,0 22px 54px rgba(0,0,0,.58);--cardOutline:rgba(0,255,136,.28);background:radial-gradient(720px 400px at 18% 10%,rgba(0,255,136,.16),transparent 58%),radial-gradient(650px 340px at 82% 18%,rgba(0,229,255,.12),transparent 62%),linear-gradient(180deg,var(--bg),var(--bg2));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    a{color:inherit}
    .wrap{max-width:1050px;margin:0 auto;padding:18px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--bd);backdrop-filter:blur(8px);position:sticky;top:0;background:rgba(8,10,20,.64);z-index:10}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none}
    .brand img{width:28px;height:28px}
    .title{font-size:18px;font-weight:800;letter-spacing:.2px}
    .nav{display:flex;gap:10px;flex-wrap:wrap}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;border-radius:14px;border:1px solid var(--bd);background:rgba(255,255,255,.03);text-decoration:none;cursor:pointer;transition:transform .15s ease,border-color .2s ease,background .2s ease,box-shadow .2s ease;box-shadow:0 10px 24px rgba(0,0,0,.18),0 0 0 1px rgba(255,255,255,.02) inset;font-weight:700}
    .btn:hover{transform:translateY(-1px);border-color:var(--cardOutline);background:color-mix(in srgb,var(--acc) 12%, transparent);box-shadow:0 14px 28px rgba(0,0,0,.20),0 0 18px color-mix(in srgb,var(--acc) 24%, transparent)}
    .btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 22%, transparent),color-mix(in srgb,var(--acc2) 12%, transparent));border-color:var(--cardOutline)}
    .btn.nav-accent{background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 28%, transparent),color-mix(in srgb,var(--acc2) 18%, transparent));border-color:color-mix(in srgb,var(--acc) 40%, white 6%);box-shadow:0 14px 30px rgba(0,0,0,.22),0 0 24px color-mix(in srgb,var(--acc) 24%, transparent)}
    .btn-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;opacity:.95}
    .btn-icon svg{width:18px;height:18px;display:block}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    @media(max-width:860px){.grid{grid-template-columns:1fr}.nav{justify-content:flex-end}}
    .card{border:1px solid var(--bd);background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 95%, rgba(255,255,255,.02)),color-mix(in srgb,var(--panel) 85%, rgba(0,0,0,.10)));box-shadow:var(--cardGlow);border-radius:18px;padding:14px}
    .muted{color:var(--mut)}
    label{display:block;margin:10px 0 6px;color:rgba(247,248,255,.75);font-size:12px}
    select,input{width:100%;padding:10px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(5,8,20,.78);color:var(--tx)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .list{margin-top:12px;display:grid;gap:10px}
    .server-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
    .server-card{min-height:220px;align-items:stretch}
    .server-card > .row:last-child{align-self:flex-end}
    @media(max-width:1100px){.server-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:700px){.server-grid{grid-template-columns:1fr}.server-card{min-height:auto}}
    .item{border:1px solid rgba(255,255,255,.10);background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.03));border-radius:18px;padding:14px;display:flex;justify-content:space-between;gap:12px;align-items:center;box-shadow:0 0 0 1px rgba(255,255,255,.02) inset,0 0 24px color-mix(in srgb,var(--acc) 8%, transparent)}
    .item.can-manage{border-color:var(--cardOutline);box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 10%, transparent) inset,0 0 26px color-mix(in srgb,var(--acc) 16%, transparent)}
    .item strong{font-size:14px}
    .pill{padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--acc) 35%, transparent);background:color-mix(in srgb,var(--acc) 12%, transparent);color:var(--tx);font-size:12px;box-shadow:0 0 16px color-mix(in srgb,var(--acc) 12%, transparent)}
    body[data-view="staff"] .wrap{max-width:1280px}
    body[data-view="staff"] .server-grid{grid-template-columns:1fr}
    body[data-view="staff"] .server-card{display:grid;grid-template-columns:minmax(0,1fr);min-height:auto;align-items:start}
    body[data-view="staff"] .server-card > .row:last-child{align-self:start;justify-content:flex-start}
    body[data-view="staff"] .server-card .grid{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))!important}
    body[data-view="staff"] .item,body[data-view="staff"] .card,body[data-view="staff"] .muted,body[data-view="staff"] strong,body[data-view="staff"] a{min-width:0;overflow-wrap:anywhere;word-break:break-word}
    body[data-view="staff"] .pill{white-space:normal;overflow-wrap:anywhere;line-height:1.25}
    body[data-view="staff"] .btn{max-width:100%;white-space:normal;text-align:center;line-height:1.2;min-height:42px}
    body[data-view="staff"] .btn span:not(.btn-icon){min-width:0;overflow-wrap:anywhere}
    .theme-nav{position:relative}
    .theme-secret{display:none!important}
    body[data-hacker-unlocked="true"] .theme-secret{display:block!important}
    .theme-menu{position:absolute;right:0;top:calc(100% + 8px);display:none;min-width:180px;padding:8px;border-radius:16px;border:1px solid var(--bd);background:var(--panel);box-shadow:var(--cardGlow)}
    .theme-nav.open .theme-menu{display:grid;gap:6px}
    .theme-item{appearance:none;border:1px solid transparent;background:rgba(255,255,255,.03);color:var(--tx);padding:9px 10px;border-radius:12px;text-align:left;cursor:pointer}
    .theme-item:hover,.theme-item.active{border-color:var(--cardOutline);background:color-mix(in srgb,var(--acc) 12%, transparent)}
    .pricing-page{display:grid;gap:34px;padding-top:12px;padding-bottom:44px}
    .pricing-hero{padding:44px 38px;display:grid;gap:18px}
    .pricing-hero h1{font-size:clamp(34px,5vw,58px);line-height:1;margin:0 0 14px;letter-spacing:0}
    .pricing-kicker{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:var(--acc);margin-bottom:12px}
    .pricing-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;align-items:center}
    .pricing-card{padding:26px;border-radius:18px;border:1px solid var(--bd);background:rgba(255,255,255,.035);display:grid;gap:18px;min-height:420px}
    .pricing-card.featured{border-color:color-mix(in srgb,var(--acc) 58%, transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 22%, transparent),0 0 40px color-mix(in srgb,var(--acc) 16%, transparent);transform:scale(1.035);background:color-mix(in srgb,var(--acc) 8%, rgba(255,255,255,.035))}
    .plan-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    .plan-name{font-size:22px;font-weight:850}
    .plan-price{font-size:38px;font-weight:900;line-height:1}
    .plan-note{color:var(--mut);font-size:13px;line-height:1.6}
    .plan-badge{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--acc) 38%, transparent);background:color-mix(in srgb,var(--acc) 13%, transparent);font-size:11px;font-weight:850;color:var(--tx)}
    .pricing-feature-list{display:grid;gap:9px}
    .pricing-feature{display:flex;gap:10px;align-items:center;color:var(--tx)}
    .pricing-feature .dot{width:8px;height:8px;border-radius:999px;background:var(--acc);box-shadow:0 0 14px color-mix(in srgb,var(--acc) 50%, transparent);flex:0 0 auto}
    .pricing-preview{border:1px solid var(--bd);border-radius:18px;background:rgba(255,255,255,.025);padding:22px}
    .pricing-preview-title{font-size:12px;font-weight:850;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:14px}
    .preview-frame{border:1px solid rgba(255,255,255,.09);border-radius:16px;background:#080c18;overflow:hidden}
    .preview-bar{height:38px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:8px;padding:0 14px;color:var(--mut);font-size:12px}
    .preview-dot{width:9px;height:9px;border-radius:999px;background:var(--acc)}
    .preview-body{padding:18px;display:grid;gap:12px}
    .preview-row{height:12px;border-radius:999px;background:rgba(255,255,255,.08)}
    .preview-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:6px}
    .preview-mini{min-height:90px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.045);padding:12px}
    .pricing-table{overflow-x:auto;padding:24px}
    .pricing-table table{width:100%;border-collapse:collapse;min-width:680px}
    .pricing-table th,.pricing-table td{padding:15px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,.08)}
    .pricing-table td{color:var(--mut)}
    .pricing-table td.active{color:var(--tx);font-weight:800}
    .pricing-faq{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .pricing-faq .faq-item{padding:20px;border-radius:18px;border:1px solid var(--bd);background:rgba(255,255,255,.03)}
    .pricing-cta{text-align:center;padding:36px 28px}
    .controller-shell{display:grid;gap:16px}
    .controller-hero{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:20px}
    .controller-hero h2{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
    .controller-grid{display:grid;gap:14px}
    .controller-card{display:grid;gap:14px;align-items:start}
    .controller-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
    .controller-title{display:flex;align-items:center;gap:12px;min-width:0}
    .controller-icon{width:44px;height:44px;border-radius:14px;border:1px solid var(--bd);background:color-mix(in srgb,var(--acc) 13%, transparent);display:inline-flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 22px color-mix(in srgb,var(--acc) 14%, transparent)}
    .controller-icon img{width:100%;height:100%;object-fit:cover}
    .controller-icon svg{width:22px;height:22px}
    .controller-name{font-size:16px;font-weight:850;line-height:1.15}
    .controller-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .controller-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .controller-actions .btn{min-height:40px;padding:9px 11px;border-radius:12px}
    .btn.subtle{background:color-mix(in srgb,var(--panel) 80%, rgba(255,255,255,.03));border-color:var(--bd)}
    .btn.warning{background:color-mix(in srgb,#fee75c 14%, transparent);border-color:rgba(254,231,92,.32)}
    .custom-bot-strip{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px;border-radius:14px;border:1px solid color-mix(in srgb,var(--acc) 26%, transparent);background:color-mix(in srgb,var(--acc) 8%, transparent)}
    .owner-console{display:grid;gap:14px;min-width:0;overflow:hidden}
    .owner-console .owner-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;min-width:0}
    .owner-console .owner-guilds{display:grid;grid-template-columns:1fr;gap:12px;min-width:0}
    .owner-console .server-card{display:block;min-height:0;width:100%;overflow:hidden}
    .owner-console .server-card .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .owner-console .server-card .grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
    .owner-console .btn,.owner-console .btn-soft,.owner-console .btn-danger{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .owner-console input{min-width:0}
    .empty-state{padding:22px;text-align:center}
    .upgrade-reward{position:relative;overflow:hidden;min-height:70vh;display:grid;place-items:center;text-align:center;padding:56px 28px}
    .upgrade-word{position:absolute;color:color-mix(in srgb,var(--acc) 70%, white);opacity:.16;font-weight:900;font-size:clamp(24px,5vw,72px);animation:floatReward 7s ease-in-out infinite}
    .upgrade-word.w1{left:6%;top:12%}.upgrade-word.w2{right:8%;top:20%;animation-delay:1s}.upgrade-word.w3{left:18%;bottom:12%;animation-delay:2s}.upgrade-word.w4{right:15%;bottom:18%;animation-delay:3s}
    .party-emoji{position:absolute;font-size:28px;animation:partyFly 4.8s linear infinite;opacity:.85}
    .party-emoji.e1{left:8%;bottom:-40px}.party-emoji.e2{left:30%;bottom:-60px;animation-delay:1s}.party-emoji.e3{left:60%;bottom:-50px;animation-delay:1.8s}.party-emoji.e4{left:82%;bottom:-70px;animation-delay:.4s}
    @keyframes floatReward{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-18px) rotate(2deg)}}
    @keyframes partyFly{0%{transform:translateY(0) rotate(0deg);opacity:0}12%{opacity:.9}100%{transform:translateY(-78vh) rotate(320deg);opacity:0}}
    @media(max-width:900px){.pricing-grid,.pricing-faq{grid-template-columns:1fr}.pricing-card.featured{transform:none}.preview-cards{grid-template-columns:1fr}.pricing-table table{min-width:0}}
    .err{color:#fecaca;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.10);padding:10px 12px;border-radius:14px}
    `;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${createDocumentTitle(title || 'Dashboard')}</title>
  <link rel="icon" href="/assets/sync.png" />
  <style>${css}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><img src="/assets/sync.png" alt="logo" /><div class="title">${String(title || 'Dashboard')}</div></a>
    <nav class="nav">
      <a class="btn nav-accent" href="/dashboard"><span class="btn-icon">${dashboardIcon('servers')}</span><span>Servers</span></a>
      ${showStaffLink ? `<a class="btn" href="/staff"><span class="btn-icon">${dashboardIcon('staff')}</span><span>Staff</span></a>` : ''}
      ${ownerView ? `<a class="btn" href="/owner"><span class="btn-icon">${dashboardIcon('owner')}</span><span>Owner</span></a>` : ''}
      ${ownerView ? `<a class="btn" href="/overview"><span class="btn-icon">${dashboardIcon('dashboard')}</span><span>Dashboard</span></a>` : ''}
      ${ownerView ? `<a class="btn" href="/setup"><span class="btn-icon">${dashboardIcon('setup')}</span><span>Setup</span></a>` : ''}
      <div id="themeNav" class="theme-nav">
        <button id="themeBtn" class="btn" type="button"><span class="btn-icon">${dashboardIcon('diagnostics')}</span><span>Theme</span></button>
        <div class="theme-menu">
          <button class="theme-item" type="button" data-theme-item="dark">Dark</button>
          <button class="theme-item" type="button" data-theme-item="light">Light</button>
          <button class="theme-item" type="button" data-theme-item="ocean">Ocean</button>
          <button class="theme-item" type="button" data-theme-item="sunset">Sunset</button>
          <button class="theme-item theme-secret" type="button" data-theme-item="hacker">Hacker</button>
        </div>
      </div>
      <a class="btn" href="/logout"><span class="btn-icon">${dashboardIcon('logout')}</span><span>Logout</span></a>
    </nav>
  </header>
  ${announcementHtml}
  <main class="wrap">${body || ''}</main>
  <script>
    (function(){
      const key='dash_theme';
      const unlockKey='dash_hacker_unlocked';
      const unlocked=()=>{try{return localStorage.getItem(unlockKey)==='true'}catch{return false}};
      const allowed=['dark','light','ocean','sunset','hacker'];
      const normalise=v=>{const next=String(v||'').toLowerCase();return allowed.includes(next)&&!(next==='hacker'&&!unlocked())?next:'dark'};
      const apply=v=>{document.body.dataset.theme=normalise(v);document.body.dataset.hackerUnlocked=unlocked()?'true':'false';document.querySelectorAll('[data-theme-item]').forEach(btn=>btn.classList.toggle('active',btn.getAttribute('data-theme-item')===document.body.dataset.theme));};
      try{apply(localStorage.getItem(key)||'dark')}catch{apply('dark')}
      const nav=document.getElementById('themeNav');
      const btn=document.getElementById('themeBtn');
      if(btn&&nav){btn.onclick=(e)=>{e.stopPropagation();nav.classList.toggle('open')};document.addEventListener('click',()=>nav.classList.remove('open'))}
      let darkClicks=0;
      document.querySelectorAll('[data-theme-item]').forEach(item=>item.onclick=(e)=>{e.stopPropagation();const pick=String(item.getAttribute('data-theme-item')||'');if(pick==='dark'){darkClicks+=1;if(darkClicks>=7){try{localStorage.setItem(unlockKey,'true')}catch{}}}else{darkClicks=0}const next=normalise(pick);try{localStorage.setItem(key,next)}catch{}apply(next);if(nav)nav.classList.remove('open')});
    })();
  </script>
  <script>document.body.dataset.view=${JSON.stringify(staffView ? 'staff' : (ownerView ? 'owner' : 'default'))};</script>
  <script>${script || ''}</script>
</body>
</html>`;
}

function createControllerHtml(req = null) {
    const body = `
      <div class="controller-shell">
      <div class="card controller-hero">
        <div>
          <div class="pricing-kicker">Controller</div>
          <h2>Server operations</h2>
          <div class="muted">Open dashboards, jump into setup, manage ticket queues, and toggle custom branded bots from one clean control surface.</div>
        </div>
        <div class="controller-actions">
          <a class="btn primary" href="/dashboard"><span class="btn-icon">${dashboardIcon('servers')}</span><span>Servers</span></a>
          <a class="btn subtle" href="/owner"><span class="btn-icon">${dashboardIcon('owner')}</span><span>Owner Console</span></a>
        </div>
      </div>
        <div id="ctrlError" class="err" style="display:none;margin-top:12px"></div>
        <div id="guildList" class="controller-grid"></div>
      </div>
    `;

    const script = `
      const list=document.getElementById('guildList');
      const err=document.getElementById('ctrlError');
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      const csrfToken=${JSON.stringify(getDashboardSessionCsrfToken(req) || '')};
      async function api(path,opt){const headers={...(opt&&opt.headers||{})};if(csrfToken&&String((opt&&opt.method)||'GET').toUpperCase()!=='GET')headers['x-csrf-token']=csrfToken;const r=await fetch(path,{credentials:'include',...(opt||{}),headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      const icons={open:${JSON.stringify(dashboardIcon('open'))},setup:${JSON.stringify(dashboardIcon('setup'))},tickets:${JSON.stringify(dashboardIcon('tickets'))},owner:${JSON.stringify(dashboardIcon('owner'))},restart:${JSON.stringify(dashboardIcon('restart'))},bot:${JSON.stringify(dashboardIcon('embed'))}};
      function iconMarkup(g){return g.iconURL?'<span class=\"controller-icon\"><img src=\"'+esc(g.iconURL)+'\" alt=\"\" /></span>':'<span class=\"controller-icon\">'+icons.bot+'</span>'}
      function customBotBlock(g){const ai=g.aiAccess||{};const bot=ai.customBot||{};if(!ai.isCustom&&!bot.tokenConfigured)return '';const on=!!bot.enabled&&!!bot.tokenConfigured;const status=bot.runtimeStatus||(on?'starting':'paused');const sync=bot.lastCommandSyncAt?(' - '+esc(bot.lastCommandSyncCount||0)+' command(s) synced'):'';return '<div class=\"custom-bot-strip\"><div><strong>Custom branded bot</strong><div class=\"muted\">'+(bot.tokenConfigured?'Token saved':'No token saved')+sync+(bot.lastError?' - '+esc(bot.lastError):'')+'</div></div><div class=\"controller-actions\"><span class=\"pill\">'+esc(status)+'</span><button class=\"btn '+(on?'warning':'primary')+'\" '+(!bot.tokenConfigured?'disabled':'')+' data-custom-bot-toggle=\"'+esc(g.id)+'\" data-next=\"'+(on?'false':'true')+'\"><span class=\"btn-icon\">'+icons.bot+'</span><span>'+(on?'Turn Off':'Turn On')+'</span></button><button class=\"btn subtle\" '+(!bot.tokenConfigured?'disabled':'')+' data-custom-bot-sync=\"'+esc(g.id)+'\"><span>Sync Commands</span></button></div></div>'}
      function item(g){const status=g.setupCompleted?'<span class=\"pill\">Setup complete</span>':'<span class=\"pill\">Setup step '+esc(g.setupStep||1)+'</span>';const plan=(g.aiAccess&&g.aiAccess.statusLabel)||'Free plan';return '<div class=\"card controller-card\">'+
        '<div class=\"controller-head\"><div class=\"controller-title\">'+iconMarkup(g)+'<div><div class=\"controller-name\">'+esc(g.name)+'</div><div class=\"muted\">'+esc(g.id)+'</div></div></div><div class=\"controller-meta\">'+(g.memberCount?('<span class=\"pill\">'+esc(g.memberCount)+' members</span>'):'')+status+'<span class=\"pill\">'+esc(plan)+'</span></div></div>'+customBotBlock(g)+
        '<div class=\"controller-actions\">'+
          '<a class=\"btn primary\" href=\"/overview?guild='+encodeURIComponent(g.id)+'\"><span class=\"btn-icon\">'+icons.open+'</span><span>Dashboard</span></a>'+
          '<a class=\"btn subtle\" href=\"/setup?guild='+encodeURIComponent(g.id)+'&page=1\"><span class=\"btn-icon\">'+icons.setup+'</span><span>Setup</span></a>'+
          '<a class=\"btn subtle\" href=\"/tickets?guild='+encodeURIComponent(g.id)+'\"><span class=\"btn-icon\">'+icons.tickets+'</span><span>Tickets</span></a>'+
          '<a class=\"btn subtle\" href=\"/owner\"><span class=\"btn-icon\">'+icons.owner+'</span><span>Plans</span></a>'+
          '<button class=\"btn warning\" data-restart=\"'+esc(g.id)+'\"><span class=\"btn-icon\">'+icons.restart+'</span><span>Restart Setup</span></button>'+
   '</div>'}
      async function load(){try{const data=await api('/api/controller/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];list.innerHTML=guilds.length?guilds.map(item).join(''):'<div class=\"card empty-state\"><strong>No guilds found</strong><div class=\"muted\">Bot may not be ready yet.</div></div>';for(const btn of document.querySelectorAll('[data-custom-bot-toggle]')){btn.onclick=async()=>{try{btn.disabled=true;await api('/api/owner/guild-ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:btn.getAttribute('data-custom-bot-toggle'),action:'custom-bot-toggle',enabled:btn.getAttribute('data-next')==='true'})});await load()}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=false}}}for(const btn of document.querySelectorAll('[data-custom-bot-sync]')){btn.onclick=async()=>{try{btn.disabled=true;await api('/api/owner/guild-ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:btn.getAttribute('data-custom-bot-sync'),action:'custom-bot-sync'})});await load()}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=false}}}for(const btn of document.querySelectorAll('[data-restart]')){btn.onclick=async()=>{try{btn.disabled=true;const original=btn.innerHTML;await api('/api/controller/setup/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:btn.getAttribute('data-restart')})});btn.innerHTML='<span>Restarted</span>';setTimeout(()=>{btn.innerHTML=original;btn.disabled=false},1200)}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=false}}}}catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;

    return baseDashboardPage({ title: 'Controller', body, script, ownerView: true, showStaffLink: true });
}

function createServerPickerHtml(options = {}) {
    const ownerView = Boolean(options.ownerView);
    const showStaffLink = Boolean(options.showStaffLink);
    const req = options.req || null;
    const body = `
      <div class="card">
        <h2 style="margin:0 0 6px">Server Access</h2>
        <div class="muted">This shows the servers your Discord account is in, whether the bot is in them too, and what elevated permissions you have in each server.</div>
        <div id="guildError" class="err" style="display:none;margin-top:12px"></div>
        <div id="guildList" class="list server-grid"></div>
      </div>
    `;

    const script = `
      const ownerView=${JSON.stringify(ownerView)};
      const list=document.getElementById('guildList');
      const err=document.getElementById('guildError');
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      const csrfToken=${JSON.stringify(getDashboardSessionCsrfToken(req) || '')};
      async function api(path,opt){const headers={...(opt&&opt.headers||{})};if(csrfToken&&String((opt&&opt.method)||'GET').toUpperCase()!=='GET')headers['x-csrf-token']=csrfToken;const r=await fetch(path,{credentials:'include',...(opt||{}),headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function renderPerms(g){const tags=[];tags.push(g.botInServer?'<span class="pill">Bot in server</span>':'<span class="pill">Bot not in server</span>');tags.push(g.isOwner?'<span class="pill">Owner</span>':'');tags.push(g.isAdmin?'<span class="pill">Administrator</span>':'');tags.push(!g.isAdmin&&g.canManageGuild?'<span class="pill">Manage Server</span>':'');tags.push(!g.isAdmin&&!g.canManageGuild&&g.canManageChannels?'<span class="pill">Manage Channels</span>':'');return tags.filter(Boolean).join('')}
      function renderAction(g){if(g.botInServer&&g.canAccessDashboard)return '<a class="btn primary" href="/overview?guild='+encodeURIComponent(g.id)+'">Open Dashboard</a><a class="btn" href="/setup?guild='+encodeURIComponent(g.id)+'&page=1">Setup</a>';if(g.botInServer)return '<span class="muted">No dashboard permissions</span>';if(g.inviteUrl)return '<a class="btn primary" href="'+esc(g.inviteUrl)+'">Add Bot</a>';return '<span class="muted">Bot is not in this server</span>'}
      function item(g){const icon=g.iconURL?'<img src="'+esc(g.iconURL)+'" style="width:42px;height:42px;border-radius:14px;box-shadow:0 0 22px rgba(0,0,0,.22)" />':'';const detail=Array.isArray(g.permissionSummary)&&g.permissionSummary.length?g.permissionSummary.map(esc).join(' - '):'No elevated permissions';const cls='item server-card'+(g.canAccessDashboard?' can-manage':'');return '<div class="'+cls+'">'+
        '<div style="display:grid;gap:8px;min-width:0">'+
          '<div class="row" style="gap:10px">'+icon+'<div><strong>'+esc(g.name)+'</strong><div class="muted">'+esc(g.id)+'</div></div>'+(g.memberCount?('<span class="pill">'+esc(g.memberCount)+' members</span>'):'')+'</div>'+
          '<div class="row">'+renderPerms(g)+'</div>'+
          '<div class="muted">'+detail+'</div>'+
        '</div>'+
        '<div class="row">'+renderAction(g)+'</div>'+
      '</div>'}
      async function load(){try{const data=await api('/api/dashboard/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];list.innerHTML=guilds.length?guilds.map(item).join(''):'<div class="muted">No servers found for this account.</div>'}catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;

    return baseDashboardPage({ title: 'Servers', body, script, ownerView, showStaffLink });
}

function createStaffHtml(options = {}) {
    const ownerView = Boolean(options.ownerView);
    const req = options.req || null;
    const body = `
      <div class="card">
        <h2 style="margin:0 0 6px">Staff Operations</h2>
        <div class="muted">Senior staff can inspect guild health, run safe repairs, create handoff invites, and take restricted operational actions with audit logging and rate limits.</div>
        <div id="staffError" class="err" style="display:none;margin-top:12px"></div>
        <div id="staffSuccess" class="card" style="display:none;margin-top:12px;padding:12px 14px"></div>
        <div id="staffSummary" class="grid" style="margin-top:12px"></div>
        <div id="staffList" class="list server-grid"></div>
      </div>
    `;

    const script = `
      const ownerView=${JSON.stringify(ownerView)};
      const list=document.getElementById('staffList');
      const err=document.getElementById('staffError');
      const ok=document.getElementById('staffSuccess');
      const summary=document.getElementById('staffSummary');
      const inviteMap={};
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      const csrfToken=${JSON.stringify(getDashboardSessionCsrfToken(req) || '')};
      async function api(path,opt){const headers={...(opt&&opt.headers||{})};if(csrfToken&&String((opt&&opt.method)||'GET').toUpperCase()!=='GET')headers['x-csrf-token']=csrfToken;const r=await fetch(path,{credentials:'include',...(opt||{}),headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function note(message){if(!ok)return;ok.style.display='block';ok.innerHTML='<strong>Done</strong><div class="muted" style="margin-top:4px">'+esc(message)+'</div>'}
      function pill(text){return '<span class="pill">'+esc(text)+'</span>'}
      function renderPermissionMatrix(matrix){const keys=['canViewConfiguration','canRunDiagnostics','canViewTranscripts','canCreateInvite','canRemoveBot'];return '<div class="card" style="grid-column:1/-1"><strong>Staff role permissions</strong><div class="muted" style="margin-top:6px">Each role family maps to specific operational actions.</div><div style="overflow:auto;margin-top:12px"><table style="width:100%;border-collapse:collapse;min-width:720px"><thead><tr><th style="text-align:left;padding:10px">Role family</th>'+keys.map(k=>'<th style="text-align:left;padding:10px">'+esc(k.replace(/^can/,''))+'</th>').join('')+'</tr></thead><tbody>'+((matrix||[]).map(row=>'<tr><td style="padding:10px;border-top:1px solid rgba(255,255,255,.08)"><strong>'+esc(row.name)+'</strong><div class="muted">'+esc((row.roleIds||[]).join(', '))+'</div></td>'+keys.map(k=>'<td style="padding:10px;border-top:1px solid rgba(255,255,255,.08)">'+(row.permissions&&row.permissions[k]?'Yes':'-')+'</td>').join('')+'</tr>').join(''))+'</tbody></table></div></div>'}
      function renderLiveOps(data){const viewers=(data.activeViewers||[]).slice(0,8);const reqs=(data.apiRequests||[]).slice(0,8);return '<div class="grid" style="grid-column:1/-1">'+
        '<div class="card"><strong>Current staff/dashboard viewers</strong><div class="list">'+(viewers.length?viewers.map(v=>'<div class="item"><div><strong>'+esc(v.userId)+'</strong><div class="muted">Last seen '+esc(String(v.lastSeenAt||'').replace('T',' ').slice(0,19))+'</div></div></div>').join(''):'<div class="muted">No active viewers tracked yet.</div>')+'</div></div>'+
        '<div class="card"><strong>Recent API requests</strong><div class="list">'+(reqs.length?reqs.map(r=>'<div class="item"><div><strong>'+esc(r.method+' '+r.path)+'</strong><div class="muted">'+esc(r.status)+' - '+esc(r.durationMs)+'ms - '+esc(r.userId||'anonymous')+'</div></div></div>').join(''):'<div class="muted">No API requests tracked yet.</div>')+'</div></div>'+
      '</div>'}
      function renderSummaryCards(cap){const groups=Array.isArray(cap&&cap.roleFamilies)?cap.roleFamilies:[];const cards=[
        {title:'Support Operations',desc:'Config, diagnostics, permission sync, setup restarts, channel repair.',enabled:!!cap.canRunDiagnostics},
        {title:'Quality Assurance',desc:'Transcript review, audit visibility, staff activity checks, compliance oversight.',enabled:!!cap.canViewTranscripts},
        {title:'Community Management',desc:'Owner-facing health visibility, onboarding/help flows, invite handoffs.',enabled:!!cap.canContactOwners}
      ];summary.innerHTML=cards.map(card=>'<div class="card"><strong>'+esc(card.title)+'</strong><div class="muted" style="margin-top:6px">'+esc(card.desc)+'</div><div class="row" style="margin-top:10px">'+(card.enabled?pill('Enabled for you'):pill('Read only / unavailable'))+'</div></div>').join('')+'<div class="card"><strong>Your active role families</strong><div class="muted" style="margin-top:6px">'+esc(groups.length?groups.join(' - '):'No senior role families detected')+'</div><div class="row" style="margin-top:10px">'+(groups.length?groups.map(pill).join(''):pill('No access'))+'</div></div>'}
      function renderPerms(g){const tags=[];if(g.setupCompleted)tags.push(pill('Setup complete'));if(g.canAccessDashboard)tags.push(pill('Dashboard access'));if(g.sharedWithUser)tags.push(pill('User is in server'));if(g.userPermissionSummary)tags.push(pill(g.userPermissionSummary));if(g.health&&g.health.missingPermissions&&g.health.missingPermissions.length)tags.push(pill('Missing bot perms'));return tags.join('')}
      function renderInfoList(title, values){const safe=Array.isArray(values)?values.filter(Boolean):[];return '<div class="card" style="padding:10px 12px"><div><strong>'+esc(title)+'</strong></div><div class="muted" style="margin-top:6px">'+(safe.length?safe.map(esc).join(' - '):'None detected')+'</div></div>'}
      function actionButtons(g){const caps=g.staffCapabilities||{};const buttons=[];if(g.canAccessDashboard&&caps.canViewConfiguration)buttons.push('<a class="btn primary" href="/overview?guild='+encodeURIComponent(g.id)+'"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('open'))}+'</span><span>Open Dashboard</span></a>');if(g.canManageSetup&&!g.setupCompleted&&caps.canViewConfiguration)buttons.push('<a class="btn" href="/setup?guild='+encodeURIComponent(g.id)+'&page=1"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('setup'))}+'</span><span>Open Setup</span></a>');if(caps.canCreateInvite)buttons.push('<button class="btn" type="button" data-invite="'+esc(g.id)+'"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('invite'))}+'</span><span>Create Invite</span></button>');if(caps.canRestartSystems)buttons.push('<button class="btn" type="button" data-restart-setup="'+esc(g.id)+'"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('restart'))}+'</span><span>Restart Setup</span></button>');if(caps.canSyncPermissions)buttons.push('<button class="btn" type="button" data-repair="'+esc(g.id)+'" data-repair-action="sync-permissions"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('repair'))}+'</span><span>Sync Permissions</span></button>');if(caps.canRepairChannels)buttons.push('<button class="btn" type="button" data-repair="'+esc(g.id)+'" data-repair-action="repair-channels"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('repair'))}+'</span><span>Repair Channels</span></button>');if(caps.canRunDiagnostics)buttons.push('<button class="btn" type="button" data-repair="'+esc(g.id)+'" data-repair-action="diagnostics"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('diagnostics'))}+'</span><span>Run Diagnostics</span></button>');if(caps.canRemoveBot)buttons.push('<button class="btn" type="button" data-leave="'+esc(g.id)+'" data-guild-name="'+esc(g.name)+'"><span class="btn-icon">'+${JSON.stringify(dashboardIcon('remove'))}+'</span><span>Remove Bot</span></button>');return buttons.join('')}
      function item(g){const icon=g.iconURL?'<img src="'+esc(g.iconURL)+'" style="width:42px;height:42px;border-radius:14px;box-shadow:0 0 22px rgba(0,0,0,.22)" />':'';const detail=(Array.isArray(g.highlights)&&g.highlights.length?g.highlights:['Bot is active in this server']).map(esc).join(' - ');const inviteUrl=inviteMap[g.id]||g.inviteUrl||'';const health=g.health||{};const runtime=g.runtime||{};const basic=g.basicInfo||{};const audits=Array.isArray(g.recentAuditLog)?g.recentAuditLog.slice(0,4):[];return '<div class="item server-card can-manage">'+
        '<div style="display:grid;gap:8px;min-width:0">'+
          '<div class="row" style="gap:10px">'+icon+'<div><strong>'+esc(g.name)+'</strong><div class="muted">'+esc(g.id)+'</div></div>'+(g.memberCount?('<span class="pill">'+esc(g.memberCount)+' members</span>'):'')+'</div>'+
          '<div class="row">'+renderPerms(g)+'</div>'+
          '<div class="muted">'+detail+'</div>'+
          '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">'+
            renderInfoList('Basic Info',['Guild ID: '+(basic.guildId||'Unknown'),'Owner ID: '+(basic.ownerId||'Unknown'),'Bot Join: '+(basic.botJoinDate?new Date(basic.botJoinDate).toLocaleString():'Unknown'),'Shard: '+(basic.shardAssignment||'Unknown'),'Plan: '+(basic.subscriptionPlan||'Standard'),'Modules: '+((basic.enabledModules||[]).join(', ')||'Core Tickets')])+
            renderInfoList('Ticket System Status',['Panels: '+(health.ticketPanelStatus||'Unknown'),'Transcripts: '+(health.transcriptStatus||'Unknown'),'Feedback: '+(health.feedbackStatus||'Unknown'),'Category: '+(health.categoryStatus||'Unknown'),'Button integrity: '+(health.buttonIntegrity||'Unknown'),'Webhook validity: '+(health.webhookValidity||'Unknown')])+
            renderInfoList('Runtime Diagnostics',['API latency: '+String(runtime.apiLatencyMs||0)+'ms','Database latency: '+(runtime.databaseLatencyMs==null?'Unavailable':String(runtime.databaseLatencyMs)+'ms'),'Redis latency: '+(runtime.redisLatencyMs==null?'Unavailable':String(runtime.redisLatencyMs)+'ms'),'Command failures: '+String(runtime.commandFailures||0),'Worker: '+(runtime.workerStatus||'Unknown'),'Cache: '+String((runtime.cacheHealth&&runtime.cacheHealth.channels)||0)+' channels / '+String((runtime.cacheHealth&&runtime.cacheHealth.roles)||0)+' roles'])+
            renderInfoList('Permission Scanner',[].concat((health.missingPermissions||[]).map(x=>'Missing '+x),health.hierarchyConflict?'Role hierarchy conflict detected':'',...(health.brokenChannels||[]),...(health.brokenPanels||[]).map(x=>'Broken panel channel '+x),...(health.brokenOverwrites||[])))+
          '</div>'+
          (audits.length?renderInfoList('Recent Audit Log',audits.map(entry=>(entry.createdAt||'')+' - '+(entry.action||'action')+' - '+(entry.status||'unknown')+(entry.detail?' - '+entry.detail:''))):'')+
          (inviteUrl?'<div class="card" style="padding:10px 12px"><div class="muted">Latest invite</div><a href="'+esc(inviteUrl)+'" target="_blank" rel="noreferrer">'+esc(inviteUrl)+'</a></div>':'')+
        '</div>'+
        '<div class="row">'+actionButtons(g)+'</div>'+
      '</div>'}
      async function postRepair(guildId,action){const data=await api('/api/staff/guild-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId,action})});return data}
      async function bindActions(){for(const btn of document.querySelectorAll('[data-invite]')){btn.onclick=async()=>{try{err.style.display='none';ok.style.display='none';btn.disabled=true;const guildId=btn.getAttribute('data-invite');const data=await api('/api/staff/guild-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId})});inviteMap[guildId]=data.inviteUrl||'';note('Invite ready for '+(data.guildName||'that server')+'.');await load()}catch(e){err.style.display='block';err.textContent=e.message}finally{btn.disabled=false}}}for(const btn of document.querySelectorAll('[data-restart-setup]')){btn.onclick=async()=>{try{err.style.display='none';ok.style.display='none';btn.disabled=true;const guildId=btn.getAttribute('data-restart-setup');await api('/api/staff/guild-restart-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId})});note('Setup restart prepared for that server.');await load()}catch(e){err.style.display='block';err.textContent=e.message}finally{btn.disabled=false}}}for(const btn of document.querySelectorAll('[data-repair]')){btn.onclick=async()=>{try{err.style.display='none';ok.style.display='none';btn.disabled=true;const guildId=btn.getAttribute('data-repair');const action=btn.getAttribute('data-repair-action');const data=await postRepair(guildId,action);note((data&&data.result&&data.result.message)||'Repair finished.');await load()}catch(e){err.style.display='block';err.textContent=e.message}finally{btn.disabled=false}}}for(const btn of document.querySelectorAll('[data-leave]')){btn.onclick=async()=>{const guildId=btn.getAttribute('data-leave');const guildName=btn.getAttribute('data-guild-name')||'this server';if(!confirm('Remove the bot from '+guildName+'?'))return;try{err.style.display='none';ok.style.display='none';btn.disabled=true;await api('/api/staff/guild-leave',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId})});delete inviteMap[guildId];note('The bot has been removed from '+guildName+'.');await load()}catch(e){err.style.display='block';err.textContent=e.message}finally{btn.disabled=false}}}}
      async function load(){try{const data=await api('/api/staff/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];renderSummaryCards(data.capabilities||{});summary.insertAdjacentHTML('beforeend',renderPermissionMatrix(data.permissionMatrix||[])+renderLiveOps(data));list.innerHTML=guilds.length?guilds.map(item).join(''):'<div class="muted">No bot-connected servers found.</div>';await bindActions()}catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;

    return baseDashboardPage({ title: 'Staff', body, script, ownerView, staffView: true, showStaffLink: true });
}

function createOwnerHtml(req = null) {
    const body = `
      <div class="card owner-console">
        <h2 style="margin:0 0 6px">Owner Console</h2>
        <div class="muted">Owner includes every staff capability, plus plan grants, AI access, live viewers, API requests, and audit history.</div>
        <div id="ownerError" class="err" style="display:none;margin-top:12px"></div>
        <div id="ownerSuccess" class="card" style="display:none;margin-top:12px;padding:12px 14px"></div>
        <div id="ownerContent" class="owner-summary" style="margin-top:12px"></div>
        <div id="ownerSummary" class="owner-summary" style="margin-top:12px"></div>
        <div id="ownerGuilds" class="owner-guilds"></div>
      </div>
    `;

    const script = `
      const err=document.getElementById('ownerError'),ok=document.getElementById('ownerSuccess'),content=document.getElementById('ownerContent'),summary=document.getElementById('ownerSummary'),guildList=document.getElementById('ownerGuilds');
      const csrfToken=${JSON.stringify(getDashboardSessionCsrfToken(req) || '')};
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      async function api(path,opt){const headers={...(opt&&opt.headers||{})};if(csrfToken&&String((opt&&opt.method)||'GET').toUpperCase()!=='GET')headers['x-csrf-token']=csrfToken;const r=await fetch(path,{credentials:'include',...(opt||{}),headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function note(t){ok.style.display='block';ok.innerHTML='<strong>Updated</strong><div class="muted">'+esc(t)+'</div>'}
      function pill(t){return '<span class="pill">'+esc(t)+'</span>'}
      function renderRows(title,items,mapper){return '<div class="card"><strong>'+esc(title)+'</strong><div class="list">'+(items.length?items.map(mapper).join(''):'<div class="muted">Nothing yet.</div>')+'</div></div>'}
      function renderMatrix(matrix){return '<div class="card"><strong>Staff dashboard role access</strong><div class="muted" style="margin-top:6px">Role IDs come from environment variables. Update STAFF_EXECUTIVE_ROLE_IDS, STAFF_SUPPORT_ROLE_IDS, STAFF_QA_ROLE_IDS, STAFF_COMMUNITY_ROLE_IDS, or SENIOR_STAFF_ROLE_IDS, then redeploy/restart.</div><div class="list" style="margin-top:10px">'+(matrix||[]).map(row=>'<details class="item" style="display:block"><summary><strong>'+esc(row.name)+'</strong> <span class="pill">'+esc((row.roleIds||[]).length)+' role(s)</span></summary><div class="muted" style="margin-top:8px;white-space:pre-wrap">'+esc((row.roleIds||[]).join('\\n')||'No roles configured')+'</div><div class="roles" style="margin-top:8px">'+Object.entries(row.permissions||{}).filter(x=>x[1]).map(x=>'<span class="pill">'+esc(x[0].replace(/^can/,''))+'</span>').join('')+'</div></details>').join('')+'</div></div>'}
      function renderContentTools(cfg){const imgs=Array.isArray(cfg.homeImages)?cfg.homeImages:[];const tutorials=Array.isArray(cfg.tutorials)?cfg.tutorials:[];const docs=Array.isArray(cfg.docsSections)?cfg.docsSections:[];return '<div class="card"><strong>Homepage rotating images</strong><div class="muted" style="margin-top:6px">Shown on the public homepage gallery. Use direct HTTPS image links.</div><label>Image 1</label><input id="ownerHomeImg1" value="'+esc(imgs[0]||'')+'" placeholder="https://..." /><label>Image 2</label><input id="ownerHomeImg2" value="'+esc(imgs[1]||'')+'" placeholder="https://..." /><label>Image 3</label><input id="ownerHomeImg3" value="'+esc(imgs[2]||'')+'" placeholder="https://..." /><div class="row" style="margin-top:10px"><button id="ownerSaveHomeImages" class="btn">Save Images</button><button id="ownerClearHomeImages" class="btn-soft">Clear</button></div></div>'+
      '<div class="card"><strong>Public tutorials</strong><div class="muted" style="margin-top:6px">Manage tutorial cards and walkthrough steps.</div><textarea id="ownerTutorialsJson" style="min-height:240px;font-family:Consolas,monospace">'+esc(JSON.stringify(tutorials,null,2))+'</textarea><div class="row" style="margin-top:10px"><button id="ownerSaveTutorials" class="btn">Save Tutorials</button><button id="ownerFormatTutorials" class="btn-soft">Format</button></div></div>'+
      '<div class="card"><strong>Documentation sections</strong><div class="muted" style="margin-top:6px">Manage the public documentation guide sections.</div><textarea id="ownerDocsJson" style="min-height:240px;font-family:Consolas,monospace">'+esc(JSON.stringify(docs,null,2))+'</textarea><div class="row" style="margin-top:10px"><button id="ownerSaveDocs" class="btn">Save Docs</button><button id="ownerFormatDocs" class="btn-soft">Format</button></div></div>'}
      function grantButtons(g){return '<div class="row"><button class="btn" data-plan="plus" data-guild="'+esc(g.id)+'">Grant Plus</button><button class="btn" data-plan="pro" data-guild="'+esc(g.id)+'">Grant Pro</button><button class="btn" data-custom="'+esc(g.id)+'">Grant Custom</button><button class="btn-soft" data-trial="plus_trial" data-guild="'+esc(g.id)+'">Plus Trial</button><button class="btn-soft" data-trial="pro_trial" data-guild="'+esc(g.id)+'">Pro Trial</button><button class="btn-danger" data-clear="'+esc(g.id)+'">Clear</button></div>'}
      function customFields(g){const bot=(g.aiAccess&&g.aiAccess.customBot)||{};return '<details class="card" style="padding:10px 12px"><summary><strong>Custom branded bot</strong> <span class="muted">'+(bot.tokenConfigured?'Token saved':'No token')+'</span></summary><div class="grid" style="margin-top:10px"><div><label>App ID</label><input data-cb-app="'+esc(g.id)+'" value="'+esc(bot.appId||'')+'" /></div><div><label>Public Key</label><input data-cb-key="'+esc(g.id)+'" value="'+esc(bot.publicKey||'')+'" /></div><div><label>Bot Token</label><input data-cb-token="'+esc(g.id)+'" placeholder="'+(bot.tokenConfigured?'Leave blank to keep saved token':'Paste token')+'" /></div></div><div class="muted" style="margin-top:10px">Name, avatar, and profile settings are configured in the Discord Developer Portal.</div></details>'}
      function guildCard(g){const icon=g.iconURL?'<img src="'+esc(g.iconURL)+'" style="width:42px;height:42px;border-radius:14px" />':'';const ai=g.aiAccess||{};return '<div class="item server-card can-manage"><div style="display:grid;gap:8px;width:100%"><div class="row">'+icon+'<div><strong>'+esc(g.name)+'</strong><div class="muted">'+esc(g.id)+'</div></div>'+pill(ai.statusLabel||'Free plan')+'</div><div class="muted">'+esc(g.memberCount||0)+' members - '+esc(ai.planLabel||'Free')+'</div>'+customFields(g)+grantButtons(g)+'</div></div>'}
      function readCustomBot(guildId){return{appId:(document.querySelector('[data-cb-app="'+guildId+'"]')||{}).value||'',publicKey:(document.querySelector('[data-cb-key="'+guildId+'"]')||{}).value||'',token:(document.querySelector('[data-cb-token="'+guildId+'"]')||{}).value||''}}
      async function grant(guildId,action,plan,customBot){await api('/api/owner/guild-ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId,action,plan,days:14,customBot})})}
      async function saveContent(patch){const cfg=(lastData&&lastData.botConfig)||{};await api('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appealsChannelId:'',homeImages:Array.isArray(cfg.homeImages)?cfg.homeImages:[],tutorials:Array.isArray(cfg.tutorials)?cfg.tutorials:[],docsSections:Array.isArray(cfg.docsSections)?cfg.docsSections:[],siteAnnouncement:cfg.siteAnnouncement||{},...patch})})}
      let lastData=null;
      async function load(){try{const data=await api('/api/owner/activity');lastData=data;const viewers=data.activeViewers||[], reqs=data.apiRequests||[], audit=data.staffAudit||[];content.innerHTML=renderContentTools(data.botConfig||{})+renderMatrix(data.permissionMatrix||[]);summary.innerHTML=
        renderRows('Current staff in dashboard',viewers.slice(0,10),v=>'<div class="item"><div><strong>'+esc(v.userId)+'</strong><div class="muted">Last seen '+esc(String(v.lastSeenAt||'').replace('T',' ').slice(0,19))+'</div></div></div>')+
        renderRows('Live API requests',reqs.slice(0,12),r=>'<div class="item"><div><strong>'+esc(r.method+' '+r.path)+'</strong><div class="muted">'+esc(r.status)+' - '+esc(r.durationMs)+'ms - '+esc(r.userId||'anonymous')+'</div></div></div>')+
        renderRows('Staff audit',audit.slice(0,12),a=>'<div class="item"><div><strong>'+esc(a.action||'action')+'</strong><div class="muted">'+esc(a.status||'unknown')+' - '+esc(a.guildId||'global')+' - '+esc(String(a.createdAt||'').replace('T',' ').slice(0,19))+'</div></div></div>');
        guildList.innerHTML=(data.guilds||[]).map(guildCard).join('')||'<div class="muted">No guilds found.</div>';
        document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{try{await grant(b.dataset.guild,'set-plan',b.dataset.plan);note('Plan granted.');await load()}catch(e){err.style.display='block';err.textContent=e.message}});
        document.querySelectorAll('[data-custom]').forEach(b=>b.onclick=async()=>{try{const guildId=b.dataset.custom;await grant(guildId,'set-plan','custom',readCustomBot(guildId));note('Custom plan and branded bot details saved.');await load()}catch(e){err.style.display='block';err.textContent=e.message}});
        document.querySelectorAll('[data-trial]').forEach(b=>b.onclick=async()=>{try{await grant(b.dataset.guild,'start-trial',b.dataset.trial);note('Trial started.');await load()}catch(e){err.style.display='block';err.textContent=e.message}});
        document.querySelectorAll('[data-clear]').forEach(b=>b.onclick=async()=>{try{await grant(b.dataset.clear,'clear','none');note('Access cleared.');await load()}catch(e){err.style.display='block';err.textContent=e.message}});
        const formatJson=(id,label)=>{try{const box=document.getElementById(id);box.value=JSON.stringify(JSON.parse(box.value),null,2)}catch{err.style.display='block';err.textContent=label+' JSON is invalid.'}};
        const ownerFormatTutorials=document.getElementById('ownerFormatTutorials');if(ownerFormatTutorials)ownerFormatTutorials.onclick=()=>formatJson('ownerTutorialsJson','Tutorials');
        const ownerFormatDocs=document.getElementById('ownerFormatDocs');if(ownerFormatDocs)ownerFormatDocs.onclick=()=>formatJson('ownerDocsJson','Documentation');
        const ownerSaveHomeImages=document.getElementById('ownerSaveHomeImages');if(ownerSaveHomeImages)ownerSaveHomeImages.onclick=async()=>{try{const homeImages=[ownerHomeImg1.value,ownerHomeImg2.value,ownerHomeImg3.value].map(x=>String(x||'').trim()).filter(Boolean);await saveContent({homeImages});note('Home images saved.');await load()}catch(e){err.style.display='block';err.textContent=e.message}};
        const ownerClearHomeImages=document.getElementById('ownerClearHomeImages');if(ownerClearHomeImages)ownerClearHomeImages.onclick=async()=>{try{await saveContent({homeImages:[]});note('Home images cleared.');await load()}catch(e){err.style.display='block';err.textContent=e.message}};
        const ownerSaveTutorials=document.getElementById('ownerSaveTutorials');if(ownerSaveTutorials)ownerSaveTutorials.onclick=async()=>{try{await saveContent({tutorials:JSON.parse(ownerTutorialsJson.value||'[]')});note('Tutorials saved.');await load()}catch(e){err.style.display='block';err.textContent=e.message}};
        const ownerSaveDocs=document.getElementById('ownerSaveDocs');if(ownerSaveDocs)ownerSaveDocs.onclick=async()=>{try{await saveContent({docsSections:JSON.parse(ownerDocsJson.value||'[]')});note('Documentation saved.');await load()}catch(e){err.style.display='block';err.textContent=e.message}};
      }catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;
    return baseDashboardPage({ title: 'Owner', body, script, ownerView: true, staffView: true, showStaffLink: true });
}

function createSetupHtml(req = null) {
    const body = `
      <style>
        .setup-shell{display:grid;gap:16px}
        .setup-hero{display:grid;gap:14px}
        .setup-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
        .setup-title{font-size:28px;font-weight:800;letter-spacing:.02em}
        .setup-sub{max-width:760px}
        .setup-progress{position:relative;height:14px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid rgba(255,255,255,.08)}
        .setup-progress-bar{position:absolute;inset:0 auto 0 0;width:25%;border-radius:inherit;background:linear-gradient(90deg,rgba(56,189,248,.92),rgba(125,211,252,.72));box-shadow:0 0 22px rgba(56,189,248,.26);transition:width .35s ease}
        .setup-progress-bar::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.36),transparent);animation:setupShimmer 1.8s linear infinite}
        .setup-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
        .setup-step-pill{padding:12px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);transition:transform .25s ease,border-color .25s ease,background .25s ease,opacity .25s ease}
        .setup-step-pill.active{border-color:rgba(56,189,248,.5);background:rgba(56,189,248,.12);transform:translateY(-2px)}
        .setup-step-pill.done{border-color:rgba(87,242,135,.35);background:rgba(87,242,135,.10)}
        .setup-step-no{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(247,248,255,.52)}
        .setup-step-name{font-weight:700;margin-top:4px}
        .setup-grid{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(300px,.85fr);gap:16px}
        .setup-panel{min-height:480px;position:relative;overflow:hidden}
        .setup-panel::before{content:"";position:absolute;inset:auto -60px -90px auto;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.20),transparent 70%);pointer-events:none}
        .setup-stage{display:none;animation:setupFade .28s ease}
        .setup-stage.active{display:block}
        .setup-stage h3{margin:0 0 6px}
        .setup-actions{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:18px}
        .setup-actions .row{display:flex;gap:10px;flex:1 1 260px}
        .setup-mini{display:grid;gap:10px}
        .setup-toggle{display:flex;align-items:flex-start;gap:12px;padding:14px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
        .setup-toggle input{width:auto;margin-top:4px}
        .setup-summary{display:grid;gap:10px;margin-top:14px}
        .setup-summary .item{align-items:flex-start}
        .setup-tag{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid rgba(56,189,248,.24);background:rgba(56,189,248,.08);font-size:12px}
        .setup-inline{display:flex;gap:10px;flex-wrap:wrap}
        .setup-inline > *{flex:1 1 180px}
        .setup-hint-list{display:grid;gap:10px}
        .setup-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
        .setup-choice{border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:16px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));box-shadow:0 18px 40px rgba(0,0,0,.18)}
        .setup-choice strong{display:block;font-size:15px;margin-bottom:6px}
        .setup-complete{display:none;margin-top:14px;padding:14px 16px;border-radius:18px;border:1px solid rgba(87,242,135,.26);background:rgba(87,242,135,.10)}
        .setup-complete.show{display:block}
        .setup-confetti{position:fixed;inset:0;pointer-events:none;z-index:999}
        .setup-finish-overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(2,6,23,.78);backdrop-filter:blur(8px);z-index:1000;padding:20px}
        .setup-finish-overlay.show{display:flex}
        .setup-finish-card{max-width:520px;width:100%;text-align:center;padding:28px 24px}
        .setup-finish-card h3{margin:0 0 8px;font-size:28px}
        .setup-native-select{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}
        .custom-select{position:relative;cursor:pointer;transition:300ms}
        .cs-trigger{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(42,47,59,.55);border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px 12px;color:var(--tx);box-shadow:0 10px 24px rgba(0,0,0,.18);transition:transform 220ms ease,background 220ms ease,border-color 220ms ease}
        .cs-trigger:hover{transform:translateY(-1px);background:rgba(50,55,65,.55);border-color:rgba(56,189,248,.24)}
        .cs-trigger:disabled{opacity:.55;cursor:not-allowed;transform:none}
        .cs-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
        .cs-caret{opacity:.75;font-size:11px;transition:transform 300ms ease}
        .custom-select.open .cs-caret{transform:rotate(180deg)}
        .cs-menu{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:50;background:rgba(42,47,59,.94);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:8px;box-shadow:0 18px 40px rgba(0,0,0,.45);backdrop-filter:blur(16px);opacity:0;transform:translateY(-12px) scale(.985);pointer-events:none;transition:opacity 300ms ease,transform 300ms ease}
        .custom-select.open .cs-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
        .cs-search{margin-bottom:8px}
        .cs-list{max-height:220px;overflow:auto;display:grid;gap:6px}
        .cs-opt{width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.04);display:flex;gap:8px;align-items:center;transition:300ms}
        .cs-opt:hover{background:rgba(50,55,65,.65);border-color:rgba(56,189,248,.22)}
        .cs-opt.active{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.40)}
        @keyframes setupFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        @keyframes setupShimmer{0%{transform:translateX(-120%)}100%{transform:translateX(140%)}}
        @media(max-width:940px){.setup-grid,.setup-steps,.setup-choice-grid{grid-template-columns:1fr}.setup-panel{min-height:auto}}
      </style>
      <div class="setup-shell">
        <div class="card setup-hero">
          <div class="setup-header">
            <div>
              <div class="setup-title">Server Setup</div>
              <div class="muted setup-sub">A shorter onboarding flow for getting a server live. Pick the server, choose the channels, set the key roles, then finish once.</div>
            </div>
            <a class="btn" id="setupOpenDashboardLink" href="/dashboard">Server Access</a>
          </div>
          <div class="setup-progress"><div id="setupProgressBar" class="setup-progress-bar"></div></div>
          <div id="setupStepPills" class="setup-steps">
            <div class="setup-step-pill"><div class="setup-step-no">Step 1</div><div class="setup-step-name">Server</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 2</div><div class="setup-step-name">Channels</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 3</div><div class="setup-step-name">Roles</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 4</div><div class="setup-step-name">Finish</div></div>
          </div>
        </div>
        <div class="setup-grid">
          <div class="card setup-panel">
            <div id="setupError" class="err" style="display:none;margin-bottom:12px"></div>

            <section class="setup-stage" data-step="1">
              <h3>Pick the server</h3>
              <div class="muted">Choose the guild this setup should manage. Once you finish setup, this flow locks for regular staff so it can&apos;t be restarted by accident.</div>
              <label>Guild</label>
              <select id="guildSelect"></select>
              <div class="setup-inline" style="margin-top:12px">
                <button id="initTemplate" class="btn primary" type="button">Create server config</button>
              </div>
              <div class="setup-actions">
                <div class="row"></div>
                <div class="row"><button id="stepNext1" class="btn primary" type="button">Continue</button></div>
              </div>
            </section>

            <section class="setup-stage" data-step="2">
              <h3>Choose or create channels</h3>
              <div class="muted">Set the core channels for this server. If a channel does not exist yet, the bot can make it for you.</div>
              <div class="setup-choice-grid">
                <div class="setup-choice"><strong>Ticket Category</strong><div class="muted">Where new tickets should live.</div></div>
                <div class="setup-choice"><strong>Archive Channels</strong><div class="muted">Where feedback and transcripts should be stored.</div></div>
              </div>
              <label>Ticket Category</label>
              <select id="parentCategoryId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="category">Create a channel for me</button>
              </div>
              <label>Feedback Channel</label>
              <select id="appealsChannelId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="feedback">Create a channel for me</button>
              </div>
              <label>Transcripts Channel</label>
              <select id="transcriptsChannelId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="transcripts">Create a channel for me</button>
              </div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="1">Back</button></div>
                <div class="row">
                  <button id="saveChannels" class="btn" type="button">Save channels</button>
                  <button id="stepNext2" class="btn primary" type="button">Continue</button>
                </div>
              </div>
            </section>

            <section class="setup-stage" data-step="3">
              <h3>Roles and behaviour</h3>
              <div class="muted">Choose the manager role and a couple of behavior toggles, similar to a server onboarding checklist.</div>
              <label>Manager Role</label>
              <select id="managerRoleId"></select>
              <label>High Escalation Role</label>
              <select id="highEscalationRoleId"></select>
              <label>Immediate Escalation Role</label>
              <select id="immediateEscalationRoleId"></select>
              <div class="setup-mini" style="margin-top:12px">
                <label class="setup-toggle">
                  <input id="rolePermanence" type="checkbox" />
                  <div>
                    <strong>Role permanence</strong>
                    <div class="muted">When a support member claims a ticket, the bot keeps a direct overwrite on that ticket so they retain access even if roles change mid-conversation.</div>
                  </div>
                </label>
                <label class="setup-toggle">
                  <input id="tutorialEnabled" type="checkbox" />
                  <div>
                    <strong>Show tutorial library</strong>
                    <div class="muted">Lets staff open the tutorial cards page from the dashboard when they need a refresher.</div>
                  </div>
                </label>
              </div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="2">Back</button></div>
                <div class="row">
                  <button id="saveRoles" class="btn" type="button">Save roles</button>
                  <button id="stepNext3" class="btn primary" type="button">Review</button>
                </div>
              </div>
            </section>

            <section class="setup-stage" data-step="4">
              <h3>Review and finish</h3>
              <div class="muted">Check the summary below, save everything once more if needed, then finish. After that this setup flow is locked for non-owners.</div>
              <div id="setupSummary" class="setup-summary"></div>
              <div id="setupCompleteBanner" class="setup-complete"><strong>Setup finished.</strong><div class="muted">This onboarding flow is now locked for regular staff. Use the main dashboard for everyday changes.</div></div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="3">Back</button></div>
                <div class="row">
                  <button id="saveSetup" class="btn" type="button">Save all</button>
                  <button id="markComplete" class="btn primary" type="button">Mark complete</button>
                </div>
              </div>
            </section>
          </div>

          <div class="card">
            <h3 style="margin:0 0 6px">After Setup</h3>
            <div class="muted">Once you are live, keep the day-to-day flow simple:</div>
            <div class="setup-hint-list" style="margin-top:12px">
              <div class="item"><strong>1. Post a ticket panel</strong><div class="muted">Use the dashboard or \`/set-panel\` to place the opener in your chosen channel.</div></div>
              <div class="item"><strong>2. Claim tickets</strong><div class="muted">Support members use \`/claim\` to take ownership so stats and metadata stay clean.</div></div>
              <div class="item"><strong>3. Close with transcript</strong><div class="muted">Use \`/closerequest\` or the close button so the transcript archive stays complete.</div></div>
            </div>
            <div class="setup-inline" style="margin-top:14px"><a class="btn primary" href="/tutorials">Open Tutorials</a></div>
            <div class="muted" style="margin-top:12px">If you do not see a guild yet, let the bot finish logging in and refresh this page.</div>
          </div>
        </div>
      </div>
      <canvas id="setupConfetti" class="setup-confetti"></canvas>
      <div id="setupFinishOverlay" class="setup-finish-overlay">
        <div class="card setup-finish-card">
          <h3>Setup complete</h3>
          <div class="muted">This server is now fully configured. Use the main dashboard for future updates instead of re-running setup.</div>
          <div class="setup-inline" style="margin-top:18px;justify-content:center">
            <button id="setupFinishDone" class="btn primary" type="button">Finished</button>
          </div>
        </div>
      </div>
    `;

    const script = `
      const qs=new URLSearchParams(location.search);
      const err=document.getElementById('setupError');
      const dashboardLink=document.getElementById('setupOpenDashboardLink');
      const guildSelect=document.getElementById('guildSelect');
      const parentCategoryId=document.getElementById('parentCategoryId');
      const appealsChannelId=document.getElementById('appealsChannelId');
      const transcriptsChannelId=document.getElementById('transcriptsChannelId');
      const managerRoleId=document.getElementById('managerRoleId');
      const highEscalationRoleId=document.getElementById('highEscalationRoleId');
      const immediateEscalationRoleId=document.getElementById('immediateEscalationRoleId');
      const rolePermanence=document.getElementById('rolePermanence');
      const tutorialEnabled=document.getElementById('tutorialEnabled');
      const summary=document.getElementById('setupSummary');
      const saveBtn=document.getElementById('saveSetup');
      const doneBtn=document.getElementById('markComplete');
      const initBtn=document.getElementById('initTemplate');
      const completeBanner=document.getElementById('setupCompleteBanner');
      const finishOverlay=document.getElementById('setupFinishOverlay');
      const finishDoneBtn=document.getElementById('setupFinishDone');
      const progressBar=document.getElementById('setupProgressBar');
      const stepPills=[...document.querySelectorAll('#setupStepPills .setup-step-pill')];
      const stages=[...document.querySelectorAll('.setup-stage')];
      let currentStep=1;
      let setupLocked=false;
      let setupCompleted=false;
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      const setupSelectPlaceholders={guildSelect:'Select a server',parentCategoryId:'Not set',appealsChannelId:'Not set',transcriptsChannelId:'Not set',managerRoleId:'Optional',highEscalationRoleId:'Optional',immediateEscalationRoleId:'Optional'};
      function closeSetupSelects(){document.querySelectorAll('.custom-select.open').forEach(el=>el.classList.remove('open'))}
      function refreshSetupSelect(selectEl,placeholder){if(!selectEl)return;let wrap=document.querySelector('[data-setup-cs=\"'+selectEl.id+'\"]');if(!wrap){selectEl.classList.add('setup-native-select');wrap=document.createElement('div');wrap.className='custom-select';wrap.dataset.setupCs=selectEl.id;selectEl.insertAdjacentElement('afterend',wrap)}const options=[...selectEl.options];const selected=options.find(o=>o.value===selectEl.value)||options[selectEl.selectedIndex]||null;wrap.innerHTML='<button type=\"button\" class=\"cs-trigger\" '+(selectEl.disabled?'disabled':'')+'><span class=\"cs-label\">'+esc((selected&&selected.text)||placeholder||'Select')+'</span><span class=\"cs-caret\">v</span></button><div class=\"cs-menu\"><input class=\"cs-search\" placeholder=\"Search\" /><div class=\"cs-list\">'+options.map(o=>'<button type=\"button\" class=\"cs-opt '+(o.value===selectEl.value?'active':'')+'\" data-value=\"'+esc(o.value)+'\">'+esc(o.text||placeholder||'Select')+'</button>').join('')+'</div></div>';const trigger=wrap.querySelector('.cs-trigger');const search=wrap.querySelector('.cs-search');const opts=[...wrap.querySelectorAll('.cs-opt')];if(trigger)trigger.onclick=e=>{e.stopPropagation();if(selectEl.disabled)return;const next=!wrap.classList.contains('open');closeSetupSelects();if(next){wrap.classList.add('open');if(search)search.focus()}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();opts.forEach(btn=>{btn.style.display=!q||btn.textContent.toLowerCase().includes(q)?'flex':'none'})};opts.forEach(btn=>{btn.onclick=()=>{selectEl.value=btn.getAttribute('data-value')||'';selectEl.dispatchEvent(new Event('change',{bubbles:true}));closeSetupSelects();refreshSetupSelect(selectEl,placeholder)}})}
      function refreshAllSetupSelects(){for(const el of [guildSelect,parentCategoryId,appealsChannelId,transcriptsChannelId,managerRoleId,highEscalationRoleId,immediateEscalationRoleId])refreshSetupSelect(el,setupSelectPlaceholders[el&&el.id]||'Select')}
      const csrfToken=${JSON.stringify(getDashboardSessionCsrfToken(req) || '')};
      async function api(path,opt){const headers={...(opt&&opt.headers||{})};if(csrfToken&&String((opt&&opt.method)||'GET').toUpperCase()!=='GET')headers['x-csrf-token']=csrfToken;const r=await fetch(path,{credentials:'include',...(opt||{}),headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function opt(id,label,selected){return '<option value=\"'+esc(id)+'\" '+(selected?'selected':'')+'>'+esc(label)+'</option>'}
      function fillSelect(el,items,emptyLabel,selected){const rows=['<option value=\"\">'+esc(emptyLabel)+'</option>'].concat(items.map(it=>opt(it.id,it.label||it.name||it.id,selected===it.id)));el.innerHTML=rows.join('');refreshSetupSelect(el,emptyLabel)}
      let catalogs={ roles:[], channels:[], categories:[] };
      function syncPageState(){if(guildSelect&&guildSelect.value)qs.set('guild',guildSelect.value);if(currentStep)qs.set('page',String(currentStep));history.replaceState(null,'','?'+qs.toString());if(dashboardLink)dashboardLink.href='/dashboard';}
      function setLocked(locked){setupLocked=!!locked;for(const el of [guildSelect,parentCategoryId,appealsChannelId,transcriptsChannelId,managerRoleId,highEscalationRoleId,immediateEscalationRoleId,rolePermanence,tutorialEnabled]){if(el)el.disabled=setupLocked}refreshAllSetupSelects();for(const btn of document.querySelectorAll('[data-create-kind],#initTemplate,#saveChannels,#saveRoles,#saveSetup,#markComplete,#stepNext1,#stepNext2,#stepNext3')){if(btn)btn.disabled=setupLocked}if(saveBtn)saveBtn.style.display=setupLocked?'none':'';if(doneBtn)doneBtn.style.display=setupLocked?'none':'';if(completeBanner)completeBanner.classList.toggle('show',setupLocked);}
      function showFinishOverlay(){if(finishOverlay)finishOverlay.classList.add('show')}
      function hideFinishOverlay(){if(finishOverlay)finishOverlay.classList.remove('show')}
      function fireConfetti(){const canvas=document.getElementById('setupConfetti');if(!canvas)return;const ctx=canvas.getContext('2d');if(!ctx)return;const dpr=Math.max(1,window.devicePixelRatio||1);const pieces=Array.from({length:120},(_,i)=>({x:Math.random()*window.innerWidth,y:-20-Math.random()*window.innerHeight*.2,vx:(Math.random()-.5)*5,vy:2+Math.random()*5,size:5+Math.random()*7,rot:Math.random()*Math.PI,color:['#57f287','#38bdf8','#fbbf24','#fb7185','#a78bfa'][i%5]}));canvas.width=Math.floor(window.innerWidth*dpr);canvas.height=Math.floor(window.innerHeight*dpr);canvas.style.width=window.innerWidth+'px';canvas.style.height=window.innerHeight+'px';ctx.scale(dpr,dpr);let frame=0;function tick(){ctx.clearRect(0,0,window.innerWidth,window.innerHeight);for(const p of pieces){p.x+=p.vx;p.y+=p.vy;p.rot+=0.08;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);ctx.fillStyle=p.color;ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size*.65);ctx.restore();}frame+=1;if(frame<140){requestAnimationFrame(tick)}else{ctx.clearRect(0,0,window.innerWidth,window.innerHeight)}}tick()}
      function gotoStep(step){const safe=Math.max(1,Math.min(4,Number(step)||1));currentStep=safe;stages.forEach(stage=>stage.classList.toggle('active',Number(stage.dataset.step)===safe));stepPills.forEach((pill,index)=>{const n=index+1;pill.classList.toggle('active',n===safe);pill.classList.toggle('done',n<safe)});if(progressBar)progressBar.style.width=(safe/4*100)+'%';syncPageState();renderSummary()}
      function configPayload(){return{guildId:guildSelect.value,parentCategoryId:parentCategoryId.value||null,appealsChannelId:appealsChannelId.value||null,transcriptsChannelId:transcriptsChannelId.value||null,managerRoleId:managerRoleId.value||null,escalationRoles:{high:highEscalationRoleId.value||null,immediate:immediateEscalationRoleId.value||null},rolePermanence:!!rolePermanence.checked,tutorialEnabled:!!tutorialEnabled.checked,setup:{step:currentStep}}}
      function readLabel(selectEl){if(!selectEl)return 'Not set';const option=selectEl.options[selectEl.selectedIndex];return option&&option.value?option.text:'Not set'}
      function renderSummary(){if(!summary)return;summary.innerHTML=''+
        '<div class=\"item\"><div><strong>Guild</strong><div class=\"muted\">'+esc(readLabel(guildSelect))+'</div></div><span class=\"setup-tag\">Step '+currentStep+' of 4</span></div>'+
        '<div class=\"item\"><div><strong>Ticket Category</strong><div class=\"muted\">'+esc(readLabel(parentCategoryId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Feedback Channel</strong><div class=\"muted\">'+esc(readLabel(appealsChannelId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Transcripts Channel</strong><div class=\"muted\">'+esc(readLabel(transcriptsChannelId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Manager Role</strong><div class=\"muted\">'+esc(readLabel(managerRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>High Escalation Role</strong><div class=\"muted\">'+esc(readLabel(highEscalationRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Immediate Escalation Role</strong><div class=\"muted\">'+esc(readLabel(immediateEscalationRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Role Permanence</strong><div class=\"muted\">'+(rolePermanence.checked?'Enabled':'Disabled')+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Tutorial</strong><div class=\"muted\">'+(tutorialEnabled.checked?'Enabled':'Disabled')+'</div></div></div>';}
      async function loadCatalogs(){const gid=guildSelect.value;const suffix=gid?('?guildId='+encodeURIComponent(gid)):'';const ch=await api('/api/channels'+suffix);const cats=await api('/api/categories'+suffix);const roles=await api('/api/roles'+suffix);catalogs.channels=Array.isArray(ch.channels)?ch.channels:[];catalogs.categories=Array.isArray(cats.categories)?cats.categories:[];catalogs.roles=Array.isArray(roles.roles)?roles.roles:[];fillSelect(parentCategoryId,catalogs.categories,'Not set',null);const texts=catalogs.channels.filter(c=>c.type==='text');fillSelect(appealsChannelId,texts,'Not set',null);fillSelect(transcriptsChannelId,texts,'Not set',null);fillSelect(managerRoleId,catalogs.roles,'Optional',null);fillSelect(highEscalationRoleId,catalogs.roles,'Optional',null);fillSelect(immediateEscalationRoleId,catalogs.roles,'Optional',null)}
      async function loadGuilds(){const data=await api('/api/my/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];guildSelect.innerHTML=guilds.map(g=>'<option value=\"'+esc(g.id)+'\">'+esc(g.name)+' ('+esc(g.id)+')</option>').join('')||'<option value=\"\">No guilds found</option>';const preset=qs.get('guild');if(preset&&guilds.some(g=>g.id===preset))guildSelect.value=preset;refreshSetupSelect(guildSelect,'Select a server');syncPageState()}
      async function loadConfig(){const gid=guildSelect.value; if(!gid) return; const data=await api('/api/guild-config?guildId='+encodeURIComponent(gid)); const c=data.config||{}; parentCategoryId.value=c.parentCategoryId||''; appealsChannelId.value=c.appealsChannelId||''; transcriptsChannelId.value=c.transcriptsChannelId||''; managerRoleId.value=c.managerRoleId||''; highEscalationRoleId.value=(c.escalationRoles&&c.escalationRoles.high)||''; immediateEscalationRoleId.value=(c.escalationRoles&&c.escalationRoles.immediate)||''; rolePermanence.checked=c.rolePermanence!==false; tutorialEnabled.checked=!!c.tutorialEnabled; refreshAllSetupSelects(); setupCompleted=Boolean(c&&c.setup&&c.setup.completed); const canOverrideCompleted=Boolean(data&&data.access&&data.access.isOwner); setLocked(setupCompleted&&!canOverrideCompleted); const requestedPage=Number(qs.get('page')||0); const configStep=Number(c&&c.setup&&c.setup.step)||1; gotoStep(setupCompleted?4:(requestedPage||configStep));}
      async function saveConfig(extra){const payload={...configPayload(),...(extra||{})};await api('/api/guild-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}
      saveBtn.onclick=async()=>{try{err.style.display='none';await saveConfig();saveBtn.textContent='Saved';setTimeout(()=>saveBtn.textContent='Save all',1000)}catch(e){err.style.display='block';err.textContent=e.message}};
      doneBtn.onclick=async()=>{try{err.style.display='none';await saveConfig({setupComplete:true,setup:{step:4}});fireConfetti();showFinishOverlay();doneBtn.textContent='Completed';setTimeout(()=>doneBtn.textContent='Mark complete',1200);await loadConfig()}catch(e){err.style.display='block';err.textContent=e.message}};
      initBtn.onclick=async()=>{try{if(setupCompleted)throw new Error('This server setup is already finished.');err.style.display='none';const gid=guildSelect.value;initBtn.disabled=true;await api('/api/guild-config/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:gid})});await loadConfig();initBtn.textContent='Created';setTimeout(()=>{initBtn.textContent='Create server config';initBtn.disabled=false},1200)}catch(e){err.style.display='block';err.textContent=e.message;initBtn.disabled=false}};
      const saveChannelsBtn=document.getElementById('saveChannels');if(saveChannelsBtn)saveChannelsBtn.onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:2}})}catch(e){err.style.display='block';err.textContent=e.message}};
      const saveRolesBtn=document.getElementById('saveRoles');if(saveRolesBtn)saveRolesBtn.onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:3}})}catch(e){err.style.display='block';err.textContent=e.message}};
      async function createChannel(kind){const gid=guildSelect.value;if(!gid)throw new Error('Pick a guild first.');const defaults={category:'Tickets',feedback:'ticket-feedback',transcripts:'ticket-transcripts'};const label=kind==='category'?'category':'channel';const name=prompt('Name for the new '+label+':',defaults[kind]||'tickets');if(name===null)return false;const trimmed=String(name||'').trim();if(!trimmed)throw new Error('A name is required.');await saveConfig({setup:{step:2}});const result=await api('/api/setup/create-channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:gid,kind,name:trimmed,parentCategoryId:parentCategoryId.value||null})});await loadCatalogs();if(kind==='category')parentCategoryId.value=result.channel.id;else if(kind==='feedback')appealsChannelId.value=result.channel.id;else if(kind==='transcripts')transcriptsChannelId.value=result.channel.id;refreshAllSetupSelects();renderSummary();return true}
      document.querySelectorAll('[data-create-kind]').forEach(btn=>btn.onclick=async()=>{try{err.style.display='none';btn.disabled=true;const created=await createChannel(btn.getAttribute('data-create-kind'));if(created){btn.textContent='Created';setTimeout(()=>{btn.textContent='Create a channel for me';btn.disabled=setupLocked},1100)}else{btn.disabled=setupLocked}}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=setupLocked}});
      document.querySelectorAll('[data-go-step]').forEach(btn=>btn.onclick=()=>gotoStep(btn.getAttribute('data-go-step')));
      const stepNext1=document.getElementById('stepNext1');if(stepNext1)stepNext1.onclick=()=>gotoStep(2);
      const stepNext2=document.getElementById('stepNext2');if(stepNext2)stepNext2.onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:2}});gotoStep(3)}catch(e){err.style.display='block';err.textContent=e.message}};
      const stepNext3=document.getElementById('stepNext3');if(stepNext3)stepNext3.onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:3}});gotoStep(4)}catch(e){err.style.display='block';err.textContent=e.message}};
      [guildSelect,parentCategoryId,appealsChannelId,transcriptsChannelId,managerRoleId,highEscalationRoleId,immediateEscalationRoleId,rolePermanence,tutorialEnabled].forEach(el=>{if(el)el.onchange=renderSummary});
      guildSelect.onchange=async()=>{syncPageState();try{await api('/api/dashboard/select-guild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:guildSelect.value})})}catch{};await loadCatalogs();await loadConfig();};
      if(finishDoneBtn)finishDoneBtn.onclick=()=>{hideFinishOverlay();window.location='/dashboard';};
      if(finishOverlay)finishOverlay.onclick=(e)=>{if(e.target===finishOverlay){hideFinishOverlay();window.location='/dashboard';}};
      document.addEventListener('click',e=>{if(!e.target.closest('.custom-select'))closeSetupSelects()});
      (async()=>{try{gotoStep(1);await loadGuilds();try{await api('/api/dashboard/select-guild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:guildSelect.value})})}catch{};await loadCatalogs();await loadConfig();renderSummary()}catch(e){err.style.display='block';err.textContent=e.message}})();
    `;

    return baseDashboardPage({ title: 'Setup', body, script, showStaffLink: false });
}

function parseCookies(source) {
    const out = {};
    for (const part of String(source || '').split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function isAuthed(req) {
    const dashboardToken = getDashboardToken();
    const ownerToken = getDashboardOwnerToken();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;

    const tokenOk =
        (dashboardToken && (headerToken === dashboardToken || cookieToken === dashboardToken)) ||
        (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken));
    if (tokenOk) return true;

    if (hasDiscordOAuthConfigured()) {
        const userId = getDashboardSessionUserId(req);
        if (userId) return true;
    }

    if (!dashboardToken && !ownerToken) {
        return !isDashboardOAuthRequired();
    }

    return false;
}

function isOwnerAuthed(req) {
    const ownerToken = String(getDashboardOwnerToken() || getDashboardToken() || '').trim();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;

    if (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken)) return true;

    if (hasDiscordOAuthConfigured()) {
        const userId = getDashboardSessionUserId(req);
        if (userId && userId === getBotOwnerId()) return true;
    }

    if (!ownerToken) {
        return !isDashboardOAuthRequired();
    }

    return false;
}

function isBotOwnerUser(req) {
    const ownerId = getBotOwnerId();
    if (!ownerId) return false;
    const userId = getDashboardSessionUserId(req);
    return Boolean(userId && userId === ownerId);
}

function getSeniorStaffRoleIds() {
    const envRoles = parseRoleIdList(process.env.SENIOR_STAFF_ROLE_IDS || process.env.STAFF_ROLE_IDS || '');
    return Array.from(new Set([...SENIOR_STAFF_ROLE_IDS, ...envRoles]));
}

function createLegalHtml(type = 'privacy') {
    const isTerms = type === 'terms';
    const updated = 'May 31, 2026';
    const title = isTerms ? 'Terms of Service' : 'Privacy Policy';
    const sections = isTerms
        ? [
            ['Acceptance', 'By inviting or using eazyDesk, the dashboard, or related services, you agree to these Terms of Service. If you do not agree, do not use the service.'],
            ['Service Use', 'You are responsible for configuring the bot appropriately for your Discord server, keeping access tokens private, and ensuring staff use the service lawfully and respectfully.'],
            ['Discord Platform', 'The service depends on Discord APIs and permissions. Discord outages, API changes, missing permissions, or server configuration issues may affect availability or behavior.'],
            ['Subscriptions and Custom Bots', 'Paid or custom-plan features may be changed, paused, or revoked if payment, abuse, security, or configuration issues occur. Custom branded bots remain limited to their assigned server.'],
            ['Prohibited Use', 'Do not use the service for spam, harassment, unlawful activity, credential theft, privacy invasion, or attempts to bypass access controls.'],
            ['Disclaimers', 'The service is provided as-is without warranties of uninterrupted availability, perfect accuracy, or fitness for a particular purpose.'],
            ['Limitation of Liability', 'To the maximum extent permitted by law, Sync Development is not liable for indirect, incidental, consequential, or punitive damages arising from use of the service.'],
            ['Changes', 'We may update these terms as the service changes. Continued use after changes means you accept the updated terms.'],
            ['Contact', 'Questions about these terms can be raised through the official support server.']
        ]
        : [
            ['Overview', 'This Privacy Policy explains the standard information eazyDesk processes to provide Discord ticketing, transcripts, dashboard access, support analytics, and custom bot features.'],
            ['Information We Process', 'We may process Discord user IDs, guild IDs, channel IDs, role IDs, ticket metadata, command usage, dashboard session data, transcript files, support notes, feedback, and configuration settings provided by server administrators.'],
            ['How We Use Information', 'Information is used to operate ticket workflows, enforce permissions, create transcripts, show dashboard analytics, manage staff access, troubleshoot errors, and provide configured custom bot features.'],
            ['Cookies and Sessions', 'The dashboard uses cookies for login sessions, CSRF protection, and transcript viewer access. Dashboard sessions may be remembered for up to 30 days unless you log out or the session expires.'],
            ['Transcripts', 'Ticket transcripts may contain message content and attachments visible in the ticket. Server administrators are responsible for configuring retention, access, and disclosure to their users.'],
            ['Sharing', 'We do not sell personal data. Data may be shared only with Discord APIs, hosting/storage providers needed to run the service, or where required for security, abuse prevention, legal compliance, or support.'],
            ['Retention', 'Configuration and operational records are kept while needed to run the service. Transcript retention depends on your configured retention settings. Backups may persist for a limited period.'],
            ['Security', 'We use reasonable technical controls such as access checks, session cookies, and restricted dashboard routes. Server owners should protect dashboard tokens, bot tokens, and owner access.'],
            ['Your Choices', 'Server owners can remove the bot, delete or rotate configuration, clear transcripts where supported, and contact support for help with data questions.'],
            ['Contact', 'Questions about this policy can be raised through the official support server.']
        ];
    const body = `
      <div class="card" style="max-width:980px;margin:0 auto">
        <div class="pricing-kicker">Legal</div>
        <h1 style="margin:0 0 8px">${title}</h1>
        <div class="muted">Last updated: ${updated}</div>
        <div class="list" style="margin-top:18px">
          ${sections.map(([heading, text]) => `<div class="item" style="display:block"><strong>${heading}</strong><div class="muted" style="margin-top:8px;line-height:1.7">${text}</div></div>`).join('')}
        </div>
        <div class="row" style="margin-top:18px"><a class="btn" href="/">Home</a><a class="btn-soft" href="/dashboard">Dashboard</a></div>
      </div>
    `;
    return baseDashboardPage({ title, body, ownerView: false, showStaffLink: false });
}

function normalizeDocSections(input) {
    const list = Array.isArray(input) ? input : DEFAULT_DOC_SECTIONS;
    return list
        .map((section, index) => ({
            title: String(section?.title || `Section ${index + 1}`).trim().slice(0, 90),
            body: String(section?.body || '').trim().slice(0, 3000)
        }))
        .filter(section => section.title && section.body)
        .slice(0, 24);
}

function getStaffRoleGroups() {
    const merge = (base, envName) => Array.from(new Set([
        ...base,
        ...parseRoleIdList(process.env[envName] || '')
    ]));
    return {
        executive: merge(STAFF_ROLE_GROUPS.executive, 'STAFF_EXECUTIVE_ROLE_IDS'),
        supportOperations: merge(STAFF_ROLE_GROUPS.supportOperations, 'STAFF_SUPPORT_ROLE_IDS'),
        qualityAssurance: merge(STAFF_ROLE_GROUPS.qualityAssurance, 'STAFF_QA_ROLE_IDS'),
        communityManagement: merge(STAFF_ROLE_GROUPS.communityManagement, 'STAFF_COMMUNITY_ROLE_IDS')
    };
}

function resolveStaffCapabilities(matchedRoleIds = [], isOwner = false) {
    const groups = getStaffRoleGroups();
    const hasExecutive = isOwner || matchedRoleIds.some(id => groups.executive.includes(id));
    const hasSupportOperations = hasExecutive || matchedRoleIds.some(id => groups.supportOperations.includes(id));
    const hasQualityAssurance = hasExecutive || matchedRoleIds.some(id => groups.qualityAssurance.includes(id));
    const hasCommunityManagement = hasExecutive || matchedRoleIds.some(id => groups.communityManagement.includes(id));
    return {
        roleFamilies: [
            hasSupportOperations ? 'Support Operations' : '',
            hasQualityAssurance ? 'Quality Assurance' : '',
            hasCommunityManagement ? 'Community Management' : ''
        ].filter(Boolean),
        canViewConfiguration: hasSupportOperations || hasExecutive,
        canViewStatistics: hasSupportOperations || hasQualityAssurance || hasExecutive,
        canViewErrors: hasSupportOperations || hasExecutive,
        canSyncPermissions: hasSupportOperations || hasExecutive,
        canRestartSystems: hasSupportOperations || hasExecutive,
        canRepairChannels: hasSupportOperations || hasExecutive,
        canViewAuditLogs: hasSupportOperations || hasQualityAssurance || hasExecutive,
        canManageModules: hasSupportOperations || hasExecutive,
        canRunDiagnostics: hasSupportOperations || hasExecutive,
        canViewTranscripts: hasSupportOperations || hasQualityAssurance || hasExecutive,
        canReviewSupport: hasSupportOperations || hasQualityAssurance || hasExecutive,
        canGenerateReports: hasSupportOperations || hasQualityAssurance || hasExecutive,
        canContactOwners: hasCommunityManagement || hasExecutive,
        canSendAnnouncements: hasCommunityManagement || hasExecutive,
        canViewHealth: hasCommunityManagement || hasSupportOperations || hasQualityAssurance || hasExecutive,
        canManageOnboarding: hasCommunityManagement || hasExecutive,
        canCreateInvite: hasCommunityManagement || hasSupportOperations || hasExecutive,
        canRemoveBot: hasSupportOperations || hasExecutive
    };
}

function getStaffPermissionMatrix() {
    const groups = getStaffRoleGroups();
    return [
        {
            key: 'executive',
            name: 'Executive',
            roleIds: groups.executive,
            permissions: resolveStaffCapabilities(groups.executive, true)
        },
        {
            key: 'supportOperations',
            name: 'Support Operations',
            roleIds: groups.supportOperations,
            permissions: resolveStaffCapabilities(groups.supportOperations, false)
        },
        {
            key: 'qualityAssurance',
            name: 'Quality Assurance',
            roleIds: groups.qualityAssurance,
            permissions: resolveStaffCapabilities(groups.qualityAssurance, false)
        },
        {
            key: 'communityManagement',
            name: 'Community Management',
            roleIds: groups.communityManagement,
            permissions: resolveStaffCapabilities(groups.communityManagement, false)
        }
    ];
}

async function getSeniorStaffAccess(client, req) {
    if (isStrictOwnerViewer(req)) {
        return {
            allowed: true,
            isOwner: true,
            userId: getDashboardSessionUserId(req),
            guildId: STAFF_COMMUNITY_GUILD_ID,
            matchedRoleIds: getSeniorStaffRoleIds(),
            capabilities: resolveStaffCapabilities(getSeniorStaffRoleIds(), true)
        };
    }

    const userId = getDashboardSessionUserId(req);
    if (!userId) {
        return { allowed: false, isOwner: false, userId: null, guildId: STAFF_COMMUNITY_GUILD_ID, matchedRoleIds: [] };
    }

    const guild = client?.guilds?.cache?.get(STAFF_COMMUNITY_GUILD_ID)
        || await client?.guilds?.fetch?.(STAFF_COMMUNITY_GUILD_ID).catch(() => null);
    if (!guild) {
        return { allowed: false, isOwner: false, userId, guildId: STAFF_COMMUNITY_GUILD_ID, matchedRoleIds: [] };
    }

    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
    if (!member) {
        return { allowed: false, isOwner: false, userId, guildId: STAFF_COMMUNITY_GUILD_ID, matchedRoleIds: [] };
    }

    const matchedRoleIds = getSeniorStaffRoleIds().filter(roleId => member.roles?.cache?.has?.(roleId));
    return {
        allowed: matchedRoleIds.length > 0,
        isOwner: false,
        userId,
        guildId: STAFF_COMMUNITY_GUILD_ID,
        matchedRoleIds,
        capabilities: resolveStaffCapabilities(matchedRoleIds, false)
    };
}

function isStrictOwnerViewer(req) {
    const ownerToken = String(getDashboardOwnerToken() || '').trim();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;
    if (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken)) return true;
    return isBotOwnerUser(req);
}

function cookieAttributes(options = {}) {
    const parts = [];
    if (options.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`Path=${options.path || '/'}`);
    parts.push(`SameSite=${options.sameSite || 'Lax'}`);
    if (options.secure) parts.push('Secure');
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
    return parts.join('; ');
}

function appendSetCookie(res, cookie) {
    try {
        const existing = res.getHeader('Set-Cookie');
        if (!existing) {
            res.setHeader('Set-Cookie', cookie);
            return;
        }
        if (Array.isArray(existing)) {
            res.setHeader('Set-Cookie', [...existing, cookie]);
            return;
        }
        res.setHeader('Set-Cookie', [String(existing), cookie]);
    } catch {}
}

function isHttpsPublicBaseUrl() {
    const base = String(getPublicBaseUrl() || '').toLowerCase();
    return base.startsWith('https://');
}

function setTranscriptSession(res, userId) {
    const sessionId = randomToken();
    transcriptSessions.set(sessionId, { userId: String(userId), createdAt: Date.now() });
    const secure = isHttpsPublicBaseUrl();
    const cookie = `${TRANSCRIPT_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieAttributes({
        maxAge: Math.floor(TRANSCRIPT_SESSION_TTL_MS / 1000),
        secure,
        sameSite: secure ? 'None' : 'Lax'
    })}`;
    appendSetCookie(res, cookie);
    return sessionId;
}

function clearTranscriptSession(res) {
    const secure = isHttpsPublicBaseUrl();
    const cookie = `${TRANSCRIPT_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure, sameSite: secure ? 'None' : 'Lax' })}`;
    appendSetCookie(res, cookie);
}

function getTranscriptSessionUserId(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const sessionId = String(cookies[TRANSCRIPT_SESSION_COOKIE] || '').trim();
    if (!sessionId) return null;
    const entry = transcriptSessions.get(sessionId);
    if (!entry) return null;
    const createdAt = Number(entry.createdAt || 0);
    if (!createdAt || (Date.now() - createdAt) > TRANSCRIPT_SESSION_TTL_MS) {
        transcriptSessions.delete(sessionId);
        return null;
    }
    return String(entry.userId || '').trim() || null;
}

function setDashboardSession(res, userId, guildIds = [], oauthGuilds = []) {
    const sessionId = randomToken();
    const allowedGuildIds = [...new Set(Array.isArray(guildIds) ? guildIds.map(String).filter(id => /^\d{17,20}$/.test(id)) : [])];
    const entry = {
        userId: String(userId),
        csrfToken: randomToken(18),
        guildIds: allowedGuildIds,
        oauthGuilds: Array.isArray(oauthGuilds)
            ? oauthGuilds.map(g => ({
                id: String(g?.id || '').trim(),
                name: String(g?.name || '').trim(),
                icon: String(g?.icon || '').trim() || null,
                owner: Boolean(g?.owner),
                permissions: String(g?.permissions || '0').trim() || '0'
            })).filter(g => /^\d{17,20}$/.test(g.id) && (!allowedGuildIds.length || allowedGuildIds.includes(g.id)))
            : [],
        createdAt: Date.now()
    };
    const cookieValue = createDashboardSessionCookieValue(entry) || sessionId;
    dashboardSessions.set(sessionId, entry);
    dashboardSessions.set(cookieValue, entry);
    const secure = isHttpsPublicBaseUrl();
    const cookie = `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(cookieValue)}; ${cookieAttributes({
        maxAge: Math.floor(DASHBOARD_SESSION_TTL_MS / 1000),
        secure,
        sameSite: secure ? 'None' : 'Lax'
    })}`;
    appendSetCookie(res, cookie);
    return sessionId;
}

function clearDashboardSession(res) {
    const secure = isHttpsPublicBaseUrl();
    const cookie = `${DASHBOARD_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure, sameSite: secure ? 'None' : 'Lax' })}`;
    appendSetCookie(res, cookie);
}

function getDashboardSession(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const sessionId = String(cookies[DASHBOARD_SESSION_COOKIE] || '').trim();
    if (!sessionId) return null;
    let entry = dashboardSessions.get(sessionId);
    if (!entry) {
        entry = parseDashboardSessionCookieValue(sessionId);
        if (entry) dashboardSessions.set(sessionId, entry);
    }
    if (!entry) return null;
    const createdAt = Number(entry.createdAt || 0);
    if (!createdAt || (Date.now() - createdAt) > DASHBOARD_SESSION_TTL_MS) {
        dashboardSessions.delete(sessionId);
        return null;
    }
    if (!entry.csrfToken) {
        entry.csrfToken = randomToken(18);
        dashboardSessions.set(sessionId, entry);
    }
    entry.lastSeenAt = new Date().toISOString();
    dashboardSessions.set(sessionId, entry);
    return entry && typeof entry === 'object' ? entry : null;
}

function getDashboardSessionUserId(req) {
    const entry = getDashboardSession(req);
    return String(entry?.userId || '').trim() || null;
}

function getDashboardSessionGuildIds(req) {
    const entry = getDashboardSession(req);
    const list = Array.isArray(entry?.guildIds) ? entry.guildIds.map(String) : [];
    return [...new Set(list.filter(id => /^\d{17,20}$/.test(id)))];
}

function getDashboardSessionOauthGuilds(req) {
    const entry = getDashboardSession(req);
    const guilds = Array.isArray(entry?.oauthGuilds) ? entry.oauthGuilds : [];
    return guilds
        .map(g => ({
            id: String(g?.id || '').trim(),
            name: String(g?.name || '').trim(),
            icon: String(g?.icon || '').trim() || null,
            owner: Boolean(g?.owner),
            permissions: String(g?.permissions || '0').trim() || '0'
        }))
        .filter(g => /^\d{17,20}$/.test(g.id));
}

function getDashboardSessionCsrfToken(req) {
    const entry = getDashboardSession(req);
    return String(entry?.csrfToken || '').trim() || null;
}

function hasDashboardTokenAuth(req) {
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;
    const dashboardToken = getDashboardToken();
    const ownerToken = getDashboardOwnerToken();
    return Boolean(
        (dashboardToken && (headerToken === dashboardToken || cookieToken === dashboardToken))
        || (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken))
    );
}

function assertDashboardCsrf(req) {
    if (hasDashboardTokenAuth(req)) return true;
    const expected = getDashboardSessionCsrfToken(req);
    if (!expected) return false;
    const headerValue = req?.headers?.['x-csrf-token'];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return String(provided || '').trim() === expected;
}

function getGuildAiUiState(guildId, storage = null) {
    const access = ticketStore.getEffectiveGuildAiAccess(guildId, storage);
    const customBot = access.customBot && typeof access.customBot === 'object' ? access.customBot : {};
    const trialEndsAtMs = Date.parse(access.trialEndsAt || '');
    const trialRemainingMs = access.trialActive && !Number.isNaN(trialEndsAtMs)
        ? Math.max(0, trialEndsAtMs - Date.now())
        : 0;
    const trialRemainingDays = trialRemainingMs
        ? Math.max(0, Math.ceil(trialRemainingMs / (24 * 60 * 60 * 1000)))
        : 0;
    const planLabel = access.plan === 'custom' || access.plan === 'custom_trial'
        ? 'Custom'
        : access.plan === 'pro' || access.plan === 'pro_trial'
        ? 'Pro'
        : access.plan === 'plus' || access.plan === 'plus_trial' || access.plan === 'premium'
            ? 'Plus'
            : access.plan === 'trial'
                ? 'AI'
                : 'Free';
    return {
        ...access,
        statusLabel: access.premiumActive
            ? `${planLabel} active`
            : access.trialActive
                ? `${planLabel} trial active - ${trialRemainingDays} day${trialRemainingDays === 1 ? '' : 's'} left`
                : access.expiredTrial
                    ? 'Trial expired'
                    : 'Free plan',
        planLabel,
        trialRemainingDays,
        isPlusOrHigher: ['premium', 'plus', 'pro', 'custom', 'plus_trial', 'pro_trial', 'custom_trial'].includes(access.plan) && access.hasAccess,
        isProOrHigher: ['pro', 'custom', 'pro_trial', 'custom_trial'].includes(access.plan) && access.hasAccess,
        isCustom: ['custom', 'custom_trial'].includes(access.plan) && access.hasAccess,
        customBot: {
            enabled: Boolean(String(customBot.token || '').trim()) && customBot.enabled !== false,
            botName: String(customBot.botName || ''),
            avatarUrl: String(customBot.avatarUrl || ''),
            appId: String(customBot.appId || ''),
            publicKey: String(customBot.publicKey || ''),
            statusText: String(customBot.statusText || ''),
            tokenConfigured: Boolean(String(customBot.token || '').trim()),
            runtimeStatus: String(customBot.runtimeStatus || ''),
            lastStartedAt: customBot.lastStartedAt || null,
            lastCommandSyncAt: customBot.lastCommandSyncAt || null,
            lastCommandSyncCount: Number(customBot.lastCommandSyncCount || 0),
            lastError: customBot.lastError || null
        }
    };
}

function summarizeOauthGuildPermissions(guild) {
    let permissions = 0n;
    try { permissions = BigInt(String(guild?.permissions || '0').trim() || '0'); } catch {}
    const isOwner = Boolean(guild?.owner);
    const isAdmin = (permissions & BigInt(PermissionsBitField.Flags.Administrator)) === BigInt(PermissionsBitField.Flags.Administrator);
    const canManageGuild = isOwner || isAdmin || ((permissions & BigInt(PermissionsBitField.Flags.ManageGuild)) === BigInt(PermissionsBitField.Flags.ManageGuild));
    const canManageChannels = isOwner || isAdmin || ((permissions & BigInt(PermissionsBitField.Flags.ManageChannels)) === BigInt(PermissionsBitField.Flags.ManageChannels));
    const permissionSummary = [];
    if (isOwner) permissionSummary.push('Server owner');
    if (isAdmin) permissionSummary.push('Administrator');
    if (!isAdmin && canManageGuild) permissionSummary.push('Manage Server');
    if (!isAdmin && !canManageGuild && canManageChannels) permissionSummary.push('Manage Channels');
    if (!permissionSummary.length) permissionSummary.push('No elevated permissions');

    return {
        isOwner,
        isAdmin,
        canManageGuild,
        canManageChannels,
        permissionSummary,
        canAccessDashboard: isOwner || isAdmin || canManageGuild
    };
}

function getDashboardOauthPermissionSummary(req, guildId) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return null;
    const entry = getDashboardSessionOauthGuilds(req).find(g => String(g?.id || '') === id);
    if (!entry) return null;
    return summarizeOauthGuildPermissions(entry);
}

function getGuildSupportRoleIds(guildId, storage = null) {
    const teams = ticketStore.getSupportTeamsForGuild(guildId, storage);
    const ids = [];
    for (const team of teams) {
        ids.push(...ticketStore.getSupportTeamRoleIds(team));
    }
    return [...new Set(ids.filter(id => /^\d{17,20}$/.test(String(id || ''))))];
}

async function getDashboardAccess(client, req, guildId = null) {
    const id = String(guildId || getDashboardGuild(client, req)?.id || '').trim();
    const ownerView = isStrictOwnerViewer(req);
    if (ownerView) {
        return {
            guildId: id || null,
            level: 'owner',
            isOwner: true,
            isManager: true,
            isStaff: true,
            canFullDashboard: true,
            canManageSettings: true,
            canManageAvailability: true,
            canManageTicketTypes: true,
            canManageEscalations: true,
            canViewTickets: true,
            canEditNotes: true,
            canViewTranscripts: true,
            canCloseTickets: true
        };
    }

    const userId = getDashboardSessionUserId(req);
    if (!userId || !id || !client?.guilds?.cache?.has?.(id)) {
        return {
            guildId: id || null,
            level: 'none',
            isOwner: false,
            isManager: false,
            isStaff: false,
            canFullDashboard: false,
            canManageSettings: false,
            canManageAvailability: false,
            canManageTicketTypes: false,
            canManageEscalations: false,
            canViewTickets: false,
            canEditNotes: false,
            canViewTranscripts: false,
            canCloseTickets: false
        };
    }

    const guild = client.guilds.cache.get(id);
    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
    if (!member) {
        const oauthPerms = getDashboardOauthPermissionSummary(req, id);
        if (oauthPerms?.canAccessDashboard) {
            return {
                guildId: id,
                level: oauthPerms.isOwner ? 'guild-owner' : 'manager',
                isOwner: Boolean(oauthPerms.isOwner),
                isManager: true,
                isStaff: true,
                canFullDashboard: Boolean(oauthPerms.isOwner),
                canManageSettings: true,
                canManageAvailability: true,
                canManageTicketTypes: true,
                canManageEscalations: true,
                canViewTickets: true,
                canEditNotes: true,
                canViewTranscripts: true,
                canCloseTickets: true
            };
        }

        return {
            guildId: id,
            level: 'none',
            isOwner: false,
            isManager: false,
            isStaff: false,
            canFullDashboard: false,
            canManageSettings: false,
            canManageAvailability: false,
            canManageTicketTypes: false,
            canManageEscalations: false,
            canViewTickets: false,
            canEditNotes: false,
            canViewTranscripts: false,
            canCloseTickets: false
        };
    }

    const storage = ticketStore.getActiveStorage();
    const guildConfig = ticketStore.getGuildConfig(id, storage);
    const managerRoleId = String(guildConfig?.managerRoleId || '').trim();
    const supportRoleIds = getGuildSupportRoleIds(id, storage);
    const isGuildOwner = String(guild?.ownerId || '') === String(userId);
    const adminLike = Boolean(
        isGuildOwner ||
        member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild) ||
        member.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
        getDashboardOauthPermissionSummary(req, id)?.canAccessDashboard
    );
    const isManager = adminLike || (managerRoleId && member.roles?.cache?.has?.(managerRoleId));
    const isStaff = isManager || supportRoleIds.some(roleId => member.roles?.cache?.has?.(roleId));

    return {
        guildId: id,
        level: isGuildOwner ? 'guild-owner' : (isManager ? 'manager' : (isStaff ? 'staff' : 'none')),
        isOwner: isGuildOwner,
        isManager,
        isStaff,
        canFullDashboard: isGuildOwner,
        canManageSettings: isManager,
        canManageAvailability: isManager,
        canManageTicketTypes: isManager,
        canManageEscalations: isStaff,
        canViewTickets: isStaff,
        canEditNotes: isStaff,
        canViewTranscripts: isStaff,
        canCloseTickets: isStaff
    };
}

async function ensureDashboardPermission(client, req, guildId, permission) {
    const access = await getDashboardAccess(client, req, guildId);
    return Boolean(access && access[permission]);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        if (!req || typeof req.on !== 'function') return resolve({});
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > 1500000) return reject(new Error('Body too large'));
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function sanitizeRoleIds(input) {
    const list = Array.isArray(input) ? input : [input];
    return [...new Set(list.map(v => String(v || '').trim()).filter(v => /^\d{17,20}$/.test(v)))];
}

function sanitizeList(input) {
    if (Array.isArray(input)) return [...new Set(input.map(v => String(v || '').trim()).filter(Boolean))];
    return [...new Set(String(input || '').split(/[\n,]+/).map(v => v.trim()).filter(Boolean))];
}

function sanitizeUrlList(input, max = 6) {
    const list = sanitizeList(input)
        .map(v => String(v || '').trim())
        .filter(v => /^https?:\/\//i.test(v));
    return list.slice(0, Math.max(0, Number(max) || 0));
}

function getDashboardGuild(client, req = null) {
    const cookies = parseCookies(req?.headers?.cookie);
    const cookieGuildId = String(cookies.dashboard_guild || '').trim();
    const userId = getDashboardSessionUserId(req);
    const ownerId = getBotOwnerId();

    let allowedGuildIds = null; // null = all guilds
    if (userId && client?.guilds?.cache) {
        if (ownerId && userId === ownerId) {
            allowedGuildIds = [...client.guilds.cache.keys()];
        } else {
            allowedGuildIds = getDashboardSessionGuildIds(req).filter(id => client.guilds.cache.has(id));
        }
    }

    if (cookieGuildId && client.guilds.cache.has(cookieGuildId)) {
        if (!Array.isArray(allowedGuildIds) || allowedGuildIds.includes(cookieGuildId)) {
            return client.guilds.cache.get(cookieGuildId);
        }
    }

    if (Array.isArray(allowedGuildIds) && allowedGuildIds.length) {
        const oauthAccess = getDashboardSessionOauthGuilds(req)
            .filter(entry => allowedGuildIds.includes(String(entry?.id || '')))
            .find(entry => summarizeOauthGuildPermissions(entry).canAccessDashboard);
        const fallbackId = String(oauthAccess?.id || allowedGuildIds[0] || '').trim();
        return client.guilds.cache.get(fallbackId) || null;
    }

    return client.guilds.cache.first() || null;
}

function canManageGuild(client, req, guildId) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return false;
    if (!client?.guilds?.cache?.has?.(id)) return false;

    // Token-based dashboard auth (DASHBOARD_TOKEN / DASHBOARD_OWNER_TOKEN) is treated as global admin.
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;
    const dashboardToken = getDashboardToken();
    const ownerToken = getDashboardOwnerToken();
    const tokenOk =
        (dashboardToken && (headerToken === dashboardToken || cookieToken === dashboardToken)) ||
        (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken));
    if (tokenOk) return true;

    const userId = getDashboardSessionUserId(req);
    if (!userId) return false;
    const ownerId = getBotOwnerId();
    if (ownerId && userId === ownerId) return true;
    return getDashboardSessionGuildIds(req).includes(id);
}

async function getCachedGuildCatalog(guild, kind, loader) {
    const guildId = String(guild?.id || '').trim();
    if (!guildId) return [];
    const key = `${guildId}:${kind}`;
    const now = Date.now();
    const cached = guildCatalogCache.get(key);
    if (cached && (now - cached.createdAt) < GUILD_CATALOG_CACHE_TTL_MS) return cached.value;
    const value = await loader();
    guildCatalogCache.set(key, { createdAt: now, value });
    return value;
}

function getBotGuildMember(guild) {
    return guild?.members?.me || guild?.members?.cache?.get?.(guild?.client?.user?.id) || null;
}

function getStaffAuditLog(storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    if (!Array.isArray(botConfig.staffAuditLog)) botConfig.staffAuditLog = [];
    return botConfig.staffAuditLog;
}

function appendStaffAuditLog(entry, storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    const current = Array.isArray(botConfig.staffAuditLog) ? botConfig.staffAuditLog : [];
    botConfig.staffAuditLog = [...current, entry].slice(-300);
    if (typeof ticketStore.saveActiveStorage === 'function') ticketStore.saveActiveStorage(activeStorage);
    return botConfig.staffAuditLog;
}

function recordStaffAuditEvent(req, entry = {}, storage = null) {
    const item = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        userId: getDashboardSessionUserId(req) || null,
        ip: String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim() || null,
        ...entry
    };
    appendStaffAuditLog(item, storage);
    return item;
}

function recordDashboardApiRequest(req, pathname, startedAt, status = 200) {
    const item = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date(startedAt || Date.now()).toISOString(),
        method: String(req?.method || 'GET'),
        path: String(pathname || ''),
        status: Number(status || 0),
        durationMs: Math.max(0, Date.now() - Number(startedAt || Date.now())),
        userId: getDashboardSessionUserId(req) || null,
        ip: String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim() || null
    };
    dashboardApiRequests.push(item);
    while (dashboardApiRequests.length > 250) dashboardApiRequests.shift();
    return item;
}

function getDashboardViewerList() {
    const seen = new Map();
    for (const entry of dashboardSessions.values()) {
        const userId = String(entry?.userId || '').trim();
        if (!/^\d{17,20}$/.test(userId)) continue;
        const current = seen.get(userId);
        const lastSeenAt = String(entry?.lastSeenAt || entry?.createdAt || '').trim();
        if (!current || String(current.lastSeenAt || '') < lastSeenAt) {
            seen.set(userId, {
                userId,
                guildIds: Array.isArray(entry.guildIds) ? entry.guildIds : [],
                createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
                lastSeenAt
            });
        }
    }
    return [...seen.values()].sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))).slice(0, 50);
}

function enforceStaffRateLimit(req, actionKey, max = 8, windowMs = 60_000) {
    const userId = getDashboardSessionUserId(req) || 'anonymous';
    const key = `${userId}:${String(actionKey || 'staff')}`;
    const now = Date.now();
    const existing = staffActionRateLimits.get(key);
    const fresh = existing && (now - existing.startedAt) < windowMs ? existing : { startedAt: now, count: 0 };
    fresh.count += 1;
    staffActionRateLimits.set(key, fresh);
    return fresh.count <= max;
}

function describeGuildPermissionScan(guild) {
    const member = getBotGuildMember(guild);
    const permissions = member?.permissions;
    const missing = [];
    const required = [
        ['Manage Channels', PermissionsBitField.Flags.ManageChannels],
        ['Send Messages', PermissionsBitField.Flags.SendMessages],
        ['View Channel', PermissionsBitField.Flags.ViewChannel],
        ['Manage Webhooks', PermissionsBitField.Flags.ManageWebhooks],
        ['Read Message History', PermissionsBitField.Flags.ReadMessageHistory]
    ];
    for (const [label, flag] of required) {
        if (!permissions?.has?.(flag)) missing.push(label);
    }
    return missing;
}

function inspectGuildSystemHealth(guild, config = {}, storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const parentCategory = config?.parentCategoryId ? guild?.channels?.cache?.get?.(String(config.parentCategoryId)) : null;
    const feedbackChannel = config?.appealsChannelId ? guild?.channels?.cache?.get?.(String(config.appealsChannelId)) : null;
    const transcriptsChannel = config?.transcriptsChannelId ? guild?.channels?.cache?.get?.(String(config.transcriptsChannelId)) : null;
    const panelEntries = config?.panels && typeof config.panels === 'object' ? Object.entries(config.panels) : [];
    const missingPermissions = describeGuildPermissionScan(guild);
    const brokenPanels = panelEntries.filter(([channelId]) => !guild?.channels?.cache?.has?.(String(channelId)));
    const brokenChannels = [];
    if (config?.parentCategoryId && !parentCategory) brokenChannels.push('Ticket category missing');
    if (config?.appealsChannelId && !feedbackChannel) brokenChannels.push('Feedback channel missing');
    if (config?.transcriptsChannelId && !transcriptsChannel) brokenChannels.push('Transcripts channel missing');
    const botMember = getBotGuildMember(guild);
    const hierarchyConflict = Boolean(config?.managerRoleId && guild?.roles?.cache?.has?.(String(config.managerRoleId)) && botMember?.roles?.highest && guild.roles.cache.get(String(config.managerRoleId))?.position >= botMember.roles.highest.position);
    const activeTickets = (Array.isArray(activeStorage.tickets) ? activeStorage.tickets : []).filter(ticket => String(ticket?.guildId || '') === String(guild?.id || ''));
    const transcriptArchives = (Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : []).filter(item => String(item?.guildId || '') === String(guild?.id || ''));
    return {
        activeTickets: activeTickets.length,
        archivedTranscripts: transcriptArchives.length,
        panelCount: panelEntries.length,
        ticketPanelStatus: panelEntries.length ? (brokenPanels.length ? 'Needs repair' : 'Healthy') : 'No panels configured',
        transcriptStatus: config?.transcriptsChannelId ? (transcriptsChannel ? 'Configured' : 'Broken') : 'Not configured',
        feedbackStatus: config?.appealsChannelId ? (feedbackChannel ? 'Configured' : 'Broken') : 'Not configured',
        categoryStatus: config?.parentCategoryId ? (parentCategory ? 'Configured' : 'Broken') : 'Not configured',
        brokenChannels,
        brokenPanels: brokenPanels.map(([channelId]) => String(channelId)),
        missingPermissions,
        hierarchyConflict,
        webhookValidity: 'Unchecked',
        buttonIntegrity: brokenPanels.length ? 'Broken panel references found' : 'No broken panel references detected',
        failedAutomations: [],
        brokenOverwrites: []
    };
}

function getGuildEnabledModules(config = {}) {
    const modules = [];
    if (config?.parentCategoryId) modules.push('Ticket Categories');
    if (config?.appealsChannelId) modules.push('Feedback');
    if (config?.transcriptsChannelId) modules.push('Transcripts');
    if (config?.tutorialEnabled) modules.push('Tutorials');
    if (config?.rolePermanence !== false) modules.push('Role Permanence');
    if (config?.panelConfig && Object.keys(config.panelConfig).length) modules.push('Custom Panel Copy');
    return modules.length ? modules : ['Core Tickets'];
}

function getGuildRuntimeDiagnostics(client, guild, config = {}, storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    const guildAi = getGuildAiUiState(guild?.id || null, activeStorage);
    const auditLog = getStaffAuditLog(activeStorage).filter(item => String(item?.guildId || '') === String(guild?.id || '')).slice(-12).reverse();
    const recentErrors = auditLog.filter(item => item.status === 'error').slice(0, 12);
    const shardIds = Array.isArray(client?.shard?.ids) ? client.shard.ids : [];
    return {
        guildId: guild?.id || null,
        ownerId: guild?.ownerId || null,
        botJoinDate: getBotGuildMember(guild)?.joinedAt ? new Date(getBotGuildMember(guild).joinedAt).toISOString() : null,
        shardAssignment: shardIds.length ? `Shard ${shardIds.join(', ')}` : `Process ${process.pid}`,
        subscriptionPlan: guildAi.premiumActive ? `${guildAi.planLabel || 'Plus'} AI` : guildAi.trialActive ? `${guildAi.planLabel || 'AI'} Trial` : String(botConfig?.subscriptions?.[guild?.id]?.plan || botConfig?.defaultPlan || 'Free'),
        enabledModules: getGuildEnabledModules(config),
        apiLatencyMs: Number(client?.ws?.ping || 0),
        databaseLatencyMs: null,
        redisLatencyMs: null,
        commandFailures: recentErrors.length,
        cacheHealth: {
            channels: guild?.channels?.cache?.size || 0,
            roles: guild?.roles?.cache?.size || 0,
            membersCached: guild?.members?.cache?.size || 0
        },
        workerStatus: 'Primary worker online',
        lastErrors: recentErrors,
        auditLog
    };
}

async function getRoleCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    return getCachedGuildCatalog(guild, 'roles', async () => {
        await guild.roles.fetch();
        return guild.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor && r.hexColor !== '#000000' ? r.hexColor : '#99AAB5' }));
    });
}

async function getTextChannelCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    return getCachedGuildCatalog(guild, 'channels', async () => {
        await guild.channels.fetch();
        return guild.channels.cache
            .filter(ch => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !ch.isThread())
            .sort((a, b) => {
                const posA = Number(a.rawPosition || 0);
                const posB = Number(b.rawPosition || 0);
                if (posA !== posB) return posA - posB;
                return String(a.name || '').localeCompare(String(b.name || ''));
            })
            .map(ch => ({ id: ch.id, name: ch.name || 'unnamed-channel', type: 'text' }));
    });
}

async function getCategoryCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    return getCachedGuildCatalog(guild, 'categories', async () => {
        await guild.channels.fetch();
        return guild.channels.cache
            .filter(ch => ch && ch.type === ChannelType.GuildCategory)
            .sort((a, b) => {
                const posA = Number(a.rawPosition || 0);
                const posB = Number(b.rawPosition || 0);
                if (posA !== posB) return posA - posB;
                return String(a.name || '').localeCompare(String(b.name || ''));
            })
            .map(ch => ({ id: ch.id, name: ch.name || 'unnamed-category', type: 'category' }));
    });
}

function summarizeStats(activeStorage, options = {}) {
    const guildId = options && options.guildId ? String(options.guildId) : null;
    const activeTickets = Number(options?.activeTickets || 0);
    const events = Array.isArray(activeStorage.staffStatsEvents) ? activeStorage.staffStatsEvents : [];
    const now = Date.now();
    const byDay = {};
    for (let i = 13; i >= 0; i -= 1) {
        const day = new Date(now - (i * 86400000)).toISOString().slice(0, 10);
        byDay[day] = { claimed: 0, closed: 0 };
    }
    let totalClaimed = 0;
    let totalClosed = 0;
    for (const event of events) {
        if (guildId && String(event?.guildId || '') !== guildId) continue;
        if (event?.createdBy && String(event.createdBy) === String(event.userId)) continue;
        const ts = Date.parse(event.createdAt || '');
        if (Number.isNaN(ts)) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        if (byDay[day]) {
            if (event.type === 'claimed') { byDay[day].claimed += 1; totalClaimed += 1; }
            if (event.type === 'closed') { byDay[day].closed += 1; totalClosed += 1; }
        }
    }
    return {
        totals: {
            activeTickets,
            totalClaimed,
            totalClosed
        },
        byDay,
        topCloseReasons: typeof ticketStore.getTopCloseRequestReasonsForGuild === 'function'
            ? ticketStore.getTopCloseRequestReasonsForGuild(30, guildId, null, 6, activeStorage)
            : ticketStore.getTopCloseRequestReasons(30, null, 6, activeStorage),
        tagUsage: Object.entries(options?.tagUsage || {}).map(([name, count]) => ({ name, count: Number(count || 0) })).sort((a, b) => b.count - a.count).slice(0, 8)
    };
}

async function getDashboardState(client, req = null) {
    const activeStorage = ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    const ownerView = isStrictOwnerViewer(req);
    const guild = getDashboardGuild(client, req);
    const access = await getDashboardAccess(client, req, guild?.id || null);
    if (guild) ticketStore.cleanupMissingTicketChannels(guild, activeStorage);
    const [roleCatalog, channelCatalog, categoryCatalog] = await Promise.all([
        getRoleCatalog(client, req),
        getTextChannelCatalog(client, req),
        getCategoryCatalog(client, req)
    ]);
    const guildId = guild?.id || null;
    const guildConfig = guildId ? ticketStore.getGuildConfig(guildId, activeStorage) : {};
    const aiAccess = guildId ? getGuildAiUiState(guildId, activeStorage) : getGuildAiUiState(null, activeStorage);
    const ticketTypes = ticketStore.getTicketTypesForGuild(guildId);
    const ticketPool = (Array.isArray(activeStorage.tickets) ? activeStorage.tickets : []);
    const tickets = (guild
        ? ticketPool.filter(t => {
            if (!t || !t.channelId) return false;
            if (String(t.guildId || '') === String(guildId)) return true;
            return !t.guildId && guild?.channels?.cache?.has?.(String(t.channelId));
        })
        : [])
        .slice(0, 250)
        .map(t => ({
            channelId: String(t.channelId || ''),
            channelName: guild?.channels?.cache?.get(t.channelId)?.name || null,
            ticketType: t.ticketType || null,
            createdBy: t.createdBy || null,
            claimedBy: t.claimedBy || null,
            createdAt: t.createdAt || null,
            lastActivityAt: t.lastActivityAt || null,
            escalations: Array.isArray(t.escalations) ? t.escalations : [],
            notes: ticketStore.getTicketNotes(String(t.channelId || ''), activeStorage)
        }));

    const transcriptRetentionDays = getTranscriptRetentionDays();
    const transcriptPool = (Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : []);
    const transcripts = (guildId
        ? transcriptPool.filter(t => String(t?.guildId || '') === String(guildId))
        : transcriptPool)
        .slice()
        .sort((a, b) => Date.parse(b?.archivedAt || b?.closedAt || 0) - Date.parse(a?.archivedAt || a?.closedAt || 0))
        .slice(0, 500)
        .map(t => ({
            channelId: String(t?.channelId || ''),
            channelName: t?.channelName || null,
            ticketType: t?.ticketType || null,
            createdBy: t?.createdBy || null,
            claimedBy: t?.claimedBy || null,
            closedBy: t?.closedBy || null,
            createdAt: t?.createdAt || null,
            closedAt: t?.closedAt || t?.archivedAt || null,
            archivedAt: t?.archivedAt || null,
            closeReason: t?.closeReason || null,
            fileName: t?.fileName || null,
            publicToken: t?.publicToken || null,
            size: typeof t?.size === 'number' ? t.size : null,
            escalations: Array.isArray(t?.escalations) ? t.escalations : [],
            notes: Array.isArray(t?.notes) ? t.notes : []
        }));
    return {
        guildId: guild?.id || null,
        publicBaseUrl: getPublicBaseUrl(),
        csrfToken: getDashboardSessionCsrfToken(req),
        access,
        aiAccess,
        ticketTypes,
        tickets,
        supportTeams: ticketStore.getSupportTeamsForGuild(guildId),
        tags: ticketStore.getTagsForGuild(guildId),
        roleCatalog,
        channelCatalog,
        categoryCatalog,
        statistics: summarizeStats(activeStorage, {
            guildId,
            activeTickets: tickets.length,
            tagUsage: typeof ticketStore.getTagUsageForGuild === 'function'
                ? ticketStore.getTagUsageForGuild(guildId, activeStorage)
                : (activeStorage.tagUsage || {})
        }),
        transcriptRetentionDays,
        transcripts,
        guildConfigSummary: {
            setup: guildConfig?.setup || {},
            tutorialEnabled: Boolean(guildConfig?.tutorialEnabled),
            rolePermanence: guildConfig?.rolePermanence !== false,
            branding: guildConfig?.branding && typeof guildConfig.branding === 'object' ? guildConfig.branding : {},
            panelConfig: guildConfig?.panelConfig && typeof guildConfig.panelConfig === 'object' ? guildConfig.panelConfig : {},
            panels: guildConfig?.panels && typeof guildConfig.panels === 'object' ? guildConfig.panels : {},
            escalationRoles: guildConfig?.escalationRoles && typeof guildConfig.escalationRoles === 'object' ? guildConfig.escalationRoles : {}
        },
        availability: ticketTypes.map(type => ({
            name: type.name,
            key: ticketStore.normalizeType(type.name),
            ...getEffectiveAvailability(activeStorage, type.name, guildId)
        })),
        botConfig: {
            appealsChannelId: guildConfig?.appealsChannelId || null,
            homeImages: ownerView && Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [],
            tutorials: normalizeTutorials(botConfig.tutorials),
            docsSections: normalizeDocSections(botConfig.docsSections),
            siteAnnouncement: normalizeSiteAnnouncement(botConfig.siteAnnouncement),
            embedTemplates: botConfig.embedTemplates && typeof botConfig.embedTemplates === 'object'
                ? botConfig.embedTemplates
                : DEFAULT_EMBED_TEMPLATES
        },
        ownerControls: ownerView && guildId ? {
            aiAccess
        } : null
    };
}

function summarizeSharedUserGuild(client, req, guild) {
    const oauthGuild = getDashboardSessionOauthGuilds(req).find(entry => String(entry?.id || '') === String(guild?.id || ''));
    const perms = oauthGuild ? summarizeOauthGuildPermissions(oauthGuild) : null;
    return {
        sharedWithUser: Boolean(oauthGuild),
        userPermissionSummary: perms?.permissionSummary?.join(', ') || '',
        canAccessDashboard: Boolean(guild) && Boolean(perms?.canAccessDashboard),
        canManageSetup: Boolean(guild) && Boolean(perms?.canAccessDashboard)
    };
}

async function buildStaffGuildList(client, req) {
    const activeStorage = ticketStore.getActiveStorage();
    const staffAccess = await getSeniorStaffAccess(client, req);
    const guilds = [...(client?.guilds?.cache?.values?.() || [])]
        .map(guild => {
            const cfg = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(guild.id, activeStorage) : {};
            const shared = summarizeSharedUserGuild(client, req, guild);
            const health = inspectGuildSystemHealth(guild, cfg, activeStorage);
            const runtime = getGuildRuntimeDiagnostics(client, guild, cfg, activeStorage);
            const highlights = [];
            if (shared.sharedWithUser && shared.userPermissionSummary) highlights.push(shared.userPermissionSummary);
            if (cfg?.managerRoleId) highlights.push('Manager role configured');
            if (cfg?.transcriptsChannelId) highlights.push('Transcript archive configured');
            if (!highlights.length) highlights.push('Ready for staff operations');
            return {
                id: guild.id,
                name: guild.name,
                memberCount: guild.memberCount ?? null,
                iconURL: typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 64 }) : null,
                setupCompleted: Boolean(cfg?.setup?.completed),
                setupStep: Number(cfg?.setup?.step || 1),
                ...shared,
                highlights,
                staffCapabilities: staffAccess.capabilities || {},
                basicInfo: {
                    guildId: guild.id,
                    ownerId: guild.ownerId || null,
                    botJoinDate: runtime.botJoinDate,
                    shardAssignment: runtime.shardAssignment,
                    subscriptionPlan: runtime.subscriptionPlan,
                    enabledModules: runtime.enabledModules
                },
                health,
                runtime,
                recentAuditLog: runtime.auditLog
            };
        })
        .sort((a, b) => {
            if (a.canAccessDashboard !== b.canAccessDashboard) return a.canAccessDashboard ? -1 : 1;
            if (a.setupCompleted !== b.setupCompleted) return a.setupCompleted ? -1 : 1;
            return String(a.name).localeCompare(String(b.name));
        });
    return guilds;
}

async function createGuildInviteForStaff(guild) {
    if (!guild) return null;
    await guild.channels.fetch().catch(() => null);
    const candidate = guild.channels.cache
        .filter(channel => channel && typeof channel.isTextBased === 'function' && channel.isTextBased() && !channel.isThread())
        .sort((a, b) => Number(a.rawPosition || 0) - Number(b.rawPosition || 0))
        .find(channel => {
            const perms = channel.permissionsFor?.(guild.members.me);
            return Boolean(perms?.has?.(PermissionsBitField.Flags.ViewChannel) && perms?.has?.(PermissionsBitField.Flags.CreateInstantInvite));
        });
    if (!candidate || typeof candidate.createInvite !== 'function') return null;
    return candidate.createInvite({
        maxAge: 60 * 60 * 24,
        maxUses: 0,
        unique: true,
        reason: 'Senior staff dashboard invite generation'
    }).catch(() => null);
}

async function requireStaffCapability(client, req, capabilityKey, actionKey, options = {}) {
    const staffAccess = await getSeniorStaffAccess(client, req);
    if (!staffAccess.allowed) return { ok: false, status: 403, error: 'Senior staff only' };
    const max = Number(options.max || 10);
    const windowMs = Number(options.windowMs || 60_000);
    if (!enforceStaffRateLimit(req, actionKey || capabilityKey || 'staff', max, windowMs)) {
        recordStaffAuditEvent(req, { action: actionKey || capabilityKey || 'staff', status: 'rate_limited', guildId: options.guildId || null });
        return { ok: false, status: 429, error: 'Too many staff actions right now. Please wait a moment and retry.' };
    }
    if (capabilityKey && !staffAccess.capabilities?.[capabilityKey]) {
        recordStaffAuditEvent(req, { action: actionKey || capabilityKey, status: 'forbidden', guildId: options.guildId || null });
        return { ok: false, status: 403, error: 'You do not have permission for this staff action.' };
    }
    return { ok: true, staffAccess };
}

async function syncGuildCategoryPermissions(guild, config = {}) {
    const parentId = String(config?.parentCategoryId || '').trim();
    if (!/^\d{17,20}$/.test(parentId)) return { ok: false, message: 'No ticket category is configured.' };
    await guild.channels.fetch().catch(() => null);
    const targets = guild.channels.cache.filter(channel => String(channel?.parentId || '') === parentId && typeof channel.lockPermissions === 'function');
    let synced = 0;
    for (const channel of targets.values()) {
        const done = await channel.lockPermissions().then(() => true).catch(() => false);
        if (done) synced += 1;
    }
    return { ok: true, message: synced ? `Synced permissions for ${synced} channel(s).` : 'No child channels were available to sync.' };
}

async function repairGuildChannels(guild, config = {}) {
    const created = [];
    const parentCategoryId = String(config?.parentCategoryId || '').trim();
    const feedbackExists = config?.appealsChannelId && guild.channels.cache.has(String(config.appealsChannelId));
    const transcriptsExists = config?.transcriptsChannelId && guild.channels.cache.has(String(config.transcriptsChannelId));
    const updates = {};
    if (!feedbackExists) {
        const channel = await guild.channels.create({
            name: 'ticket-feedback',
            type: ChannelType.GuildText,
            parent: /^\d{17,20}$/.test(parentCategoryId) ? parentCategoryId : null
        }).catch(() => null);
        if (channel) {
            updates.appealsChannelId = channel.id;
            created.push(`#${channel.name}`);
        }
    }
    if (!transcriptsExists) {
        const channel = await guild.channels.create({
            name: 'ticket-transcripts',
            type: ChannelType.GuildText,
            parent: /^\d{17,20}$/.test(parentCategoryId) ? parentCategoryId : null
        }).catch(() => null);
        if (channel) {
            updates.transcriptsChannelId = channel.id;
            created.push(`#${channel.name}`);
        }
    }
    if (Object.keys(updates).length && typeof ticketStore.setGuildConfig === 'function') {
        ticketStore.setGuildConfig(guild.id, updates, ticketStore.getActiveStorage());
    }
    return {
        ok: true,
        message: created.length ? `Created ${created.join(' and ')}.` : 'No repairable missing channels were found.',
        created
    };
}

async function handleApi(req, res, url, client, customBotManager = null) {
    const { pathname } = url;
    const method = req.method || 'GET';
    const startedAt = Date.now();
    const rawWriteHead = res.writeHead.bind(res);
    res.writeHead = (...args) => {
        try { if (pathname.startsWith('/api/')) recordDashboardApiRequest(req, pathname, startedAt, args[0]); } catch {}
        return rawWriteHead(...args);
    };

    if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        const dashboardToken = String(getDashboardToken() || '').trim();
        const ownerToken = String(getDashboardOwnerToken() || '').trim();
        const tokensConfigured = Boolean(dashboardToken || ownerToken);

        if (!tokensConfigured) {
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (token && (token === dashboardToken || token === ownerToken)) {
            sendJson(res, 200, { ok: true }, {
                'Set-Cookie': `dashboard_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`
            });
            return true;
        }

        sendJson(res, 401, { ok: false, error: 'Unauthorized token' });
        return true;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = [
            'dashboard_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
            `${DASHBOARD_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure: isHttpsPublicBaseUrl() })}`
        ];
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookies });
        return true;
    }

    if (!isAuthed(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return true;
    }

    if (method === 'POST' && !assertDashboardCsrf(req)) {
        sendJson(res, 403, { error: 'Security check failed. Refresh the dashboard and try again.' });
        return true;
    }

    if (method === 'POST' && pathname === '/api/dashboard/select-guild') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!client?.guilds?.cache?.has?.(guildId)) {
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }
        const userId = getDashboardSessionUserId(req);
        const ownerId = getBotOwnerId();
        const allowed = !userId || (ownerId && userId === ownerId) || getDashboardSessionGuildIds(req).includes(guildId);
        if (!allowed) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        appendSetCookie(res, `dashboard_guild=${encodeURIComponent(guildId)}; ${cookieAttributes({
            maxAge: 2592000,
            secure: isHttpsPublicBaseUrl()
        })}`);
        sendJson(res, 200, { ok: true, guildId });
        return true;
    }

    if (method === 'GET' && pathname === '/api/state') {
        const requestedId = String(url.searchParams.get('guild') || url.searchParams.get('guildId') || '').trim();
        const stateReq = /^\d{17,20}$/.test(requestedId)
            ? { ...req, headers: { ...(req?.headers || {}), cookie: `${req?.headers?.cookie || ''}; dashboard_guild=${requestedId}` } }
            : req;
        const state = await getDashboardState(client, stateReq);
        state.isOwner = isStrictOwnerViewer(req);
        sendJson(res, 200, state);
        return true;
    }

    if (method === 'GET' && pathname === '/api/my/guilds') {
        const userId = getDashboardSessionUserId(req);
        if (!userId) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return true;
        }

        const ownerId = getBotOwnerId();
        const allowedGuildIds = ownerId && userId === ownerId
            ? [...client.guilds.cache.keys()]
            : getDashboardSessionGuildIds(req);

        const guilds = allowedGuildIds
            .filter(id => client?.guilds?.cache?.has?.(id))
            .map(id => client.guilds.cache.get(id))
            .filter(Boolean)
            .map(g => ({
                id: g.id,
                name: g.name,
                memberCount: g.memberCount ?? null,
                iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        sendJson(res, 200, { guilds });
        return true;
    }

    if (method === 'GET' && pathname === '/api/dashboard/guilds') {
        const userId = getDashboardSessionUserId(req);
        if (!userId) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return true;
        }

        const ownerId = getBotOwnerId();
        const isOwner = Boolean(ownerId && userId === ownerId);
        let guilds = [];

        if (isOwner) {
            guilds = [...(client?.guilds?.cache?.values?.() || [])]
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    memberCount: g.memberCount ?? null,
                    iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null,
                    botInServer: true,
                    isOwner: true,
                    isAdmin: true,
                    canManageGuild: true,
                    canManageChannels: true,
                    canAccessDashboard: true,
                    inviteUrl: '',
                    permissionSummary: ['Bot owner']
                }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        } else {
            guilds = getDashboardSessionOauthGuilds(req)
                .map(entry => {
                    const sharedGuild = client?.guilds?.cache?.get(entry.id) || null;
                    const perms = summarizeOauthGuildPermissions(entry);
                    return {
                        id: entry.id,
                        name: entry.name || sharedGuild?.name || 'Unknown Server',
                        memberCount: sharedGuild?.memberCount ?? null,
                        iconURL: entry.icon
                            ? `https://cdn.discordapp.com/icons/${entry.id}/${entry.icon}.png?size=64`
                            : (typeof sharedGuild?.iconURL === 'function' ? sharedGuild.iconURL({ extension: 'png', size: 64 }) : null),
                        botInServer: Boolean(sharedGuild),
                        ...perms,
                        canAccessDashboard: Boolean(sharedGuild) && perms.canAccessDashboard,
                        inviteUrl: !sharedGuild && perms.canAccessDashboard ? getBotInviteUrl(entry.id) : ''
                    };
                })
                .sort((a, b) => {
                    if (a.botInServer !== b.botInServer) return a.botInServer ? -1 : 1;
                    if (a.canAccessDashboard !== b.canAccessDashboard) return a.canAccessDashboard ? -1 : 1;
                    return String(a.name).localeCompare(String(b.name));
                });
        }

        sendJson(res, 200, { guilds });
        return true;
    }

    if (method === 'GET' && pathname === '/api/controller/guilds') {
        if (!isBotOwnerUser(req)) {
            sendJson(res, 403, { error: 'Owner user only' });
            return true;
        }

        const guilds = client?.guilds?.cache
            ? [...client.guilds.cache.values()].map(g => {
                const activeStorage = ticketStore.getActiveStorage();
                const cfg = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(g.id, activeStorage) : {};
                return {
                    id: g.id,
                    name: g.name,
                    memberCount: g.memberCount ?? null,
                    iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null,
                    setupCompleted: Boolean(cfg?.setup?.completed),
                    setupStep: Number(cfg?.setup?.step || 1),
                    aiAccess: getGuildAiUiState(g.id, activeStorage)
                };
            }).sort((a, b) => String(a.name).localeCompare(String(b.name)))
            : [];

        sendJson(res, 200, { guilds, ownerId: getBotOwnerId() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/staff/guilds') {
        const gate = await requireStaffCapability(client, req, null, 'staff.guilds', { max: 30 });
        if (!gate.ok) {
            sendJson(res, gate.status, { error: gate.error });
            return true;
        }
        const guilds = await buildStaffGuildList(client, req);
        recordStaffAuditEvent(req, { action: 'staff.guilds', status: 'success' });
        sendJson(res, 200, {
            guilds,
            staffGuildId: STAFF_COMMUNITY_GUILD_ID,
            matchedRoleIds: gate.staffAccess.matchedRoleIds,
            capabilities: gate.staffAccess.capabilities,
            permissionMatrix: getStaffPermissionMatrix(),
            activeViewers: getDashboardViewerList(),
            apiRequests: dashboardApiRequests.slice(-40).reverse()
        });
        return true;
    }

    if (method === 'GET' && pathname === '/api/owner/activity') {
        if (!isStrictOwnerViewer(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const activeStorage = ticketStore.getActiveStorage();
        const staffAudit = getStaffAuditLog(activeStorage).slice(-100).reverse();
        const guilds = [...(client?.guilds?.cache?.values?.() || [])].map(guild => ({
            id: guild.id,
            name: guild.name,
            memberCount: guild.memberCount ?? null,
            iconURL: typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 64 }) : null,
            aiAccess: getGuildAiUiState(guild.id, activeStorage)
        })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, {
            guilds,
            staffGuildId: STAFF_COMMUNITY_GUILD_ID,
            permissionMatrix: getStaffPermissionMatrix(),
            botConfig: {
                homeImages: Array.isArray(activeStorage.botConfig?.homeImages) ? activeStorage.botConfig.homeImages : [],
                tutorials: normalizeTutorials(activeStorage.botConfig?.tutorials),
                docsSections: normalizeDocSections(activeStorage.botConfig?.docsSections),
                siteAnnouncement: normalizeSiteAnnouncement(activeStorage.botConfig?.siteAnnouncement)
            },
            activeViewers: getDashboardViewerList(),
            apiRequests: dashboardApiRequests.slice(-100).reverse(),
            staffAudit
        });
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/guild-invite') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const gate = await requireStaffCapability(client, req, 'canCreateInvite', 'staff.guild-invite', { guildId, max: 10 });
        if (!gate.ok) {
            sendJson(res, gate.status, { error: gate.error });
            return true;
        }
        if (!/^\d{17,20}$/.test(guildId)) {
            recordStaffAuditEvent(req, { action: 'staff.guild-invite', status: 'error', guildId, detail: 'Invalid guildId' });
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        const guild = client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch?.(guildId).catch(() => null);
        if (!guild) {
            recordStaffAuditEvent(req, { action: 'staff.guild-invite', status: 'error', guildId, detail: 'Guild not found' });
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }
        const invite = await createGuildInviteForStaff(guild);
        if (!invite?.url) {
            recordStaffAuditEvent(req, { action: 'staff.guild-invite', status: 'error', guildId, detail: 'Invite creation failed' });
            sendJson(res, 500, { error: 'Could not create an invite for that server. Check bot permissions.' });
            return true;
        }
        recordStaffAuditEvent(req, { action: 'staff.guild-invite', status: 'success', guildId, detail: invite.url });
        sendJson(res, 200, { ok: true, guildId, guildName: guild.name, inviteUrl: invite.url, code: invite.code || null });
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/guild-leave') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const gate = await requireStaffCapability(client, req, 'canRemoveBot', 'staff.guild-leave', { guildId, max: 4 });
        if (!gate.ok) {
            sendJson(res, gate.status, { error: gate.error });
            return true;
        }
        if (!/^\d{17,20}$/.test(guildId)) {
            recordStaffAuditEvent(req, { action: 'staff.guild-leave', status: 'error', guildId, detail: 'Invalid guildId' });
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        const guild = client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch?.(guildId).catch(() => null);
        if (!guild) {
            recordStaffAuditEvent(req, { action: 'staff.guild-leave', status: 'error', guildId, detail: 'Guild not found' });
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }
        const guildName = guild.name;
        const left = await guild.leave().then(() => true).catch(() => false);
        if (!left) {
            recordStaffAuditEvent(req, { action: 'staff.guild-leave', status: 'error', guildId, detail: 'Leave failed' });
            sendJson(res, 500, { error: 'The bot could not leave that server.' });
            return true;
        }
        recordStaffAuditEvent(req, { action: 'staff.guild-leave', status: 'success', guildId, detail: guildName });
        sendJson(res, 200, { ok: true, guildId, guildName });
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/guild-restart-setup') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const gate = await requireStaffCapability(client, req, 'canRestartSystems', 'staff.guild-restart-setup', { guildId, max: 5 });
        if (!gate.ok) {
            sendJson(res, gate.status, { error: gate.error });
            return true;
        }
        if (!/^\d{17,20}$/.test(guildId)) {
            recordStaffAuditEvent(req, { action: 'staff.guild-restart-setup', status: 'error', guildId, detail: 'Invalid guildId' });
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        const now = new Date().toISOString();
        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, { setup: { completed: false, restartedAt: now, restartedBy: getDashboardSessionUserId(req) || null } }, ticketStore.getActiveStorage())
            : null;
        recordStaffAuditEvent(req, { action: 'staff.guild-restart-setup', status: 'success', guildId });
        sendJson(res, 200, { ok: true, guildId, config: updated || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/guild-repair') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const repairAction = String(body.action || '').trim();
        const gate = await requireStaffCapability(client, req, repairAction === 'diagnostics' ? 'canRunDiagnostics' : 'canRepairChannels', `staff.guild-repair.${repairAction || 'unknown'}`, { guildId, max: 8 });
        if (!gate.ok) {
            sendJson(res, gate.status, { error: gate.error });
            return true;
        }
        const guild = client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch?.(guildId).catch(() => null);
        if (!guild) {
            recordStaffAuditEvent(req, { action: `staff.guild-repair.${repairAction}`, status: 'error', guildId, detail: 'Guild not found' });
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }
        const config = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(guildId, ticketStore.getActiveStorage()) : {};
        let result = null;
        if (repairAction === 'sync-permissions') result = await syncGuildCategoryPermissions(guild, config);
        else if (repairAction === 'repair-channels' || repairAction === 'repair-transcripts') result = await repairGuildChannels(guild, config);
        else if (repairAction === 'diagnostics') result = { ok: true, message: 'Diagnostics refreshed.', diagnostics: getGuildRuntimeDiagnostics(client, guild, config, ticketStore.getActiveStorage()) };
        else {
            recordStaffAuditEvent(req, { action: `staff.guild-repair.${repairAction}`, status: 'error', guildId, detail: 'Unsupported repair action' });
            sendJson(res, 400, { error: 'Unsupported repair action' });
            return true;
        }
        recordStaffAuditEvent(req, { action: `staff.guild-repair.${repairAction}`, status: result?.ok ? 'success' : 'error', guildId, detail: result?.message || '' });
        sendJson(res, 200, { ok: Boolean(result?.ok), guildId, result });
        return true;
    }

    if (method === 'GET' && pathname === '/api/guild-config') {
        const guildId = String(url.searchParams.get('guildId') || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const config = typeof ticketStore.getGuildConfig === 'function'
            ? ticketStore.getGuildConfig(guildId, ticketStore.getActiveStorage())
            : {};

        sendJson(res, 200, { guildId, config, access: await getDashboardAccess(client, req, guildId) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const activeStorage = ticketStore.getActiveStorage();
        const next = {};
        for (const key of ['parentCategoryId', 'appealsChannelId', 'transcriptsChannelId', 'managerRoleId']) {
            const value = String(body[key] || '').trim();
            if (value && !/^\d{17,20}$/.test(value)) {
                sendJson(res, 400, { error: `Invalid ${key}` });
                return true;
            }
            if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = value || null;
        }

        if (body.escalationRoles && typeof body.escalationRoles === 'object') {
            const escalationRoles = {};
            for (const key of ['high', 'immediate']) {
                const value = String(body.escalationRoles[key] || '').trim();
                if (value && !/^\d{17,20}$/.test(value)) {
                    sendJson(res, 400, { error: `Invalid escalationRoles.${key}` });
                    return true;
                }
                escalationRoles[key] = value || null;
            }
            next.escalationRoles = escalationRoles;
        }

        if (body.panelConfig && typeof body.panelConfig === 'object') {
            next.panelConfig = {
                title: String(body.panelConfig.title || '').trim().slice(0, 120),
                description: String(body.panelConfig.description || '').trim().slice(0, 4000),
                advisory: String(body.panelConfig.advisory || '').trim().slice(0, 4000),
                buttonLabel: String(body.panelConfig.buttonLabel || '').trim().slice(0, 80)
            };
        }

        if (body.branding && typeof body.branding === 'object') {
            const plan = getGuildAiUiState(guildId, activeStorage);
            if (!plan.isCustom) {
                sendJson(res, 403, { error: 'Custom branding requires the Custom plan.' });
                return true;
            }
            const accent = String(body.branding.accentColor || '').trim();
            next.branding = {
                botName: String(body.branding.botName || '').trim().slice(0, 80),
                avatarUrl: /^https?:\/\//i.test(String(body.branding.avatarUrl || '').trim()) ? String(body.branding.avatarUrl).trim().slice(0, 500) : '',
                accentColor: /^#?[0-9a-f]{6}$/i.test(accent) ? (accent.startsWith('#') ? accent : `#${accent}`) : '#5865F2',
                footerText: String(body.branding.footerText || '').trim().slice(0, 120)
            };
        }

        if (Object.prototype.hasOwnProperty.call(body, 'rolePermanence')) {
            next.rolePermanence = Boolean(body.rolePermanence);
        }

        if (Object.prototype.hasOwnProperty.call(body, 'tutorialEnabled')) {
            next.tutorialEnabled = Boolean(body.tutorialEnabled);
        }

        if (Object.prototype.hasOwnProperty.call(body, 'setupComplete')) {
            next.setup = {
                ...(body.setup && typeof body.setup === 'object' ? body.setup : {}),
                completed: Boolean(body.setupComplete),
                completedAt: Boolean(body.setupComplete) ? new Date().toISOString() : null
            };
        } else if (body.setup && typeof body.setup === 'object') {
            next.setup = { ...body.setup };
        }

        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, next, activeStorage)
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || next });
        return true;
    }

    if (method === 'POST' && pathname === '/api/panel/upsert') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const channelId = String(body.channelId || '').trim();
        if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid guildId or channelId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const mode = String(body.mode || 'multi').trim() === 'single' ? 'single' : 'multi';
        const ticketTypeInput = String(body.ticketType || '').trim();
        const activeStorage = ticketStore.getActiveStorage();
        const ticketType = ticketTypeInput ? ticketStore.resolveTicketTypeSelectValue(ticketTypeInput, guildId, activeStorage) : '';
        if (mode === 'single' && !ticketType) {
            sendJson(res, 400, { error: 'Single-panel mode needs a valid ticket type.' });
            return true;
        }

        const guildConfig = ticketStore.getGuildConfig(guildId, activeStorage);
        const panels = guildConfig.panels && typeof guildConfig.panels === 'object' ? guildConfig.panels : {};
        panels[channelId] = {
            ...(panels[channelId] && typeof panels[channelId] === 'object' ? panels[channelId] : {}),
            name: String(body.title || '').trim().slice(0, 120) || 'Support Desk',
            title: String(body.title || '').trim().slice(0, 120) || 'Support Desk',
            description: String(body.description || '').trim().slice(0, 4000),
            advisory: String(body.advisory || '').trim().slice(0, 4000),
            buttonLabel: String(body.buttonLabel || '').trim().slice(0, 80) || 'Select a prompt',
            mode,
            ticketType: mode === 'single' ? ticketType : null
        };

        if (mode === 'single') {
            ticketStore.setRestrictedTicketTypeForChannel(channelId, ticketType, activeStorage, guildId);
        } else {
            ticketStore.setRestrictedTicketTypeForChannel(channelId, null, activeStorage, guildId);
        }
        const updated = ticketStore.setGuildConfig(guildId, { panels }, activeStorage);
        sendJson(res, 200, { ok: true, guildId, panels: updated?.panels || panels });
        return true;
    }

    if (method === 'POST' && pathname === '/api/panel/publish') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const channelId = String(body.channelId || '').trim();
        if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid guildId or channelId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText || typeof channel.send !== 'function') {
            sendJson(res, 404, { error: 'Channel not found or not sendable.' });
            return true;
        }
        const me = channel.guild?.members?.me;
        if (me && !channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)) {
            sendJson(res, 403, { error: 'I cannot send messages in that channel.' });
            return true;
        }
        const fakeInteraction = {
            guildId,
            channelId,
            channel,
            user: { id: getDashboardSessionUserId(req) || getBotOwnerId() || 'dashboard' },
            reply: async () => null,
            editReply: async () => null,
            deferred: false,
            replied: false
        };
        await ticketHandler.createTicketPanel(fakeInteraction, { channel, notice: 'Ticket panel has been published from the dashboard.' });
        sendJson(res, 200, { ok: true, guildId, channelId });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config/init') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const activeStorage = ticketStore.getActiveStorage();
        const existingConfig = typeof ticketStore.getGuildConfig === 'function'
            ? ticketStore.getGuildConfig(guildId, activeStorage)
            : {};
        if (Boolean(existingConfig?.setup?.completed)) {
            sendJson(res, 409, { error: 'This server setup is already finished.' });
            return true;
        }
        const config = typeof ticketStore.bootstrapGuildConfig === 'function'
            ? ticketStore.bootstrapGuildConfig(guildId, { storage: activeStorage })
            : (typeof ticketStore.setGuildConfig === 'function' ? ticketStore.setGuildConfig(guildId, {}, activeStorage) : {});

        sendJson(res, 200, { ok: true, guildId, config: config || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config/restart') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const now = new Date().toISOString();
        const userId = getDashboardSessionUserId(req) || getBotOwnerId() || null;
        const activeStorage = ticketStore.getActiveStorage();
        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, { setup: { completed: false, restartedAt: now, restartedBy: userId } }, activeStorage)
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/controller/setup/restart') {
        if (!isBotOwnerUser(req)) {
            sendJson(res, 403, { error: 'Owner user only' });
            return true;
        }

        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }

        const now = new Date().toISOString();
        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, { setup: { completed: false, restartedAt: now, restartedBy: getBotOwnerId() } }, ticketStore.getActiveStorage())
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/setup/create-channel') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const guild = client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch?.(guildId).catch(() => null);
        if (!guild) {
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }

        const kind = String(body.kind || '').trim().toLowerCase();
        const requestedName = String(body.name || '').trim();
        const parentCategoryId = String(body.parentCategoryId || '').trim();
        const defaults = {
            category: 'Tickets',
            feedback: 'ticket-feedback',
            transcripts: 'ticket-transcripts'
        };
        if (!['category', 'feedback', 'transcripts'].includes(kind)) {
            sendJson(res, 400, { error: 'Invalid channel kind' });
            return true;
        }

        const safeName = (requestedName || defaults[kind])
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 90)
            .replace(/^-|-$/g, '') || defaults[kind].toLowerCase();

        const channel = await guild.channels.create({
            name: safeName,
            type: kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText,
            parent: kind === 'category' ? null : (/^\d{17,20}$/.test(parentCategoryId) ? parentCategoryId : null)
        }).catch(() => null);

        if (!channel) {
            sendJson(res, 500, { error: 'Failed to create channel. Check bot permissions.' });
            return true;
        }

        sendJson(res, 200, {
            ok: true,
            channel: {
                id: channel.id,
                name: channel.name,
                type: kind === 'category' ? 'category' : 'text'
            }
        });
        return true;
    }

    if (method === 'GET' && pathname === '/api/roles') {
        const requestedId = String(url.searchParams.get('guildId') || '').trim();
        const guildId = /^\d{17,20}$/.test(requestedId) ? requestedId : (getDashboardGuild(client, req)?.id || null);
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { roles: await getRoleCatalog(client, { ...req, headers: { ...(req?.headers || {}), cookie: `${req?.headers?.cookie || ''}; dashboard_guild=${guildId}` } }) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/channels') {
        const requestedId = String(url.searchParams.get('guildId') || '').trim();
        const guildId = /^\d{17,20}$/.test(requestedId) ? requestedId : (getDashboardGuild(client, req)?.id || null);
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { channels: await getTextChannelCatalog(client, { ...req, headers: { ...(req?.headers || {}), cookie: `${req?.headers?.cookie || ''}; dashboard_guild=${guildId}` } }) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/categories') {
        const requestedId = String(url.searchParams.get('guildId') || '').trim();
        const guildId = /^\d{17,20}$/.test(requestedId) ? requestedId : (getDashboardGuild(client, req)?.id || null);
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { categories: await getCategoryCatalog(client, { ...req, headers: { ...(req?.headers || {}), cookie: `${req?.headers?.cookie || ''}; dashboard_guild=${guildId}` } }) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/config') {
        const botConfig = ticketStore.getBotConfig();
        const ownerView = isStrictOwnerViewer(req);
        sendJson(res, 200, {
            appealsChannelId: botConfig.appealsChannelId || getDefaultAppealsChannelId(),
            homeImages: ownerView && Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [],
            tutorials: ownerView ? normalizeTutorials(botConfig.tutorials) : [],
            docsSections: ownerView ? normalizeDocSections(botConfig.docsSections) : [],
            siteAnnouncement: ownerView ? normalizeSiteAnnouncement(botConfig.siteAnnouncement) : normalizeSiteAnnouncement({}),
            embedTemplates: botConfig.embedTemplates && typeof botConfig.embedTemplates === 'object'
                ? botConfig.embedTemplates
                : DEFAULT_EMBED_TEMPLATES
        });
        return true;
    }

    if (method === 'POST' && pathname === '/api/config') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const appealsChannelId = String(body.appealsChannelId || '').trim();
        if (appealsChannelId && !/^\d{17,20}$/.test(appealsChannelId)) {
            sendJson(res, 400, { error: 'Invalid appeals channel id' });
            return true;
        }

        const homeImages = sanitizeUrlList(body.homeImages, 6);
        const next = { appealsChannelId: appealsChannelId || getDefaultAppealsChannelId() };
        if (homeImages.length) next.homeImages = homeImages;
        else if (body.homeImages) next.homeImages = [];
        if (Object.prototype.hasOwnProperty.call(body, 'tutorials')) next.tutorials = normalizeTutorials(body.tutorials);
        if (Object.prototype.hasOwnProperty.call(body, 'docsSections')) next.docsSections = normalizeDocSections(body.docsSections);
        if (Object.prototype.hasOwnProperty.call(body, 'siteAnnouncement')) next.siteAnnouncement = normalizeSiteAnnouncement(body.siteAnnouncement);

        const config = ticketStore.setBotConfig(next);
        sendJson(res, 200, { ok: true, config });
        return true;
    }

    if (method === 'POST' && pathname === '/api/config/embeds') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const nextTemplates = body?.embedTemplates;
        if (!nextTemplates || typeof nextTemplates !== 'object') {
            sendJson(res, 400, { error: 'embedTemplates object is required' });
            return true;
        }
        const config = ticketStore.setBotConfig({ embedTemplates: nextTemplates });
        sendJson(res, 200, { ok: true, config });
        return true;
    }

    if (method === 'POST' && pathname === '/api/owner/guild-ai') {
        if (!isStrictOwnerViewer(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        const action = String(body.action || '').trim().toLowerCase();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        const activeStorage = ticketStore.getActiveStorage();
        const current = ticketStore.getGuildAiAccess(guildId, activeStorage);
        const ownerId = getDashboardSessionUserId(req) || getBotOwnerId() || null;
        let nextPatch = {};

        if (action === 'start-trial') {
            const trialPlan = ['plus_trial', 'pro_trial', 'custom_trial', 'trial'].includes(String(body.plan || '').trim().toLowerCase())
                ? String(body.plan).trim().toLowerCase()
                : 'trial';
            const trialDays = Math.max(1, Math.min(30, Number(body.days || 7)));
            const startedAt = new Date().toISOString();
            const endsAt = new Date(Date.now() + (trialDays * 24 * 60 * 60 * 1000)).toISOString();
            nextPatch = {
            plan: trialPlan,
                enabled: true,
                trialStartedAt: startedAt,
                trialEndsAt: endsAt,
                notifiedTrialExpiredAt: null,
                grantedByOwnerId: ownerId,
                grantedAt: startedAt
            };
        } else if (action === 'set-premium' || action === 'set-plan') {
            const plan = ['plus', 'pro', 'custom', 'premium'].includes(String(body.plan || '').trim().toLowerCase())
                ? String(body.plan).trim().toLowerCase()
                : 'plus';
            const customBot = body.customBot && typeof body.customBot === 'object' ? {
                enabled: body.customBot.enabled === undefined ? current.customBot?.enabled !== false : body.customBot.enabled !== false,
                botName: String(current.customBot?.botName || '').trim().slice(0, 80),
                avatarUrl: String(current.customBot?.avatarUrl || '').trim().slice(0, 500),
                appId: String(body.customBot.appId || '').trim().slice(0, 30),
                publicKey: String(body.customBot.publicKey || '').trim().slice(0, 120),
                token: String(body.customBot.token || '').trim() || String(current.customBot?.token || '').trim(),
                statusText: String(current.customBot?.statusText || '').trim().slice(0, 120)
            } : current.customBot;
            nextPatch = {
                plan,
                enabled: true,
                trialStartedAt: current.trialStartedAt || null,
                trialEndsAt: null,
                notifiedTrialExpiredAt: null,
                grantedByOwnerId: ownerId,
                grantedAt: new Date().toISOString(),
                customBot: plan === 'custom' ? { ...customBot, enabled: customBot.enabled !== false } : current.customBot
            };
        } else if (action === 'custom-bot-toggle') {
            if (!['custom', 'custom_trial'].includes(current.plan)) {
                sendJson(res, 400, { error: 'Custom bot controls require the Custom plan' });
                return true;
            }
            if (body.enabled !== false && !String(current.customBot?.token || '').trim()) {
                sendJson(res, 400, { error: 'Save a branded bot token before turning it on.' });
                return true;
            }
            nextPatch = {
                customBot: {
                    ...(current.customBot && typeof current.customBot === 'object' ? current.customBot : {}),
                    enabled: body.enabled !== false
                }
            };
        } else if (action === 'custom-bot-sync') {
            if (!['custom', 'custom_trial'].includes(current.plan)) {
                sendJson(res, 400, { error: 'Custom bot controls require the Custom plan' });
                return true;
            }
            if (!String(current.customBot?.token || '').trim()) {
                sendJson(res, 400, { error: 'Save a branded bot token before syncing commands.' });
                return true;
            }
            nextPatch = {
                customBot: {
                    ...(current.customBot && typeof current.customBot === 'object' ? current.customBot : {}),
                    enabled: true,
                    lastCommandSyncRequestedAt: new Date().toISOString()
                }
            };
        } else if (action === 'disable') {
            nextPatch = { enabled: false };
        } else if (action === 'enable') {
            nextPatch = { enabled: true };
        } else if (action === 'clear') {
            nextPatch = {
                plan: 'none',
                enabled: false,
                trialStartedAt: null,
                trialEndsAt: null,
                notifiedTrialExpiredAt: null,
                grantedByOwnerId: ownerId,
                grantedAt: null,
                customBot: {}
            };
        } else {
            sendJson(res, 400, { error: 'Unsupported action' });
            return true;
        }

        const updated = ticketStore.setGuildAiAccess(guildId, nextPatch, activeStorage);
        if (customBotManager && typeof customBotManager.syncGuild === 'function') {
            customBotManager.syncGuild(guildId).catch(error => {
                console.error('[Custom Bot] Failed to sync branded bot after dashboard change:', error);
            });
        }
        sendJson(res, 200, { ok: true, guildId, aiAccess: getGuildAiUiState(guildId, activeStorage), raw: updated });
        return true;
    }

    if (method === 'POST' && pathname === '/api/availability') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageAvailability'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const ticketType = ticketStore.findTicketType(body.ticketType, guildId);
        const status = String(body.status || '').trim();
        const allowed = new Set(['available', 'increased_volume', 'reduced_assistance', 'auto']);
        if (!ticketType || !allowed.has(status)) {
            sendJson(res, 400, { error: 'Invalid ticket type or status' });
            return true;
        }
        const active = ticketStore.getActiveStorage();
        const key = ticketStore.normalizeType(ticketType.name);
        if (!guildId || ticketStore.isTestGuild?.(guildId)) {
            if (status === 'auto') {
                if (active.availabilityOverrides && typeof active.availabilityOverrides === 'object') delete active.availabilityOverrides[key];
            } else {
                if (!active.availabilityOverrides || typeof active.availabilityOverrides !== 'object') active.availabilityOverrides = {};
                active.availabilityOverrides[key] = status;
            }
            ticketStore.saveActiveStorage(active);
        } else {
            const cfg = ticketStore.getGuildConfig(guildId, active);
            const current = cfg?.availabilityOverrides && typeof cfg.availabilityOverrides === 'object' ? cfg.availabilityOverrides : {};
            const next = { ...current };
            if (status === 'auto') delete next[key];
            else next[key] = status;
            ticketStore.setGuildConfig(guildId, { availabilityOverrides: next }, active);
        }
        sendJson(res, 200, { ok: true, ticketType: ticketType.name, status });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket-type/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Ticket type name is required' });
            return true;
        }
        const categoryId = String(body.categoryId || '').trim();
        if (categoryId && !/^\d{17,20}$/.test(categoryId)) {
            sendJson(res, 400, { error: 'Invalid category id' });
            return true;
        }
        const roleIds = sanitizeRoleIds(body.roleIds);
        const nextType = {
            name,
            format: String(body.format || `#${ticketStore.toTicketSelectValue(name)}-{username}`).trim(),
            roleIds,
            aliases: sanitizeList(body.aliases),
            embedColor: String(body.embedColor || '#5865F2').trim(),
            emoji: String(body.emoji || '').trim(),
            requireReason: body.requireReason !== false,
            allowAttachments: body.allowAttachments !== false
        };
        if (categoryId) nextType.categoryId = categoryId;
        const openTitle = String(body.openTitle || '').trim();
        const openDescription = String(body.openDescription || '').trim();
        if (openTitle || openDescription) {
            nextType.openEmbed = {
                title: openTitle || '{ticketType}',
                description: openDescription || 'Requester: {requester}\\nReason: {reason}'
            };
        }
        const savedType = ticketStore.upsertTicketType(nextType, guildId);
        const existingTeam = ticketStore.findSupportTeamForTicketType(name, guildId);
        ticketStore.upsertSupportTeam({
            name,
            roleIds,
            roleId: roleIds[0] || null,
            emoji: existingTeam?.emoji || nextType.emoji
        }, guildId);
        sendJson(res, 200, { ok: true, ticketType: savedType });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket-type/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Ticket type name is required' });
            return true;
        }
        const removed = ticketStore.deleteTicketTypeByName(name, guildId);
        // Keep support teams in sync (teams are keyed by the same "name" label).
        ticketStore.deleteSupportTeamByName(name, guildId);

        const active = ticketStore.getActiveStorage();
        const key = ticketStore.normalizeType(name);
        if (!guildId || ticketStore.isTestGuild?.(guildId)) {
            if (active.availabilityOverrides && typeof active.availabilityOverrides === 'object') {
                delete active.availabilityOverrides[key];
                ticketStore.saveActiveStorage(active);
            }
        } else {
            const cfg = ticketStore.getGuildConfig(guildId, active);
            const current = cfg?.availabilityOverrides && typeof cfg.availabilityOverrides === 'object' ? cfg.availabilityOverrides : {};
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                const next = { ...current };
                delete next[key];
                ticketStore.setGuildConfig(guildId, { availabilityOverrides: next }, active);
            }
        }

        sendJson(res, 200, { ok: removed });
        return true;
    }

    if (method === 'POST' && pathname === '/api/support-team/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Support team name is required' });
            return true;
        }
        const supportTeam = ticketStore.upsertSupportTeam({
            name,
            roleIds: sanitizeRoleIds(body.roleIds),
            roleId: sanitizeRoleIds(body.roleIds)[0] || null,
            emoji: String(body.emoji || '').trim()
        }, guildId);
        sendJson(res, 200, { ok: true, supportTeam });
        return true;
    }

    if (method === 'POST' && pathname === '/api/support-team/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Support team name is required' });
            return true;
        }
        sendJson(res, 200, { ok: ticketStore.deleteSupportTeamByName(name, guildId) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tag/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Tag name is required' });
            return true;
        }
        const kindRaw = String(body.kind || 'suggestion').trim().toLowerCase();
        const kind = kindRaw === 'solution' ? 'solution' : 'suggestion';
        const existing = ticketStore.findTagByName(name, guildId);
        const tag = ticketStore.upsertTag({
            name,
            kind,
            title: String(body.title || name).trim(),
            description: String(body.description || '').trim(),
            keywords: sanitizeList(body.keywords),
            updatedAt: new Date().toISOString(),
            createdAt: existing?.createdAt || new Date().toISOString()
        }, guildId);
        sendJson(res, 200, { ok: true, tag });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tag/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Tag name is required' });
            return true;
        }
        sendJson(res, 200, { ok: ticketStore.deleteTagByName(name, guildId) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/close') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const reason = String(body.reason || 'Closed via dashboard.').trim();
        if (!/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid channel id' });
            return true;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            sendJson(res, 404, { error: 'Channel not found or not text based' });
            return true;
        }

        const guild = getDashboardGuild(client, req);
        if (guild && channel.guildId && String(channel.guildId) !== String(guild.id)) {
            sendJson(res, 403, { error: 'Channel does not belong to the selected dashboard guild' });
            return true;
        }

        if (!(await ensureDashboardPermission(client, req, channel.guildId || guild?.id || null, 'canCloseTickets'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        await closeRequestCommand.closeTicketWithTranscript(channel, reason, null);
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tickets/mass-close') {
        const body = await readBody(req);
        const rawType = String(body.ticketType || '').trim();
        const filterKey = ticketStore.normalizeType(rawType);
        const limit = Math.min(100, Math.max(1, Number(body.limit || 25)));
        const reason = String(body.reason || 'Mass closed via dashboard.').trim();

        const activeStorage = ticketStore.getActiveStorage();
        const guild = getDashboardGuild(client, req);
        if (!(await ensureDashboardPermission(client, req, guild?.id || null, 'canCloseTickets'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        if (guild) ticketStore.cleanupMissingTicketChannels(guild, activeStorage);

        const tickets = (Array.isArray(activeStorage.tickets) ? activeStorage.tickets : [])
            .filter(t => {
                if (!t || !t.channelId) return false;
                if (guild) {
                    if (t.guildId && String(t.guildId || '') !== String(guild.id)) return false;
                    if (!t.guildId && !guild?.channels?.cache?.has?.(String(t.channelId))) return false;
                }
                if (filterKey && ticketStore.normalizeType(t.ticketType) !== filterKey) return false;
                return true;
            })
            .slice(0, limit);

        let closed = 0;
        const failed = [];

        for (const ticket of tickets) {
            const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                failed.push({ channelId: ticket.channelId, error: 'Channel not found' });
                continue;
            }
            try {
                await closeRequestCommand.closeTicketWithTranscript(channel, reason, null);
                closed += 1;
            } catch (error) {
                failed.push({ channelId: ticket.channelId, error: String(error?.message || error) });
            }
            await new Promise(r => setTimeout(r, 350));
        }

        sendJson(res, 200, { ok: true, closed, failed });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/note') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const note = String(body.note || '').trim();
        if (!/^\d{17,20}$/.test(channelId) || !note) {
            sendJson(res, 400, { error: 'Valid channelId and note are required' });
            return true;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        const guildId = channel?.guildId || getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canEditNotes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const entry = ticketStore.addTicketNote(channelId, {
            body: note,
            authorId: getDashboardSessionUserId(req) || getBotOwnerId() || null
        });
        sendJson(res, 200, { ok: true, note: entry });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/escalate') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const level = String(body.level || '').trim().toLowerCase();
        const allowedLevels = new Set(['medium', 'high', 'immediate']);
        if (!/^\d{17,20}$/.test(channelId) || !allowedLevels.has(level)) {
            sendJson(res, 400, { error: 'Valid channelId and escalation level are required' });
            return true;
        }
        const activeStorage = ticketStore.getActiveStorage();
        const ticket = ticketStore.getTicketByChannelId(channelId, activeStorage);
        if (!ticket) {
            sendJson(res, 404, { error: 'Ticket not found' });
            return true;
        }
        const guildId = String(ticket.guildId || '').trim() || getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageEscalations'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const entry = {
            level,
            escalatedBy: getDashboardSessionUserId(req) || getBotOwnerId() || null,
            timestamp: new Date().toISOString()
        };
        if (!Array.isArray(ticket.escalations)) ticket.escalations = [];
        ticket.escalations.push(entry);
        ticketStore.saveActiveStorage(activeStorage);
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
            const guildConfig = ticketStore.getGuildConfig(guildId, activeStorage);
            const escalationRoleId = level === 'high'
                ? String(guildConfig?.escalationRoles?.high || '').trim()
                : level === 'immediate'
                    ? String(guildConfig?.escalationRoles?.immediate || '').trim()
                    : '';
            const escalationPing = escalationRoleId ? `<@&${escalationRoleId}>` : '';
            const color = level === 'immediate' ? 0xFFFFFF : level === 'high' ? 0xFF0000 : 0xFEE75C;
            const description = level === 'immediate'
                ? 'This ticket has been escalated to Immediate Response. Immediate action required!'
                : level === 'high'
                    ? 'This ticket has been escalated to High Priority.'
                    : 'This ticket has been escalated to Medium Priority.';
            await channel.send(buildV2Notice('Ticket Escalated', escalationPing ? `${escalationPing}\n\n${description}` : description, color)).catch(() => null);
        }
        sendJson(res, 200, { ok: true, escalation: entry });
        return true;
    }

    if (method === 'POST' && pathname === '/api/transcript/delete') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner token required to delete transcripts.' });
            return true;
        }
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        if (!/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid channel id' });
            return true;
        }
        const result = deleteTranscriptArchive(channelId);
        sendJson(res, 200, { ok: Boolean(result.removedEntry || result.removedFile), ...result });
        return true;
    }

    if (method === 'POST' && pathname === '/api/embed/publish') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
        const forceV2 = Boolean(body.forceV2);
        if (!/^\d{17,20}$/.test(channelId) || !payload) {
            sendJson(res, 400, { error: 'Invalid channel id or payload' });
            return true;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            sendJson(res, 404, { error: 'Channel not found or not text based' });
            return true;
        }

        let nextPayload = { ...payload };

        if (forceV2 && Array.isArray(nextPayload.embeds) && nextPayload.embeds.length) {
            const embed = nextPayload.embeds[0] || {};
            const title = String(embed.title || 'Message').slice(0, 256);
            const description = String(embed.description || '').slice(0, 4000);
            const color = Number(embed.color || 0x5865F2) || 0x5865F2;
            const base = buildV2Notice(title, description, color);
            nextPayload = {
                ...base,
                components: [...base.components, ...(Array.isArray(nextPayload.components) ? nextPayload.components : [])]
            };
        }

        const hasV2TopLevelComponent = Array.isArray(nextPayload.components) && nextPayload.components.some(c => Number(c?.type) !== 1);
        if (forceV2 || hasV2TopLevelComponent) {
            nextPayload.flags = MessageFlags.IsComponentsV2;
            delete nextPayload.content;
            delete nextPayload.embeds;
            delete nextPayload.stickers;
            delete nextPayload.poll;
        }

        const message = await channel.send(nextPayload);
        sendJson(res, 200, { ok: true, messageId: message.id });
        return true;
    }

    if (method === 'GET' && pathname === '/api/statistics') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        const plan = getGuildAiUiState(guildId, ticketStore.getActiveStorage());
        if (!plan.isPlusOrHigher) {
            sendJson(res, 403, { error: 'Statistics require Plus, Pro, or Custom.' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, summarizeStats(ticketStore.getActiveStorage()));
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/lookup') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const body = await readBody(req);
        const raw = String(body.query || '').trim();
        const match = raw.match(/\d{17,20}/);
        if (!match) {
            sendJson(res, 400, { error: 'Provide a user id or mention.' });
            return true;
        }
        const userId = match[0];
        const user = await client.users.fetch(userId).catch(() => null);
        const activeStorage = ticketStore.getActiveStorage();
        const stats7 = ticketStore.getStaffStatsForUserLastDays(userId, 7, activeStorage);
        const stats14 = ticketStore.getStaffStatsForUserLastDays(userId, 14, activeStorage);
        const stats30 = ticketStore.getStaffStatsForUserLastDays(userId, 30, activeStorage);
        sendJson(res, 200, {
            ok: true,
            user: {
                id: userId,
                tag: user ? `${user.username}${user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''}` : null
            },
            stats: { days7: stats7, days14: stats14, days30: stats30 }
        });
        return true;
    }

    return false;
}

function navItem(path, label, currentPath) {
    const meta = {
        '/overview': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
            desc: 'Quick overview'
        },
        '/settings': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/></svg>',
            desc: 'Global bot config'
        },
        '/availability': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
            desc: 'Per-type status'
        },
        '/commands/ticket-types': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>',
            desc: 'Build ticket flows'
        },
        '/panels': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>',
            desc: 'Panel designer'
        },
        '/commands/tag': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10V4H14L4 14l6 6 10-10z"/><circle cx="15" cy="7" r="1"/></svg>',
            desc: 'Reusable responses'
        },
        '/tickets': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 7h14l3 5v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7l3-5z"/></svg>',
            desc: 'Manage active tickets'
        },
        '/transcripts': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
            desc: 'Browse saved transcripts'
        },
        '/commands/feedback': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
            desc: 'Feedback command setup'
        },
        '/commands/appeal': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
            desc: 'Feedback command setup'
        },
        '/statistics': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M6 20v-4"/><path d="M12 20V10"/><path d="M18 20V4"/></svg>',
            desc: 'Tickets and trends'
        },
        '/embed-editor': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 4-4 4-4 4h-1a2 2 0 0 0-2 2c0 2-1 4-3 4z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16.5" cy="10.5" r="1"/><circle cx="9" cy="15.5" r="1"/></svg>',
            desc: 'Visual template editor'
        },
        '/pricing': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M6 8h14v12H6a2 2 0 0 1-2-2V6"/><path d="M16 14h.01"/></svg>',
            desc: 'Plans and access'
        },
        '/upgrade': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M12 22v-6M4.9 4.9l4.2 4.2M19.1 19.1l-4.2-4.2M2 12h6M22 12h-6"/></svg>',
            desc: 'Upgrade options and custom plans'
        },
        '/documentation': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
            desc: 'Placeholders and templates'
        },
        '/privacy': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
            desc: 'Privacy policy'
        },
        '/terms': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8M8 9h2"/></svg>',
            desc: 'Terms of service'
        }
    };
    const info = meta[path] || { icon: 'UI', desc: 'Dashboard section' };
    const iconMarkup = String(info.icon || '').includes('<svg')
        ? info.icon
        : `<span class="nav-textic">${String(info.icon || '').slice(0, 3)}</span>`;
    return `<a class="nav-item ${path === currentPath ? 'active' : ''}" data-nav="${path}" href="${path}"><span class="nav-kicker">${iconMarkup}</span><span class="nav-copy"><span class="nav-label">${label}</span><span class="nav-sub">${info.desc}</span></span></a>`;
}

function getAllowedDashboardPages(access = {}) {
    const pages = new Set(['/documentation', '/tutorials', '/privacy', '/terms']);
    pages.add('/pricing');
    pages.add('/upgrade');
    if (access?.canFullDashboard || access?.isOwner) {
        ['/overview', '/settings', '/availability', '/commands/ticket-types', '/panels', '/commands/tag', '/tickets', '/transcripts', '/commands/feedback', '/statistics', '/embed-editor', '/tutorials', '/pricing', '/upgrade', '/setup', '/controller', '/privacy', '/terms'].forEach(page => pages.add(page));
        return pages;
    }
    if (access?.canManageSettings) pages.add('/setup');
    if (access?.canManageAvailability) pages.add('/availability');
    if (access?.canManageTicketTypes) {
        pages.add('/settings');
        pages.add('/commands/ticket-types');
        pages.add('/panels');
        pages.add('/embed-editor');
    }
    if (access?.canManageEscalations || access?.canViewTickets) pages.add('/tickets');
    if (access?.canViewTranscripts) pages.add('/transcripts');
    return pages;
}

function pageTitleForPath(path) {
    const map = {
        '/overview': 'Home',
        '/settings': 'Settings',
        '/availability': 'Availability',
        '/tutorials': 'Tutorials',
        '/commands/ticket-types': 'Ticket Types',
        '/commands/tag': 'Tags',
        '/tickets': 'Tickets',
        '/transcripts': 'Transcripts',
        '/commands/feedback': 'Feedback',
        '/commands/appeal': 'Feedback',
        '/statistics': 'Statistics',
        '/panels': 'Panels',
        '/embed-editor': 'Branding',
        '/pricing': 'Pricing',
        '/upgrade': 'Upgrade',
        '/documentation': 'Documentation',
        '/privacy': 'Privacy',
        '/terms': 'Terms'
    };
    return map[path] || 'Dashboard';
}

function pageDescriptionForPath(path) {
    const map = {
        '/overview': 'A cleaner snapshot of ticket activity, queue health, and the most common next actions.',
        '/settings': 'Core server configuration, routing, and system behavior in one place.',
        '/availability': 'Adjust queue expectations per ticket type without digging through commands.',
        '/tutorials': 'Guides, walkthroughs, and internal onboarding material for your staff.',
        '/commands/ticket-types': 'Shape each ticket flow, assign support coverage, and keep categories tidy.',
        '/commands/tag': 'Store reusable answers and keep repeat support responses consistent.',
        '/tickets': 'Review active conversations, add notes, and handle escalations quickly.',
        '/transcripts': 'Browse saved transcripts and archive history without leaving the dashboard.',
        '/commands/feedback': 'Control where feedback lands and how the flow is presented.',
        '/statistics': 'Track recent performance, close reasons, and staff activity trends.',
        '/panels': 'Design and publish channel-specific ticket panels.',
        '/embed-editor': 'Customize server branding and reusable bot message templates.',
        '/pricing': 'Compare plans and see what is available for this server.',
        '/upgrade': 'Upgrade to Plus or contact sales for Pro plans.',
        '/documentation': 'Reference placeholders, templates, and dashboard usage notes.'
    };
    return map[path] || 'Manage this part of the dashboard with a simpler, more focused layout.';
}

function topNavItem(path, label, group, description) {
    const iconForPath = {
        '/overview': 'home',
        '/settings': 'setup',
        '/availability': 'diagnostics',
        '/tutorials': 'docs',
        '/tickets': 'tickets',
        '/transcripts': 'transcripts',
        '/commands/ticket-types': 'panels',
        '/commands/tag': 'tag',
        '/commands/feedback': 'feedback',
        '/statistics': 'diagnostics',
        '/panels': 'panels',
        '/embed-editor': 'embed',
        '/pricing': 'pricing',
        '/upgrade': 'owner',
        '/documentation': 'docs'
    };
    return `<button type="button" class="topnav-item" data-topnav-item data-value="${path}"><span class="topnav-main"><span class="topnav-icon">${dashboardIcon(
        iconForPath[path] || 'dashboard'
    )}</span><span class="topnav-copy"><strong>${label}</strong><span>${description}</span></span></span><span class="tag">${group}</span></button>`;
}

function createUiHtml(currentPath) {
    const pageTitle = pageTitleForPath(currentPath);
    const activeGroup =
        currentPath === '/overview' || currentPath === '/settings' || currentPath === '/availability'
            ? 'general'
            : currentPath === '/commands/ticket-types' || currentPath === '/commands/tag' || currentPath === '/tickets' || currentPath === '/transcripts'
                ? 'tickets'
                : 'content';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Readex+Pro:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<title>${createDocumentTitle(pageTitle)}</title>
<link rel="icon" href="/assets/sync.png" />
<style>
:root{--bg:#07070a;--bg-alt:#0b1220;--card:rgba(255,255,255,.06);--card-strong:rgba(255,255,255,.09);--bd:rgba(255,255,255,.14);--tx:#f5f7ff;--mt:rgba(245,247,255,.72);--ac:#6366f1;--ac-soft:#a5b4fc;--ok:#57f287;--er:#ed4245}
body[data-theme="diamond"]{--bg:#061018;--bg-alt:#101827;--card:rgba(236,254,255,.075);--card-strong:rgba(236,254,255,.12);--bd:rgba(165,243,252,.22);--tx:#f8feff;--mt:rgba(236,254,255,.74);--ac:#67e8f9;--ac-soft:#d9f99d;background:radial-gradient(900px 520px at 18% 8%,rgba(103,232,249,.22),transparent 60%),radial-gradient(760px 460px at 90% 12%,rgba(217,249,157,.16),transparent 58%),linear-gradient(155deg,var(--bg),#07131d,var(--bg-alt))}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
html,body{margin:0;color:var(--tx);font-family:"Readex Pro","Segoe UI","Inter",sans-serif;background:radial-gradient(1200px 760px at 105% -10%,rgba(99,102,241,.26),transparent 58%),radial-gradient(1100px 680px at -8% 112%,rgba(34,197,94,.10),transparent 62%),linear-gradient(160deg,var(--bg),#09090e,var(--bg-alt))}
 .layout{display:block;min-height:100vh}
.sidebar{padding:20px 14px;border-right:1px solid rgba(255,255,255,.14);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));backdrop-filter:blur(22px);position:relative;overflow:hidden}
.sidebar:before{content:'';position:absolute;inset:-2px;background:url(/assets/hero.svg) center/cover no-repeat;opacity:.22;filter:saturate(1.1);pointer-events:none}
.brand{display:flex;align-items:center;gap:10px;margin:2px 10px 16px;position:relative;z-index:1}
.brand img{width:210px;height:auto;display:block}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:14px;color:var(--mt);text-decoration:none;margin-bottom:8px;border:1px solid transparent;transition:transform .16s ease,background .2s ease,border-color .2s ease,color .2s ease}
.nav-item:hover{transform:translateX(2px);background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.2);color:var(--tx)}
.nav-item.active{background:linear-gradient(140deg,rgba(255,255,255,.12),rgba(99,102,241,.23));border-color:rgba(129,140,248,.6);color:var(--tx);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.nav-kicker{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:34px;border-radius:11px;background:rgba(10,10,14,.66);border:1px solid rgba(255,255,255,.2);font-size:11px;font-weight:800;letter-spacing:.4px}
.nav-copy{display:flex;flex-direction:column;min-width:0}
.nav-label{font-size:13px;font-weight:700;color:var(--tx)}
.nav-sub{font-size:11px;color:var(--mt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{padding:28px;animation:rise .3s ease}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
.title{margin:0;font-size:30px;font-weight:700;letter-spacing:.3px}
.card{background:linear-gradient(180deg,var(--card),rgba(255,255,255,.03));border:1px solid var(--bd);border-radius:18px;padding:16px;box-shadow:0 16px 50px rgba(0,0,0,.34);backdrop-filter:blur(14px);transition:transform .16s ease,background .2s ease,border-color .2s ease}
.card:hover{transform:translateY(-4px);background:linear-gradient(180deg,var(--card-strong),rgba(255,255,255,.04));border-color:rgba(255,255,255,.2)}
.grid{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.row{display:grid;gap:14px;grid-template-columns:repeat(2,minmax(0,1fr))}
label{font-size:12px;color:var(--mt);display:block;margin-bottom:6px;font-weight:600}
input,select,textarea,button{width:100%;padding:10px 11px;border-radius:13px;border:1px solid var(--bd);background:rgba(2,6,23,.72);color:var(--tx)}
input:focus,select:focus,textarea:focus{outline:none;border-color:rgba(56,189,248,.65);box-shadow:0 0 0 3px rgba(56,189,248,.18)}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#c7d2fe 50%),linear-gradient(135deg,#c7d2fe 50%,transparent 50%);background-position:calc(100% - 18px) calc(50% - 3px),calc(100% - 12px) calc(50% - 3px);background-size:6px 6px,6px 6px;background-repeat:no-repeat;padding-right:30px;border-radius:14px}
select[multiple]{appearance:auto;background-image:none;padding-right:11px;min-height:188px}
select[multiple] option{padding:8px;border-radius:8px}
textarea{min-height:84px}button{cursor:pointer}
 .btn{background:linear-gradient(135deg,var(--ac),var(--ac-soft));color:#fff;border:1px solid rgba(255,255,255,.18);font-weight:750;box-shadow:0 10px 22px rgba(0,0,0,.28),0 10px 22px rgba(56,189,248,.14),inset 0 1px 0 rgba(255,255,255,.14);transition:transform .16s ease,filter .2s ease,box-shadow .2s ease}
 .btn:hover{filter:brightness(1.04);transform:translateY(-1px);box-shadow:0 14px 28px rgba(0,0,0,.32),0 14px 28px rgba(56,189,248,.16),inset 0 1px 0 rgba(255,255,255,.18)}
 .btn-soft{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:rgba(247,248,255,.92);font-weight:650;box-shadow:none;transition:background .2s ease,transform .16s ease,border-color .2s ease}
 .btn-soft:hover{background:rgba(255,255,255,.12);border-color:rgba(56,189,248,.20);transform:translateY(-1px)}
.btn-danger{background:linear-gradient(135deg,#d93c42,#f04747);color:#fff;border:1px solid rgba(255,255,255,.2);box-shadow:0 8px 20px rgba(240,71,71,.28)}
 .btn,.btn-soft{border-radius:16px}
 .btn:active{transform:translateY(0)}
 .btn-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
 .btn-icon svg{width:16px;height:16px;display:block}
.notice{min-height:20px;margin-bottom:16px}.ok{color:var(--ok)}.danger{color:var(--er)}.list{display:grid;gap:14px}.item{padding:12px;border:1px solid var(--bd);border-radius:12px;background:rgba(255,255,255,.03)}
#toast-container{position:fixed;top:18px;right:18px;display:none;flex-direction:column;gap:8px;z-index:9999;width:min(320px,calc(100vw - 28px))}.toast{position:relative;overflow:hidden;display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border-radius:10px;border:1px solid;background:var(--solid-card,#111827);box-shadow:0 14px 34px rgba(0,0,0,.28);animation:toastSlideIn 220ms ease forwards;opacity:1}.toast:after{content:"";position:absolute;left:0;bottom:0;height:2px;width:100%;background:currentColor;opacity:.55;animation:toastTimer 4s linear forwards}.toast.toast-ok{border-color:rgba(87,242,135,.35);color:#57f287}.toast.toast-danger{border-color:rgba(237,66,69,.42);color:#ed4245}.toast.toast-warn{border-color:rgba(254,231,92,.38);color:#fee75c}.toast.toast-info{border-color:rgba(56,189,248,.36);color:#38bdf8}.toast-icon{font-size:13px;font-weight:900;flex:0 0 auto;line-height:1.3}.toast-content{min-width:0;flex:1 1 auto;color:var(--tx)}.toast-title{font-size:13px;font-weight:800;display:block;margin:0 0 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toast-message{font-size:12px;color:var(--mt);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toast-close{width:22px;height:22px;min-height:0;background:transparent!important;border:0!important;color:var(--mt);cursor:pointer;padding:0;font-size:13px;line-height:1;box-shadow:none!important;flex:0 0 auto}.toast-close:hover{color:var(--tx)}@keyframes toastSlideIn{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes toastSlideOut{from{transform:translateY(0);opacity:1}to{transform:translateY(-8px);opacity:0}}@keyframes toastTimer{to{width:0}}
.upgrade-overlay{position:fixed;inset:0;z-index:9998;display:none;place-items:center;background:rgba(2,6,23,.78);backdrop-filter:blur(12px);animation:upgradeFade .4s ease}.upgrade-overlay.show{display:grid}.upgrade-card{width:min(560px,calc(100vw - 34px));border:1px solid rgba(165,243,252,.26);border-radius:22px;background:linear-gradient(180deg,rgba(15,23,42,.96),rgba(8,13,24,.92));box-shadow:0 30px 90px rgba(0,0,0,.48),0 0 60px rgba(103,232,249,.16);padding:28px;text-align:left}.upgrade-card h2{margin:0 0 8px;font-size:32px}.upgrade-card ul{margin:12px 0 0;padding-left:20px;color:var(--mt);line-height:1.8}.upgrade-confetti{position:fixed;inset:0;z-index:9999;pointer-events:none}@keyframes upgradeFade{from{opacity:0}to{opacity:1}}
.item-top{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.muted{font-size:12px;color:var(--mt)}
 .roles{display:flex;gap:6px;flex-wrap:wrap}.role{--c:#99AAB5;display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 22%,transparent);font-size:12px}.pill{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);font-size:12px;font-weight:700}.pill.ok{border-color:rgba(87,242,135,.35);background:rgba(87,242,135,.12);color:#eafff2}.pill.warn{border-color:rgba(254,231,92,.38);background:rgba(254,231,92,.14);color:#fff9db}.pill.danger{border-color:rgba(237,66,69,.42);background:rgba(237,66,69,.14);color:#ffe9ea}
 .mention{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;border:1px solid rgba(88,101,242,.28);background:rgba(88,101,242,.18);color:#d7dcff;font-weight:800}
 .mention:hover{background:rgba(88,101,242,.24)}
 .welcome{grid-column:1/-1;position:relative;overflow:hidden}
 .welcome:before{content:"";position:absolute;inset:-2px;background:radial-gradient(700px 260px at 15% 25%,rgba(67,180,255,.18),transparent 55%),radial-gradient(560px 220px at 85% 30%,rgba(37,99,235,.12),transparent 60%);opacity:.9;pointer-events:none}
 .welcome > *{position:relative}
 .floaty{margin:0;font-size:20px;font-weight:900;letter-spacing:.15px;line-height:1.2;animation:floatText 4.8s ease-in-out infinite}
 .floaty .accent{background:linear-gradient(45deg,var(--ac-soft),var(--ac));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
 @keyframes floatText{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
 @media (prefers-reduced-motion: reduce){.floaty{animation:none}}
 
 /* Uiverse-inspired checkbox (professional, accent-colored) */
 .checkbox-wrapper{
  --checkbox-size: 22px;
  --checkbox-color: var(--ac-soft);
  --checkbox-shadow: rgba(67,180,255,.22);
  --checkbox-border: rgba(67,180,255,.42);
  display:flex;align-items:center;position:relative;cursor:pointer;padding:10px 10px;user-select:none;
 }
 .checkbox-wrapper input{position:absolute;opacity:0;cursor:pointer;height:0;width:0}
 .checkbox-wrapper .checkmark{
  position:relative;width:var(--checkbox-size);height:var(--checkbox-size);
  border:2px solid var(--checkbox-border);border-radius:10px;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  display:flex;justify-content:center;align-items:center;flex:0 0 auto;
  background:rgba(0,0,0,.18);
  box-shadow:0 0 15px var(--checkbox-shadow);
  overflow:hidden;
 }
 .checkbox-wrapper .checkmark::before{
  content:"";position:absolute;inset:0;
  background:linear-gradient(45deg,var(--checkbox-color),var(--ac));
  opacity:0;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  transform:scale(0) rotate(-45deg);
 }
 .checkbox-wrapper input:checked ~ .checkmark::before{opacity:1;transform:scale(1) rotate(0)}
 .checkbox-wrapper .checkmark svg{
  width:0;height:0;color:#07122a;z-index:1;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  filter:drop-shadow(0 0 2px rgba(0,0,0,.35));
 }
 .checkbox-wrapper input:checked ~ .checkmark svg{width:18px;height:18px;transform:rotate(360deg)}
 .checkbox-wrapper:hover .checkmark{
  border-color:var(--checkbox-color);
  transform:scale(1.08);
  box-shadow:0 0 20px var(--checkbox-shadow),0 0 40px rgba(56,189,248,.14),inset 0 0 10px rgba(255,255,255,.10);
 }
 .checkbox-wrapper input:checked ~ .checkmark{animation:pulse 1s cubic-bezier(.68,-.55,.265,1.55)}
 @keyframes pulse{
  0%{transform:scale(1);box-shadow:0 0 20px var(--checkbox-shadow)}
  50%{transform:scale(.92);box-shadow:0 0 30px var(--checkbox-shadow),0 0 50px rgba(56,189,248,.14)}
  100%{transform:scale(1);box-shadow:0 0 20px var(--checkbox-shadow)}
 }
 .checkbox-wrapper .label{
  margin-left:12px;
  font-size:14px;font-weight:800;
  color:rgba(247,248,255,.86);
  text-shadow:0 0 10px rgba(67,180,255,.10);
  opacity:.92;transition:all .24s ease;
 }
 .checkbox-wrapper input:checked ~ .label{color:var(--checkbox-color)}
 .checkbox-wrapper:hover .label{opacity:1;transform:translateX(3px)}
 .checkbox-wrapper::after,.checkbox-wrapper::before{content:"";position:absolute;width:4px;height:4px;border-radius:50%;background:var(--checkbox-color);opacity:0;transition:all .5s}
 .checkbox-wrapper::before{left:-10px;top:50%}
 .checkbox-wrapper::after{right:-10px;top:50%}
 .checkbox-wrapper:hover::before{opacity:1;transform:translateX(-10px);box-shadow:0 0 10px var(--checkbox-color)}
 .checkbox-wrapper:hover::after{opacity:1;transform:translateX(10px);box-shadow:0 0 10px var(--checkbox-color)}
 .ms-item.checkbox-wrapper::after,.ms-item.checkbox-wrapper::before{display:none}
details.acc{margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.03);overflow:hidden}
details.acc summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px;font-weight:850;color:rgba(247,248,255,.9);background:rgba(255,255,255,.02)}
details.acc summary::-webkit-details-marker{display:none}
details.acc[open] summary{background:rgba(56,189,248,.10)}
details.acc .acc-body{padding:12px 12px;border-top:1px solid rgba(255,255,255,.10);animation:pageIn .18s ease}
.dot{width:8px;height:8px;border-radius:50%;background:var(--c)}
.select-wrap{display:grid;gap:8px}
.select-toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between}
.toolbar-buttons{display:flex;gap:8px}
.chip-btn{width:auto;border-radius:999px;padding:6px 10px;font-size:12px;border:1px solid var(--bd);background:rgba(255,255,255,.06)}
.chip-btn:hover{background:rgba(129,140,248,.2)}
.select-count{font-size:12px;color:var(--mt)}
.emoji-inline{display:inline-flex;align-items:center;justify-content:center;min-width:20px;min-height:20px}
.emoji-inline img{width:20px;height:20px;object-fit:contain;vertical-align:middle}
.custom-select{position:relative;cursor:pointer;transition:300ms}
.cs-trigger{
 display:flex;align-items:center;justify-content:space-between;gap:10px;
 background:rgba(42,47,59,.55);
 border:1px solid rgba(255,255,255,.10);
 border-radius:14px;
 padding:10px 12px;
 color:rgba(247,248,255,.86);
 box-shadow:0 10px 24px rgba(0,0,0,.18);
 transition:transform 220ms ease,background 220ms ease,border-color 220ms ease
}
.cs-trigger:hover{transform:translateY(-1px);background:rgba(50,55,65,.55);border-color:rgba(56,189,248,.24)}
.cs-caret{display:inline-block;transform:rotate(-90deg);transition:transform 300ms ease;opacity:.9}
.custom-select.open .cs-caret{transform:rotate(0deg)}
.cs-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
.cs-caret{opacity:.75;font-size:11px}
.cs-menu{
 position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:20;
 background:rgba(42,47,59,.92);
 border:1px solid rgba(255,255,255,.12);
 border-radius:14px;
 padding:8px;
 box-shadow:0 18px 40px rgba(0,0,0,.45);
 backdrop-filter:blur(16px);
 opacity:0;
 transform:translateY(-12px) scale(.985);
 pointer-events:none;
 transition:opacity 300ms ease,transform 300ms ease
}
.custom-select.open .cs-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.cs-search{margin-bottom:8px}
.cs-list{max-height:220px;overflow:auto;display:grid;gap:6px}
.cs-opt{width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.04);display:flex;gap:8px;align-items:center;transition:300ms}
.cs-opt:hover{background:rgba(50,55,65,.65);border-color:rgba(56,189,248,.22)}
.cs-opt.active{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.40)}
.role-ms{position:relative;display:grid;gap:8px}
.ms-trigger{
 display:flex;align-items:center;justify-content:space-between;gap:10px;
 background:rgba(42,47,59,.55);
 border:1px solid rgba(255,255,255,.10);
 border-radius:14px;
 padding:10px 12px;
 color:rgba(247,248,255,.86);
 box-shadow:0 10px 24px rgba(0,0,0,.18);
 transition:transform 220ms ease,background 220ms ease,border-color 220ms ease
}
.ms-trigger:hover{transform:translateY(-1px);background:rgba(50,55,65,.55);border-color:rgba(56,189,248,.24)}
.role-ms.open .cs-caret{transform:rotate(0deg)}
.ms-menu{
 position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:25;
 background:rgba(42,47,59,.92);
 border:1px solid rgba(255,255,255,.12);
 border-radius:14px;
 padding:8px;
 box-shadow:0 18px 40px rgba(0,0,0,.45);
 backdrop-filter:blur(16px);
 opacity:0;
 transform:translateY(-12px) scale(.985);
 pointer-events:none;
 transition:opacity 300ms ease,transform 300ms ease
}
.role-ms.open .ms-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.ms-toolbar{display:flex;gap:8px;margin-bottom:8px}
.ms-toolbar input{flex:1}
.ms-list{max-height:230px;overflow:auto;display:grid;gap:6px}
.ms-item{border-radius:14px;background:rgba(255,255,255,.03);border:1px solid transparent}
.ms-item:hover{background:rgba(255,255,255,.05);border-color:rgba(56,189,248,.20)}
.ms-item.checkbox-wrapper{padding:10px 10px;--checkbox-size:20px}
.ms-item.checkbox-wrapper .label{font-size:13px;font-weight:750;text-shadow:none}
.ms-chips{display:flex;gap:6px;flex-wrap:wrap}
.ms-chip{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;background:rgba(99,102,241,.24);border:1px solid rgba(129,140,248,.4);font-size:12px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.12);backdrop-filter:blur(18px)}
.preview-shell{border:1px solid rgba(255,255,255,.16);border-radius:14px;background:linear-gradient(180deg,rgba(20,23,33,.90),rgba(14,17,25,.86));padding:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
.main{padding:24px 26px}
.topbar{position:sticky;top:0;z-index:5;background:linear-gradient(180deg,rgba(7,7,10,.72),rgba(7,7,10,.30));backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:14px 16px;margin-bottom:22px}
.title{margin:0;font-size:26px;letter-spacing:.2px}
@keyframes pageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
#app{animation:pageIn .22s ease;transition:opacity .18s ease,transform .18s ease}
#app.swap{opacity:0;transform:translateY(6px)}
.preview-msg{display:flex;gap:10px;align-items:flex-start}
.preview-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#22c55e)}
.preview-content{flex:1;min-width:0}
.preview-name{font-size:13px;font-weight:700;margin-bottom:6px}
.preview-tag{font-size:10px;font-weight:800;background:#5865f2;color:#fff;border-radius:4px;padding:1px 5px;margin-left:6px}
.preview-embed{display:flex;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;min-height:78px}
.preview-bar{width:4px;border-radius:8px;background:#5865F2}
.preview-main{flex:1;min-width:0}
.preview-title{font-size:14px;font-weight:700;margin-bottom:6px}
.preview-desc{white-space:pre-wrap;font-size:13px;color:#d7dcf4;line-height:1.4}
.auth{position:fixed;inset:0;background:rgba(5,8,15,.74);display:none;align-items:center;justify-content:center}
.auth-card{width:min(430px,92vw);padding:16px;background:#111936;border:1px solid var(--bd);border-radius:12px}
@media(max-width:900px){
 .layout{grid-template-columns:1fr}
 .main{padding:16px}
 .title{font-size:22px}
 .row,.topbar{grid-template-columns:1fr;display:grid}

 /* Mobile-first navigation: drawer + big dropdown */
  #menuBtn{display:inline-flex}
  .topbar-right{justify-content:flex-start}
 .topbar-right .topnav{min-width:0;width:100%}
  .topnav-btn{min-width:0}
  .topnav-menu{left:0;right:0}
  .stat-strip{grid-template-columns:repeat(2,minmax(0,1fr))}
  .quick-grid{grid-template-columns:1fr}
  .sidebar{
   position:fixed;left:0;top:0;bottom:0;width:min(320px,92vw);
   transform:translateX(-105%);
   transition:transform .22s ease;
  z-index:50;
  border-right:1px solid rgba(255,255,255,.10);
  border-bottom:none;
 }
 body.menu-open .sidebar{transform:translateX(0)}
 .overlay{display:none;position:fixed;inset:0;background:rgba(5,8,15,.62);backdrop-filter:blur(4px);z-index:49}
 body.menu-open .overlay{display:block}

 input,select,textarea,button{font-size:16px}
 .nav-item{padding:12px 12px}
 .nav-kicker{min-width:40px;height:40px}
}

/* --- Dashboard 2026 polish (Dyno/Circle/Sapph-inspired) --- */
:root{
 --bg:#050712;--bg-alt:#070a18;--card:rgba(255,255,255,.055);--card-strong:rgba(255,255,255,.085);
 --bd:rgba(255,255,255,.12);--tx:#f7f8ff;--mt:rgba(247,248,255,.74);
 --ac:#2563eb;--ac-soft:#38bdf8;--ok:#57f287;--er:#ed4245;--warn:#fee75c;
 --shadow:0 20px 60px rgba(0,0,0,.45);--shadow-soft:0 14px 40px rgba(0,0,0,.35);
}
html,body{font-family:"Inter","Readex Pro","Segoe UI",system-ui,-apple-system,sans-serif}
  body{
   background:
    radial-gradient(1200px 700px at 100% 0%,rgba(37,99,235,.14),transparent 56%),
    radial-gradient(1100px 720px at 0% 105%,rgba(67,180,255,.10),transparent 60%),
    radial-gradient(900px 540px at 25% -10%,rgba(87,242,135,.06),transparent 55%),
    linear-gradient(160deg,var(--bg),#070716,var(--bg-alt));
  }

  /* Theme toggle: light */
  body[data-theme="light"]{
  --bg:#f6f1e6;--bg-alt:#f1e4ce;
  --bd:rgba(15,23,42,.14);--tx:#0b1220;--mt:rgba(11,18,32,.64);
  --shadow:0 18px 55px rgba(15,23,42,.12);--shadow-soft:0 12px 36px rgba(15,23,42,.10);
 }
 body[data-theme="light"]{
  background:
   radial-gradient(1200px 700px at 100% 0%,rgba(67,180,255,.20),transparent 56%),
   radial-gradient(1100px 720px at 0% 105%,rgba(37,99,235,.10),transparent 60%),
   radial-gradient(900px 520px at 50% -12%,rgba(254,231,92,.10),transparent 60%),
   linear-gradient(160deg,var(--bg),#fbf6ec,var(--bg-alt));
 }
 body[data-theme="light"] .sidebar{background:linear-gradient(180deg,rgba(253,249,241,.86),rgba(247,239,227,.72));border-right:1px solid rgba(15,23,42,.10)}
 body[data-theme="light"] .sidebar:before{opacity:.07;filter:saturate(1) contrast(1)}
 body[data-theme="light"] .nav-kicker{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.10)}
 body[data-theme="light"] .nav-item{color:rgba(11,18,32,.72)}
 body[data-theme="light"] .nav-label{color:var(--tx)}
 body[data-theme="light"] .nav-sub{color:rgba(11,18,32,.60)}
 body[data-theme="light"] .nav-item:hover{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.12);color:var(--tx)}
body[data-theme="light"] .nav-item.active{background:linear-gradient(140deg,rgba(67,180,255,.14),rgba(37,99,235,.10));border-color:rgba(67,180,255,.24);box-shadow:inset 0 1px 0 rgba(255,255,255,.55)}
 body[data-theme="light"] .topbar{background:linear-gradient(180deg,rgba(253,249,241,.82),rgba(247,239,227,.62));border-color:rgba(15,23,42,.10)}
 body[data-theme="light"] .card{background:linear-gradient(180deg,rgba(253,249,241,.86),rgba(247,239,227,.70));border-color:rgba(15,23,42,.12)}
 body[data-theme="light"] .card:hover{background:linear-gradient(180deg,rgba(253,249,241,.92),rgba(247,239,227,.76));border-color:rgba(15,23,42,.16)}
 body[data-theme="light"] input,body[data-theme="light"] select,body[data-theme="light"] textarea{background:rgba(253,249,241,.92);color:var(--tx);border-color:rgba(15,23,42,.14)}
 body[data-theme="light"] input:focus,body[data-theme="light"] select:focus,body[data-theme="light"] textarea:focus{border-color:rgba(67,180,255,.55);box-shadow:0 0 0 3px rgba(67,180,255,.16)}
 body[data-theme="light"] .cs-menu,body[data-theme="light"] .ms-menu,body[data-theme="light"] .topnav-menu{background:rgba(253,249,241,.96);border-color:rgba(15,23,42,.12)}
 body[data-theme="light"] .cs-opt{background:rgba(15,23,42,.02)}
 body[data-theme="light"] .cs-opt:hover{background:rgba(67,180,255,.10);border-color:rgba(67,180,255,.20)}
 body[data-theme="light"] .ms-item{background:rgba(15,23,42,.02)}
 body[data-theme="light"] .ms-chip{background:rgba(67,180,255,.14);border-color:rgba(67,180,255,.20);color:var(--tx)}
 body[data-theme="light"] .btn-soft{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.14);color:var(--tx)}
 body[data-theme="light"] .btn-soft:hover{background:rgba(15,23,42,.06);border-color:rgba(67,180,255,.30)}
 body[data-theme="light"] .btn{box-shadow:0 10px 22px rgba(15,23,42,.14),0 10px 22px rgba(67,180,255,.18),inset 0 1px 0 rgba(255,255,255,.25)}
 body[data-theme="light"] .btn:hover{box-shadow:0 14px 28px rgba(15,23,42,.16),0 14px 28px rgba(67,180,255,.22),inset 0 1px 0 rgba(255,255,255,.28)}
 body[data-theme="light"] .checkbox-wrapper .checkmark{background:rgba(253,249,241,.78)}
 body[data-theme="light"] .mention{border-color:rgba(88,101,242,.22);background:rgba(88,101,242,.12);color:#1d2a6b}

 body[data-theme="ocean"]{
  --bg:#061421;--bg-alt:#071b2c;
  --bd:rgba(125,211,252,.16);--tx:#ecfeff;--mt:rgba(236,254,255,.70);
  --ac:#22d3ee;--ac-soft:#14b8a6;
  --shadow:0 20px 62px rgba(2,10,20,.52);--shadow-soft:0 14px 40px rgba(2,10,20,.46);
 }
 body[data-theme="ocean"]{
  background:
   radial-gradient(1200px 700px at 100% 0%,rgba(34,211,238,.18),transparent 56%),
   radial-gradient(1100px 720px at 0% 105%,rgba(20,184,166,.10),transparent 60%),
   radial-gradient(900px 520px at 50% -12%,rgba(125,211,252,.08),transparent 60%),
   linear-gradient(160deg,var(--bg),#05101b,var(--bg-alt));
 }
 body[data-theme="ocean"] .topbar{background:linear-gradient(180deg,rgba(5,24,36,.72),rgba(4,18,28,.48));border-color:rgba(34,211,238,.16)}
 body[data-theme="ocean"] .card{background:linear-gradient(180deg,rgba(8,35,48,.82),rgba(5,21,31,.74));border-color:rgba(34,211,238,.16)}
 body[data-theme="ocean"] .card:hover{border-color:rgba(34,211,238,.28)}
 body[data-theme="ocean"] input,body[data-theme="ocean"] select,body[data-theme="ocean"] textarea{background:rgba(2,16,24,.52);border-color:rgba(34,211,238,.18)}
 body[data-theme="ocean"] input:focus,body[data-theme="ocean"] select:focus,body[data-theme="ocean"] textarea:focus{border-color:rgba(34,211,238,.45);box-shadow:0 0 0 3px rgba(34,211,238,.16)}
 body[data-theme="ocean"] .cs-menu,body[data-theme="ocean"] .ms-menu,body[data-theme="ocean"] .topnav-menu{background:rgba(5,19,28,.94);border-color:rgba(34,211,238,.16)}
 body[data-theme="ocean"] .mention{border-color:rgba(34,211,238,.22);background:rgba(34,211,238,.12);color:var(--tx)}

 body[data-theme="sunset"]{
  --bg:#1b1020;--bg-alt:#2a1422;
  --bd:rgba(251,146,60,.18);--tx:#fff7ed;--mt:rgba(255,247,237,.72);
  --ac:#fb7185;--ac-soft:#fb923c;
  --shadow:0 20px 62px rgba(30,10,18,.56);--shadow-soft:0 14px 40px rgba(30,10,18,.48);
 }
 body[data-theme="sunset"]{
  background:
   radial-gradient(1200px 700px at 100% 0%,rgba(251,113,133,.18),transparent 56%),
   radial-gradient(1100px 720px at 0% 105%,rgba(251,146,60,.12),transparent 60%),
   radial-gradient(900px 520px at 50% -12%,rgba(253,186,116,.10),transparent 60%),
   linear-gradient(160deg,var(--bg),#1a0f19,var(--bg-alt));
 }
 body[data-theme="sunset"] .topbar{background:linear-gradient(180deg,rgba(45,18,26,.74),rgba(30,12,20,.52));border-color:rgba(251,146,60,.18)}
 body[data-theme="sunset"] .card{background:linear-gradient(180deg,rgba(56,22,32,.80),rgba(31,13,20,.74));border-color:rgba(251,146,60,.18)}
 body[data-theme="sunset"] .card:hover{border-color:rgba(251,146,60,.30)}
 body[data-theme="sunset"] input,body[data-theme="sunset"] select,body[data-theme="sunset"] textarea{background:rgba(25,11,18,.54);border-color:rgba(251,146,60,.20)}
 body[data-theme="sunset"] input:focus,body[data-theme="sunset"] select:focus,body[data-theme="sunset"] textarea:focus{border-color:rgba(251,146,60,.48);box-shadow:0 0 0 3px rgba(251,146,60,.16)}
 body[data-theme="sunset"] .cs-menu,body[data-theme="sunset"] .ms-menu,body[data-theme="sunset"] .topnav-menu{background:rgba(30,12,20,.95);border-color:rgba(251,146,60,.18)}
 body[data-theme="sunset"] .mention{border-color:rgba(251,146,60,.24);background:rgba(251,146,60,.12);color:var(--tx)}

 /* Theme toggle: hacker (hidden) */
 body[data-theme="hacker"]{
  --bg:#020607;--bg-alt:#000c08;
  --bd:rgba(0,255,136,.18);--tx:#d7ffe9;--mt:rgba(215,255,233,.70);
  --ac:#00ff88;--ac-soft:#00e5ff;
  --shadow:0 20px 70px rgba(0,0,0,.65);--shadow-soft:0 14px 46px rgba(0,0,0,.52);
 }
 body[data-theme="hacker"]{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
  background:
   radial-gradient(1100px 720px at 10% 0%,rgba(0,255,136,.16),transparent 56%),
   radial-gradient(1000px 650px at 100% 100%,rgba(0,229,255,.10),transparent 60%),
   repeating-linear-gradient(0deg,rgba(0,255,136,.06) 0,rgba(0,255,136,.06) 1px,transparent 1px,transparent 4px),
   linear-gradient(160deg,var(--bg),#000000,var(--bg-alt));
 }
 body[data-theme="hacker"] .topbar{background:linear-gradient(180deg,rgba(0,0,0,.60),rgba(0,0,0,.22));border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .card{background:linear-gradient(180deg,rgba(0,255,136,.06),rgba(0,0,0,.26));border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .card:hover{border-color:rgba(0,255,136,.26)}
 body[data-theme="hacker"] input,body[data-theme="hacker"] select,body[data-theme="hacker"] textarea{background:rgba(0,0,0,.40);border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] input:focus,body[data-theme="hacker"] select:focus,body[data-theme="hacker"] textarea:focus{border-color:rgba(0,255,136,.45);box-shadow:0 0 0 3px rgba(0,255,136,.16)}
 body[data-theme="hacker"] .cs-menu,body[data-theme="hacker"] .ms-menu,body[data-theme="hacker"] .topnav-menu{background:rgba(0,0,0,.92);border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .topnav-item:hover{border-color:rgba(0,255,136,.28)}
 body[data-theme="hacker"] .mention{border-color:rgba(0,255,136,.24);background:rgba(0,255,136,.12);color:var(--tx)}
 .layout{display:block}
.sidebar{
 padding:18px 14px;
 background:linear-gradient(180deg,rgba(18,20,34,.78),rgba(7,10,24,.78));
 border-right:1px solid rgba(255,255,255,.09);
}
 .sidebar:before{opacity:.12;filter:saturate(1.03) contrast(1.03)}
.brand{margin:6px 10px 18px}
.brand img{width:200px}
.nav-section{margin:14px 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:rgba(247,248,255,.55);font-weight:700}
.nav-item{position:relative;border-radius:16px}
.nav-kicker{
 min-width:36px;height:36px;border-radius:12px;
 background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));
 border:1px solid rgba(255,255,255,.14);
}
.nav-kicker svg{width:18px;height:18px;display:block;opacity:.92}
.nav-textic{font-size:11px;font-weight:800;letter-spacing:.4px;opacity:.9}
.nav-item:hover .nav-kicker{border-color:rgba(56,189,248,.28);box-shadow:0 10px 24px rgba(56,189,248,.10)}
.nav-item.active{border-color:rgba(56,189,248,.38);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 12px 34px rgba(56,189,248,.08)}
.nav-item.active:before{content:'';position:absolute;left:8px;top:10px;bottom:10px;width:3px;border-radius:999px;background:linear-gradient(180deg,var(--ac),var(--ac-soft))}
.nav-home{margin:0 10px 12px}

/* Sidebar radio glider (Uiverse-inspired) */
.radio-container{
 --main-color: var(--ac-soft);
 --main-color-opacity: color-mix(in srgb,var(--ac-soft) 14%, transparent);
 --total-radio: 3;
 display:flex;
 flex-direction:column;
 position:relative;
 padding-left:.5rem;
 margin:0 10px 12px;
}
.radio-container input{cursor:pointer;appearance:none}
.radio-container label{
 cursor:pointer;
 padding:12px 12px 12px 10px;
 border-radius:14px;
 position:relative;
 color:rgba(247,248,255,.58);
 font-weight:850;
 letter-spacing:.04em;
 transition:all .22s ease;
}
.radio-container input:checked + label{color:var(--main-color);background:rgba(255,255,255,.03)}
.radio-container .glider-container{
 position:absolute;left:0;top:0;bottom:0;
 background:linear-gradient(0deg,rgba(0,0,0,0) 0%,rgba(27,27,27,1) 50%,rgba(0,0,0,0) 100%);
 width:1px;
}
.radio-container .glider-container .glider{
 position:relative;
 height:calc(100% / var(--total-radio));
 width:100%;
 background:linear-gradient(0deg,rgba(0,0,0,0) 0%,var(--main-color) 50%,rgba(0,0,0,0) 100%);
 transition:transform .5s cubic-bezier(.37,1.95,.66,.56);
}
.radio-container .glider-container .glider::before{
 content:"";position:absolute;height:60%;width:300%;top:50%;transform:translateY(-50%);
 background:var(--main-color);filter:blur(10px);
}
.radio-container .glider-container .glider::after{
 content:"";position:absolute;left:0;height:100%;width:150px;
 background:linear-gradient(90deg,var(--main-color-opacity) 0%,rgba(0,0,0,0) 100%);
}
.radio-container input:nth-of-type(1):checked ~ .glider-container .glider{transform:translateY(0)}
.radio-container input:nth-of-type(2):checked ~ .glider-container .glider{transform:translateY(100%)}
.radio-container input:nth-of-type(3):checked ~ .glider-container .glider{transform:translateY(200%)}
 .nav-group{margin:10px 10px 0;display:none}
 .nav-group.open{display:block}
 .nav-group-body{display:block;animation:pageIn .18s ease}
.main{padding:22px 24px;max-width:1240px;margin:0 auto}
.topbar{
 border-radius:18px;
 border:1px solid rgba(255,255,255,.10);
 box-shadow:var(--shadow-soft);
}
 .topbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
  .brand-mini{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:16px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);box-shadow:var(--shadow-soft);overflow:hidden;flex:0 0 auto;transition:transform .16s ease,background .2s ease,border-color .2s ease}
 .brand-mini:hover{transform:translateY(-1px);background:rgba(255,255,255,.06);border-color:rgba(56,189,248,.24)}
  .brand-mini img{width:26px;height:26px;display:block}
  .titles{display:flex;flex-direction:column;gap:2px;min-width:0}
  .topbar-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
  .topbar-right .topnav{width:auto;min-width:200px}
 .topbar-right .theme-nav{min-width:160px}
  .topbar-right .btn,.topbar-right .btn-soft{width:auto}
 
 /* Top navigation dropdown (smooth, animated) */
 .topnav{position:relative}
  .topnav-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:190px;border-radius:18px;padding:11px 14px}
  #topNav .topnav-btn{min-width:220px}
  #themeNav .topnav-btn{min-width:160px}
 .topnav-btn .chev{opacity:.78;transition:transform .18s ease}
 .topnav.open .topnav-btn .chev{transform:rotate(180deg)}
  .topnav-menu{
   position:absolute;right:0;top:calc(100% + 8px);
   min-width:320px;max-height:70vh;overflow:auto;padding:10px;
  background:rgba(10,14,30,.92);border:1px solid rgba(255,255,255,.12);
  border-radius:20px;box-shadow:var(--shadow);backdrop-filter:blur(18px);
  opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;
  transition:opacity .16s ease,transform .18s ease
 }
 .topnav.open .topnav-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
  #themeNav .topnav-menu{min-width:190px}
  .topnav-group{display:grid;gap:7px;padding:6px 0}
  .topnav-group + .topnav-group{border-top:1px solid var(--solid-border);margin-top:6px;padding-top:12px}
  .topnav-group-title{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--mt);font-weight:850;padding:0 4px 2px}
 .topnav-item{
  width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
  text-align:left;padding:12px 13px;border-radius:16px;
  background:transparent;border:1px solid transparent;color:rgba(247,248,255,.82);
  cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .16s ease
 }
.topnav-item:hover{background:rgba(255,255,255,.05);border-color:rgba(56,189,248,.22);transform:translateY(-1px)}
.topnav-item.active{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.34);color:var(--tx)}
 .topnav-item .tag{font-size:11px;color:rgba(247,248,255,.55)}
 .topnav-main{display:flex;align-items:center;gap:12px;min-width:0}
 .topnav-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
 .topnav-icon svg{width:18px;height:18px;display:block}
 .topnav-copy{display:grid;gap:2px;min-width:0}
 .topnav-copy strong{font-size:13px;font-weight:800}
 .topnav-copy span{font-size:11px;color:var(--mt)}
#menuBtn{display:none}
.overlay{display:none}
.title{font-size:26px;font-weight:750;letter-spacing:.15px}
.card{border-radius:18px;box-shadow:var(--shadow-soft);background:linear-gradient(180deg,rgba(17,20,36,.78),rgba(11,14,28,.78));border-color:rgba(255,255,255,.10)}
.card:hover{box-shadow:var(--shadow);transform:translateY(-3px)}
.pricing-hero{padding:28px 26px;display:grid;gap:18px;}
.pricing-hero .page-kicker{margin-bottom:4px;}
.pricing-hero-stats{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));}
.pricing-stat{padding:18px;border-radius:16px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);}
.pricing-stat strong{display:block;font-size:22px;margin-bottom:6px;}
.pricing-card{border-radius:24px;padding:28px;display:flex;flex-direction:column;gap:20px;min-height:460px;transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;}
.pricing-card.featured{border:1px solid rgba(56,189,248,.45);box-shadow:0 0 0 1px rgba(56,189,248,.16),0 28px 80px rgba(56,189,248,.08);transform:scale(1.02);}
.pricing-card .plan-name{font-size:22px;font-weight:800;letter-spacing:.02em;}
.pricing-card .plan-price{font-size:42px;font-weight:900;line-height:1;}
.pricing-card .plan-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;background:rgba(56,189,248,.12);color:var(--acc);}
.pricing-card .plan-note{color:var(--mt);font-size:13px;line-height:1.6;}
.pricing-card .plan-action{margin-top:auto;}
.pricing-feature-list{display:grid;gap:10px;}
.pricing-feature{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);}
.pricing-feature .dot{width:10px;height:10px;border-radius:999px;background:var(--acc);flex-shrink:0;}
.pricing-table{overflow-x:auto;padding:24px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);}
.pricing-table table{width:100%;border-collapse:collapse;min-width:680px;}
.pricing-table th,.pricing-table td{padding:16px 14px;text-align:left;border-bottom:1px solid rgba(255,255,255,.08);}
.pricing-table th{font-weight:700;color:var(--tx);}
.pricing-table td{color:var(--mt);}
.pricing-table td.active{color:var(--tx);font-weight:700;}
.pricing-preview{display:grid;gap:16px;padding:24px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);}
.pricing-preview .pricing-screenshot{border-radius:20px;overflow:hidden;background:rgba(6,8,18,.95);border:1px solid rgba(255,255,255,.08);}
.pricing-screenshot-title{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.18em;color:var(--mt);margin-bottom:12px;}
.pricing-screenshot-thumb{position:relative;min-height:240px;background:linear-gradient(180deg,rgba(4,7,18,.95),rgba(8,11,28,.95));}
.pricing-screenshot-bar{position:absolute;left:0;right:0;top:0;height:42px;background:rgba(255,255,255,.06);display:flex;align-items:center;gap:10px;padding:0 14px;}
.pricing-screenshot-dot{width:10px;height:10px;border-radius:999px;background:rgba(56,189,248,.9);}
.pricing-screenshot-line{height:12px;border-radius:999px;background:rgba(255,255,255,.08);margin:12px 14px;}
.pricing-screenshot-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;position:absolute;bottom:14px;left:14px;right:14px;}
.pricing-screenshot-card{padding:14px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:var(--tx);}
.pricing-faq{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;}
.pricing-faq .faq-item{padding:20px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);}
.pricing-cta{padding:32px 28px;text-align:center;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);}
.pricing-cta .btn{min-width:180px;}
@media(max-width:950px){.pricing-hero-stats{grid-template-columns:1fr}.pricing-grid,.pricing-faq{grid-template-columns:1fr}.pricing-screenshot-row{grid-template-columns:1fr;position:static;}.pricing-table table{min-width:0;}}
.item{transition:transform .16s ease,border-color .2s ease,background .2s ease}
.item:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.035)}
 input,select,textarea,button{background:rgba(5,8,20,.78)}
 .btn{border-radius:14px}
 .btn-danger{border-radius:14px}
 .btn-soft{border-radius:14px}

 /* Dyno-style editor layout */
 .split{display:grid;grid-template-columns:360px 1fr;gap:14px;align-items:start}
 .list-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
 .list-card input{background:rgba(6,9,22,.7)}
 .list-compact{gap:8px}
 .list-btn{display:block;width:100%;text-align:left;padding:10px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);color:var(--tx);transition:transform .16s ease,border-color .2s ease,background .2s ease}
.list-btn:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.22);background:rgba(56,189,248,.08)}
.list-btn.active{border-color:rgba(56,189,248,.34);background:linear-gradient(180deg,rgba(56,189,248,.14),rgba(255,255,255,.03));box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
 .list-title{font-weight:800;font-size:13px;display:flex;align-items:center;gap:8px}
 .page-shell{display:grid;gap:14px}
 .page-hero{display:grid;gap:12px;padding:18px}
 .page-hero-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
 .page-kicker{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--mt)}
 .page-hero h3{margin:0;font-size:28px;line-height:1.08}
 .page-hero p{margin:0;max-width:760px;color:var(--mt)}
 .page-pill-row{display:flex;gap:8px;flex-wrap:wrap}
 .stat-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
 .stat-tile{padding:14px;border-radius:16px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03)}
 .stat-tile strong{display:block;font-size:26px;line-height:1.05;margin-top:4px}
 .quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .module-stack{display:grid;gap:22px}
  .module-options{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:stretch}
  .module-option{min-height:116px;text-align:left;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.035));border:1px solid rgba(255,255,255,.12);color:var(--tx);box-shadow:var(--shadow-soft)}
  .module-option:hover{border-color:rgba(56,189,248,.28);background:linear-gradient(180deg,rgba(56,189,248,.10),rgba(255,255,255,.035))}
  .module-option strong{display:block;font-size:16px;margin-bottom:6px}
  .module-option .muted{display:block;line-height:1.45}
  .module-option .pill{flex:0 0 auto}
  .module-editor-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.10)}
  .module-editor-title{font-size:13px;font-weight:850;color:var(--mt);letter-spacing:.12em;text-transform:uppercase}
  .module-drill.editing{position:fixed;inset:0;z-index:80;background:rgba(2,6,23,.76);backdrop-filter:blur(16px);padding:28px;overflow:auto;animation:modalIn .18s ease}
  .module-drill.editing > .module-options{display:none}
  .module-drill.editing > .module-source{display:block}
  .module-drill.editing .module-root{display:grid!important;grid-template-columns:1fr!important;gap:0!important}
  .module-drill.editing .module-panel{display:none!important}
  .module-drill.editing .module-panel.active-panel{display:block!important;width:100%;max-width:980px;margin:0 auto}
  .module-drill:not(.editing) > .module-source{display:none}
  @keyframes modalIn{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:scale(1)}}
 .list-meta{margin-top:4px;font-size:12px;color:rgba(247,248,255,.65);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .help{margin-top:6px;font-size:12px;color:rgba(247,248,255,.60)}
 textarea{min-height:110px}
  #app > .grid,#app > .split{gap:14px;align-items:start}
  #app > .grid{grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr))}
  #app > .split{grid-template-columns:minmax(280px,340px) minmax(0,1fr)}
  #app > .grid > .card,#app > .split > .card{width:100%;min-height:0;padding:18px}
  #app .card + .card{margin-top:0}
  .card{height:auto}
  .card h3{margin-top:0;margin-bottom:10px}
  .card p:last-child,.item p:last-child{margin-bottom:0}
  .item{align-items:stretch}
  .item-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .row{align-items:start}
  .btn,.btn-soft,.btn-danger,.cs-trigger,.ms-trigger{min-height:42px;display:inline-flex;align-items:center;justify-content:center;gap:8px;line-height:1.2;white-space:normal;max-width:100%}
  .btn,.btn-soft,.btn-danger{width:auto;padding-left:14px;padding-right:14px}
  .topnav-btn,.cs-trigger,.ms-trigger,.module-option{width:100%}
  .btn svg,.btn-soft svg,.btn-danger svg,.topnav-icon svg,.btn-icon svg,.nav-kicker svg{display:block;transform:none;transform-origin:center}
  .btn-icon,.topnav-icon,.nav-kicker{flex:0 0 auto}
  .server-icon-btn{width:46px!important;height:46px!important;padding:0!important;border-radius:16px}
  .topbar-right .server-icon-btn{order:99}
  .server-icon-btn .btn-icon{width:20px;height:20px}
  .server-icon-btn .btn-icon svg{width:20px;height:20px}
  .theme-secret{display:none!important}
  body[data-hacker-unlocked="true"] .theme-secret{display:flex!important}
  body[data-theme] .card,body[data-theme] .item,body[data-theme] .preview-shell{color:var(--tx)}
  body[data-theme] .muted,body[data-theme] .help,body[data-theme] .topnav-copy span{color:var(--mt)}
  body[data-theme] input,body[data-theme] select,body[data-theme] textarea,body[data-theme] button{color:var(--tx)}
  body[data-theme] input::placeholder,body[data-theme] textarea::placeholder{color:color-mix(in srgb,var(--mt) 72%, transparent)}
  body[data-theme] .cs-trigger,body[data-theme] .ms-trigger,body[data-theme] .topnav-item{color:var(--tx)}
  body[data-theme] .btn{color:#fff}
  body[data-theme="light"] .btn{color:#fff}
  body[data-theme="light"] .btn-danger{color:#fff}
  body[data-theme="light"] .pill.ok{color:#064e3b}
  body[data-theme="light"] .pill.warn{color:#713f12}
  body[data-theme="light"] .pill.danger{color:#7f1d1d}

  /* Clean module skin, theme-aware: old atmosphere + solid module boxes. */
  body{
    --solid-card:#111827;
    --solid-card-2:#151b2b;
    --solid-card-3:#1b2335;
    --solid-input:#090d18;
    --solid-border:rgba(148,163,184,.18);
  }
  body[data-theme="ocean"]{
    --solid-card:#071a28;
    --solid-card-2:#092234;
    --solid-card-3:#0c2b3e;
    --solid-input:#05131f;
    --solid-border:rgba(34,211,238,.18);
  }
  body[data-theme="sunset"]{
    --solid-card:#20121d;
    --solid-card-2:#2a1722;
    --solid-card-3:#351d2a;
    --solid-input:#170d16;
    --solid-border:rgba(251,146,60,.18);
  }
  body[data-theme="hacker"]{
    --solid-card:#03100b;
    --solid-card-2:#06170f;
    --solid-card-3:#092014;
    --solid-input:#010906;
    --solid-border:rgba(0,255,136,.20);
  }
  body[data-theme="diamond"]{
    --solid-card:#071923;
    --solid-card-2:#0a202d;
    --solid-card-3:#0d2a38;
    --solid-input:#04111a;
    --solid-border:rgba(165,243,252,.22);
  }
  body[data-theme="light"]{
    --bg:#eef4fb;
    --bg-alt:#f9fbff;
    --tx:#0f172a;
    --mt:rgba(15,23,42,.68);
    --bd:rgba(15,23,42,.13);
    --solid-card:#ffffff;
    --solid-card-2:#f6f8fc;
    --solid-card-3:#eef3fa;
    --solid-input:#ffffff;
    --solid-border:rgba(30,41,59,.14);
    --shadow:0 18px 50px rgba(15,23,42,.12);
    --shadow-soft:0 12px 34px rgba(15,23,42,.09);
    background:
      radial-gradient(1000px 620px at 95% -6%,rgba(56,189,248,.22),transparent 58%),
      radial-gradient(880px 560px at 8% 105%,rgba(37,99,235,.13),transparent 62%),
      linear-gradient(160deg,#eef4fb,#fbfdff 48%,#edf4ff);
  }
  .main{width:min(1180px,100%);padding:30px}
  .topbar{margin-bottom:24px;padding:0 0 18px;border:0;border-bottom:1px solid var(--solid-border);border-radius:0;background:transparent;box-shadow:none}
  .title{font-size:32px;line-height:1.12;margin-bottom:6px}
  .titles .muted,#pageHint,.muted,.help,.list-meta{color:var(--mt)}
  .card,.item,.page-hero,.stat-tile,.module-option,.pricing-card,.pricing-preview,.pricing-feature,.pricing-faq .faq-item,.pricing-cta,details.acc{
    background:var(--solid-card);
    border:1px solid var(--solid-border);
    border-radius:14px;
    box-shadow:var(--shadow-soft);
    backdrop-filter:none;
    transform:none;
  }
  .card:hover,.item:hover,.stat-tile:hover,.module-option:hover,.pricing-card:hover{transform:none;background:var(--solid-card);border-color:color-mix(in srgb,var(--ac) 34%,var(--solid-border));box-shadow:var(--shadow-soft)}
  .page-hero{padding:24px;margin-bottom:20px}
  .page-hero:before,.welcome:before{display:none}
  .page-hero h3,.card h3{font-size:22px;line-height:1.2;margin-bottom:8px}
  .grid{gap:20px}
  .split,#app > .split{grid-template-columns:minmax(260px,.82fr) minmax(0,1.35fr);gap:20px}
  .list-card{align-self:start}
  .item{padding:16px}
  .stat-strip{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:20px}
  .stat-tile{padding:18px}
  .stat-tile strong{font-size:24px;margin-top:10px}
  .stat-tile .muted{font-size:14px}
  label{font-size:14px;color:var(--mt);margin:12px 0 8px}
  input,select,textarea,.cs-trigger,.ms-trigger{
    background:var(--solid-input);
    border:1px solid var(--solid-border);
    border-radius:8px;
    color:var(--tx);
    padding:12px;
    box-shadow:none;
  }
  textarea{min-height:100px;resize:vertical}
  input:focus,select:focus,textarea:focus{border-color:var(--ac);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac) 18%, transparent)}
  .custom-select .cs-menu,.role-ms .ms-menu,.topnav-menu{background:var(--solid-card);border-color:var(--solid-border);border-radius:12px;box-shadow:var(--shadow);backdrop-filter:none}
  .custom-select.drop-up .cs-menu,.role-ms.drop-up .ms-menu{top:auto;bottom:calc(100% + 8px)}
  .custom-select.drop-up .cs-caret,.role-ms.drop-up .cs-caret{transform:rotate(180deg)}
  .cs-opt,.ms-item,.topnav-item{background:var(--solid-card-2);border:1px solid var(--solid-border);border-radius:8px}
  .cs-opt:hover,.ms-item:hover,.topnav-item:hover,.cs-opt.active{background:var(--solid-card-3);border-color:var(--ac);transform:none}
  .btn{
    background:linear-gradient(135deg,var(--ac),var(--ac-soft));
    border:1px solid color-mix(in srgb,var(--ac) 60%, white 16%);
    border-radius:10px;
    padding:12px 16px;
    box-shadow:0 12px 28px color-mix(in srgb,var(--ac) 24%, transparent);
    font-weight:800;
  }
  .btn:hover{filter:brightness(1.04);transform:none;box-shadow:0 14px 32px color-mix(in srgb,var(--ac) 28%, transparent)}
  .btn-soft{
    background:var(--solid-card-2);
    border:1px solid var(--solid-border);
    border-radius:10px;
    color:var(--tx);
    box-shadow:none;
  }
  .btn-soft:hover{background:var(--solid-card-3);border-color:var(--ac);transform:none}
  .btn-danger{border-radius:10px;box-shadow:none}
  .pill{background:var(--solid-card-2);border:1px solid var(--solid-border);color:var(--tx)}
  .list-btn{background:var(--solid-card-2);border:1px solid var(--solid-border);border-radius:12px}
  .list-btn.active,.list-btn:hover{border-color:var(--ac);background:var(--solid-card-3);box-shadow:none;transform:none}
  .preview-shell,.preview-embed{background:var(--solid-input);border-color:var(--solid-border);border-radius:12px}
  body[data-theme="light"] .topbar{border-bottom-color:rgba(30,41,59,.12)}
  body[data-theme="light"] .brand-mini{background:#fff;border-color:rgba(30,41,59,.12)}
  body[data-theme="light"] .btn-soft.server-icon-btn,body[data-theme="light"] .topnav-btn{background:#fff;border-color:rgba(30,41,59,.14);box-shadow:0 10px 26px rgba(15,23,42,.08)}
  body[data-theme="light"] .topnav-item .tag{color:rgba(15,23,42,.56)}
  body[data-theme="light"] .mention{background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.20);color:#1d4ed8}
  body[data-theme="light"] .checkbox-wrapper .label{color:rgba(15,23,42,.82);text-shadow:none}
  body[data-theme="light"] details.acc,body[data-theme="light"] details.acc summary{background:var(--solid-card-2);border-color:var(--solid-border);color:var(--tx)}
  .card,.item,.list-btn,.module-option,.stat-tile,.topbar,.topnav-item,.pill{min-width:0}
  .card,.item,.preview-shell,details.acc,.pricing-table,.custom-select,.role-ms{max-width:100%;overflow-wrap:anywhere}
  .list,.grid,.split,.row,.owner-summary,.owner-guilds,.controller-grid{min-width:0}
  .cs-menu,.ms-menu,.topnav-menu{max-width:min(520px,calc(100vw - 28px));scrollbar-color:var(--ac) var(--solid-card-2)}
  .cs-menu::-webkit-scrollbar,.ms-menu::-webkit-scrollbar,.topnav-menu::-webkit-scrollbar{width:10px}
  .cs-menu::-webkit-scrollbar-track,.ms-menu::-webkit-scrollbar-track,.topnav-menu::-webkit-scrollbar-track{background:var(--solid-card-2);border-radius:999px}
  .cs-menu::-webkit-scrollbar-thumb,.ms-menu::-webkit-scrollbar-thumb,.topnav-menu::-webkit-scrollbar-thumb{background:var(--ac);border-radius:999px;border:2px solid var(--solid-card-2)}
  .list-title,.list-meta,.nav-label,.nav-sub,.topnav-copy strong,.topnav-copy span,.cs-label,.ms-chip,.pill,.preview-name,.controller-name{
    min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .item-top > strong,.item-top > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .muted,.help{overflow-wrap:anywhere}
  @media(max-width:1100px){.split{grid-template-columns:1fr}}
  @media(max-width:900px){.main{padding:18px}.topbar{align-items:flex-start}.row{grid-template-columns:1fr}.split,#app > .split{grid-template-columns:1fr}.owner-summary{grid-template-columns:1fr}.topbar-right{width:100%;justify-content:stretch}.topbar-right > *{flex:1 1 180px}.pricing-card{min-height:0}}
  @media(max-width:560px){.main{padding:12px}.card{padding:14px}.item-top{align-items:flex-start}.controller-actions,.row{display:grid;grid-template-columns:1fr;width:100%}.btn,.btn-soft,.btn-danger{width:100%}.topnav-menu{left:0;right:auto;min-width:min(320px,calc(100vw - 28px))}}
 </style></head>
<body>
 <div id="auth" class="auth"><div class="auth-card"><h3>Dashboard Login</h3><div class="muted" style="margin-bottom:10px">Sign in with Discord to continue.</div><a id="authDiscord" class="btn" href="/login" style="display:block;text-align:center;text-decoration:none">Sign in with Discord</a><div class="muted" style="margin:12px 0 6px">or use a token</div><label>Token</label><input id="authToken" type="password" /><div class="row" style="margin-top:10px"><button id="authLogin" class="btn">Login</button></div><div id="authMsg" class="notice danger"></div></div></div>
 <div class="layout"><main class="main"><div class="topbar"><div class="topbar-left"><a class="brand-mini" href="/" title="Landing page"><img src="/assets/sync.png" alt="Tickets Dashboard" /></a><div class="titles"><h2 id="pageTitle" class="title">${pageTitle}</h2><div class="muted" id="pageHint">${pageDescriptionForPath(currentPath)}</div></div></div><div class="topbar-right"><a class="btn-soft server-icon-btn" href="/dashboard" title="Servers" aria-label="Servers"><span class="btn-icon">${dashboardIcon('servers')}</span></a><div id="topNav" class="topnav"><button id="topNavBtn" class="btn-soft topnav-btn" type="button"><span id="topNavLabel">Navigate</span><span class="chev">v</span></button><div id="topNavMenu" class="topnav-menu" role="menu"><div class="topnav-group"><div class="topnav-group-title">General</div>${topNavItem('/overview','Home','General','Snapshot and quick actions')}${topNavItem('/settings','Settings','General','Core config and routing')}${topNavItem('/availability','Availability','General','Queue status and overrides')}${topNavItem('/tutorials','Tutorials','General','Guides and walkthroughs')}</div><div class="topnav-group"><div class="topnav-group-title">Tickets</div>${topNavItem('/tickets','Tickets','Tickets','Active queue management')}${topNavItem('/transcripts','Transcripts','Tickets','Saved conversation history')}${topNavItem('/commands/ticket-types','Ticket Types','Tickets','Flow design and coverage')}${topNavItem('/panels','Panels','Tickets','Panel design and publishing')}${topNavItem('/commands/tag','Tags','Tickets','Reusable staff replies')}</div><div class="topnav-group"><div class="topnav-group-title">Tools</div>${topNavItem('/commands/feedback','Feedback','Content','Feedback destination and flow')}${topNavItem('/statistics','Statistics','Content','Trends and activity')}${topNavItem('/embed-editor','Branding','Custom','White-label identity')}${topNavItem('/documentation','Documentation','Content','Reference notes and placeholders')}</div><div class="topnav-group"><div class="topnav-group-title">Plans</div>${topNavItem('/pricing','Pricing','Billing','Plans and access')}${topNavItem('/upgrade','Upgrade','Billing','Upgrade options and sales')}</div></div></div><div id="themeNav" class="topnav"><button id="themeBtn" class="btn-soft topnav-btn" type="button"><span id="themeLabel">Theme</span><span class="chev">v</span></button><div class="topnav-menu" role="menu"><button type="button" class="topnav-item" data-theme-item="dark">Dark <span class="tag">Default</span></button><button type="button" class="topnav-item" data-theme-item="light">Light <span class="tag">Clean</span></button><button type="button" class="topnav-item" data-theme-item="ocean">Ocean <span class="tag">Cool</span></button><button type="button" class="topnav-item" data-theme-item="sunset">Sunset <span class="tag">Bold</span></button><button type="button" class="topnav-item" data-theme-item="diamond">Diamond <span class="tag">Custom</span></button><button type="button" class="topnav-item theme-secret" data-theme-item="hacker">Hacker <span class="tag">Secret</span></button></div></div><button id="refreshStateBtn" class="btn" style="padding:10px 16px"><span class="btn-icon">${dashboardIcon('restart')}</span><span>Refresh</span></button></div></div><div id="announcementBar"></div><div id="notice" class="notice"></div><section id="app"></section></main></div>
<script>
 let currentPath=${JSON.stringify(currentPath)},tokenKey='dashboard_token_ui',defaultEmbedTemplates=${JSON.stringify(DEFAULT_EMBED_TEMPLATES)};
const app=document.getElementById('app'),notice=document.getElementById('notice'),auth=document.getElementById('auth'),authDiscord=document.getElementById('authDiscord'),authToken=document.getElementById('authToken'),authMsg=document.getElementById('authMsg');
 const themeKey='dash_theme';
 const hackerUnlockKey='dash_hacker_unlocked';
 const isHackerUnlocked=()=>{try{return localStorage.getItem(hackerUnlockKey)==='true'}catch{return false}};
  const inferTheme=()=>{try{const saved=String(localStorage.getItem(themeKey)||'dark').toLowerCase();if(saved==='hacker'&&!isHackerUnlocked())return 'dark';return ['dark','light','ocean','sunset','hacker','diamond'].includes(saved)?saved:'dark'}catch{return 'dark'}};
  document.body.dataset.theme=inferTheme();
  document.body.dataset.hackerUnlocked=isHackerUnlocked()?'true':'false';
  let state=null;
  let ui=(()=>{try{const raw=sessionStorage.getItem('dash_ui');const parsed=raw?JSON.parse(raw):{};return parsed&&typeof parsed==='object'?parsed:{};}catch{return {}}})();
 const saveUi=()=>{try{sessionStorage.setItem('dash_ui',JSON.stringify(ui||{}))}catch{}};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const createToastContainer=()=>{let container=document.getElementById('toast-container');if(!container){container=document.createElement('div');container.id='toast-container';container.className='toast-container';document.body.appendChild(container)}return container};
const note=(t,m='info')=>{const container=createToastContainer();if(!t||!String(t).trim()){notice.textContent='';notice.className='notice';return}notice.textContent='';notice.className='notice';const kind=['ok','danger','warn','info'].includes(m)?m:'info';const toast=document.createElement('div');toast.className='toast toast-'+kind;const icon=kind==='ok'?'OK':kind==='danger'?'!':kind==='warn'?'!':'i';const title={ok:'Saved',danger:'Error',warn:'Warning',info:'Notice'}[kind]||'Notice';toast.innerHTML='<span class="toast-icon">'+icon+'</span><div class="toast-content"><strong class="toast-title">'+title+'</strong><div class="toast-message">'+esc(t)+'</div></div><button class="toast-close" type="button" aria-label="Dismiss">x</button>';const close=()=>{toast.style.animation='toastSlideOut 180ms ease forwards';setTimeout(()=>{toast.remove();if(container.children.length===0)container.style.display='none'},180)};const closeBtn=toast.querySelector('.toast-close');if(closeBtn)closeBtn.onclick=close;container.appendChild(toast);container.style.display='flex';setTimeout(close,4000)};
async function api(path,opt={}){const h={'Content-Type':'application/json',...(opt.headers||{})};const tok=localStorage.getItem(tokenKey);if(tok)h['x-dashboard-token']=tok;const csrf=(state&&state.csrfToken)||'';if(csrf&&String(opt.method||'GET').toUpperCase()!=='GET')h['x-csrf-token']=csrf;const r=await fetch(path,{credentials:'include',...opt,headers:h});if(r.status===401){const next=encodeURIComponent(location.pathname+location.search);window.location='/login?next='+next;throw new Error('Unauthorized')}const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
function navTitleForPath(p){return ({ '/overview':'Home','/settings':'Settings','/availability':'Availability','/tutorials':'Tutorials','/commands/ticket-types':'Ticket Types','/panels':'Panels','/commands/tag':'Tags','/tickets':'Tickets','/transcripts':'Transcripts','/commands/feedback':'Feedback','/statistics':'Statistics','/embed-editor':'Branding','/pricing':'Pricing','/upgrade':'Upgrade','/documentation':'Documentation'}[p]||'Dashboard')}
function pageDescForPath(p){return ({ '/overview':'A cleaner snapshot of ticket activity, queue health, and the most common next actions.','/settings':'Core server configuration, routing, and system behavior in one place.','/availability':'Adjust queue expectations per ticket type without digging through commands.','/tutorials':'Guides, walkthroughs, and internal onboarding material for your staff.','/commands/ticket-types':'Shape each ticket flow, assign support coverage, and keep categories tidy.','/panels':'Design, save, and publish channel-specific ticket panels.','/commands/tag':'Store reusable answers and keep repeat support responses consistent.','/tickets':'Review active conversations, add notes, and handle escalations quickly.','/transcripts':'Browse saved transcripts and archive history without leaving the dashboard.','/commands/feedback':'Control where feedback lands and how the flow is presented.','/statistics':'Track recent performance, close reasons, and staff activity trends.','/embed-editor':'Customize server branding and reusable bot message templates.','/pricing':'Compare plans and see what is available for this server.','/upgrade':'Upgrade to Plus or contact sales for Pro plans.','/documentation':'Reference placeholders, templates, and dashboard usage notes.'}[p]||'Manage this part of the dashboard with a simpler, more focused layout.')}
function parseEmoji(raw){const s=String(raw||'').trim();if(!s)return null;const m=s.match(/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/);if(m)return{animated:m[1]==='a',name:m[2],id:m[3],raw:s};return{unicode:s,raw:s}}
function emojiHtml(raw){const e=parseEmoji(raw);if(!e)return '';if(e.id){const ext=e.animated?'gif':'png';return '<span class="emoji-inline"><img src="https://cdn.discordapp.com/emojis/'+e.id+'.'+ext+'?size=64&quality=lossless" alt="'+esc(e.name||'emoji')+'" /></span>'}return '<span class="emoji-inline">'+esc(e.unicode)+'</span>'}
function teamLabel(team){const src=team&&typeof team==='object'?team:{};const e=emojiHtml(src.emoji||'');return (e?e+' ':'')+esc(src.name||'')}
function rolePills(ids){const roles=(ids||[]).map(id=>state.roleCatalog.find(r=>r.id===id)).filter(Boolean);if(!roles.length)return '<span class="muted">No roles set</span>';return '<div class="roles">'+roles.map(r=>'<span class="role" style="--c:'+r.color+'"><span class="dot"></span>@'+esc(r.name)+'</span>').join('')+'</div>'}
 function roleSelect(selected,id){const roles=Array.isArray(state.roleCatalog)?state.roleCatalog:[];const selectedSet=new Set(selected||[]);const chips=roles.filter(r=>selectedSet.has(r.id)).map(r=>'<span class="ms-chip">@'+esc(r.name)+'</span>').join('');const checkSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';return '<div class="role-ms" data-role-ms="'+id+'"><button type="button" class="ms-trigger" data-ms-trigger="'+id+'"><span id="'+id+'Count">'+selectedSet.size+' selected</span><span class="cs-caret">v</span></button><div class="ms-menu"><div class="ms-toolbar"><input class="ms-search" data-ms-search="'+id+'" placeholder="Search roles" /><button type="button" class="chip-btn select-all" data-select="'+id+'">All</button><button type="button" class="chip-btn clear-all" data-select="'+id+'">Clear</button></div><div class="ms-list">'+roles.map(r=>'<label class="ms-item checkbox-wrapper" data-ms-item="'+id+'" data-name="'+esc(r.name).toLowerCase()+'"><input type="checkbox" data-ms-check="'+id+'" value="'+r.id+'" '+(selectedSet.has(r.id)?'checked':'')+' /><span class="checkmark">'+checkSvg+'</span><span class="label">@'+esc(r.name)+'</span></label>').join('')+'</div></div><div id="'+id+'Chips" class="ms-chips">'+chips+'</div></div>'}
function channelLabel(channelId,placeholder){const ch=(state.channelCatalog||[]).find(c=>c.id===channelId);return ch?('#'+ch.name):(placeholder||'Select a channel')}
function channelSelect(id,selectedId,placeholder){const channels=Array.isArray(state.channelCatalog)?state.channelCatalog:[];return '<div class="custom-select" data-cs="'+id+'"><input id="'+id+'" type="hidden" value="'+esc(selectedId||'')+'" /><button type="button" class="cs-trigger" data-cs-trigger="'+id+'"><span class="cs-label" id="'+id+'Label">'+esc(channelLabel(selectedId,placeholder))+'</span><span class="cs-caret">v</span></button><div class="cs-menu"><input class="cs-search" data-cs-search="'+id+'" placeholder="Search channels" /><div class="cs-list">'+['<button type="button" class="cs-opt '+(!selectedId?'active':'')+'" data-cs-opt="'+id+'" data-value="">'+esc(placeholder||'Select a channel')+'</button>'].concat(channels.map(ch=>'<button type="button" class="cs-opt '+(selectedId===ch.id?'active':'')+'" data-cs-opt="'+id+'" data-value="'+ch.id+'">#'+esc(ch.name)+'</button>')).join('')+'</div></div></div>'}
function categoryLabel(categoryId,placeholder){const ch=(state.categoryCatalog||[]).find(c=>c.id===categoryId);return ch?(ch.name):(placeholder||'Select a category')}
function categorySelect(id,selectedId,placeholder){const cats=Array.isArray(state.categoryCatalog)?state.categoryCatalog:[];return '<div class="custom-select" data-cs="'+id+'"><input id="'+id+'" type="hidden" value="'+esc(selectedId||'')+'" /><button type="button" class="cs-trigger" data-cs-trigger="'+id+'"><span class="cs-label" id="'+id+'Label">'+esc(categoryLabel(selectedId,placeholder))+'</span><span class="cs-caret">v</span></button><div class="cs-menu"><input class="cs-search" data-cs-search="'+id+'" placeholder="Search categories" /><div class="cs-list">'+['<button type="button" class="cs-opt '+(!selectedId?'active':'')+'" data-cs-opt="'+id+'" data-value="">'+esc(placeholder||'Use default ticket category')+'</button>'].concat(cats.map(ch=>'<button type="button" class="cs-opt '+(selectedId===ch.id?'active':'')+'" data-cs-opt="'+id+'" data-value="'+ch.id+'">'+esc(ch.name)+'</button>')).join('')+'</div></div></div>'}
 function renderSettings(){
 const teams=Array.isArray(state.supportTeams)?state.supportTeams:[];
  const ai=state&&state.aiAccess?state.aiAccess:{plan:'none',enabled:false,statusLabel:'No AI subscription',trialRemainingDays:0};
  const isOwner=Boolean(state&&state.access&&state.access.isOwner);
  const selectedName=(ui&&ui.selectedTeam)?String(ui.selectedTeam):'';
  const selectedTeam=teams.find(t=>t&&t.name===selectedName)||null;
  const list=teams
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
    const active=t&&t.name===selectedName;
    return '<button type="button" class="list-btn teamPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
     '<div class="list-title">'+teamLabel(t)+'</div>'+
     '<div class="list-meta">'+esc((t.roleIds||t.roleId?[].concat(t.roleIds||[],t.roleId||[]).filter(Boolean).length:0))+' role(s)</div>'+
    '</button>';
   }).join('')||'<div class="muted">No support teams yet.</div>';

 return '<div class="grid">'+
   '<div class="card">'+
    '<h3>Guild Settings</h3>'+
    '<label>Feedback Channel</label>'+
    channelSelect('feedbackId',state.botConfig.appealsChannelId||'','Select feedback channel')+
    '<div class="help">Pick a channel by name (no IDs needed).</div>'+
    '<div style="margin-top:12px;display:flex;gap:10px">'+
      '<button id="saveConfig" class="btn" style="width:auto">Save Settings</button>'+
    '</div>'+
   '</div>'+

   '<div class="card">'+
    '<h3>General Ticket Panel</h3>'+
    '<p class="muted">This controls the default support panel content for this server.</p>'+
    '<label>Panel Title</label>'+
    '<input id="panelTitle" value="'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.title)||'Support Desk')+'" placeholder="Support Desk" />'+
    '<label>Panel Description</label>'+
    '<textarea id="panelDescription" placeholder="Explain how users should open tickets.">'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.description)||'')+'</textarea>'+
    '<label>Panel Advisory</label>'+
    '<textarea id="panelAdvisory" placeholder="Rules, monitoring notice, or policy links.">'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.advisory)||'')+'</textarea>'+
    '<div style="margin-top:12px;display:flex;gap:10px">'+
      '<button id="savePanelConfig" class="btn" style="width:auto">Save Panel</button>'+
    '</div>'+
   '</div>'+

   '<div class="card">'+
    '<h3>AI Access</h3>'+
    '<div class="pill '+(ai.premiumActive?'ok':ai.trialActive?'warn':ai.expiredTrial?'danger':'')+'">'+esc(ai.statusLabel||'Free plan')+'</div>'+
    '<p class="muted" style="margin-top:10px">'+(ai.hasAccess
        ? 'AI suggested replies are enabled for this server.'
        : 'This server does not own a Plus AI subscription. Ask the bot owner for access or a trial.')+'</p>'+
    '<div style="margin-top:12px"><button id="aiUpsell" class="btn-soft" type="button">Learn About AI Access</button></div>'+
   '</div>'+
  '</div>'+

  '<div class="split" style="margin-top:14px">'+
    '<div class="card list-card">'+
      '<div class="list-head">'+
        '<div>'+
          '<h3 style="margin:0">Support Teams</h3>'+
          '<div class="muted">Select a team to edit.</div>'+
        '</div>'+
        '<button id="newTeamBtn" class="btn-soft" style="width:auto">New</button>'+
      '</div>'+
      '<input id="teamSearch" placeholder="Search teams..." />'+
      '<div class="list list-compact" id="teamsList" style="margin-top:10px">'+list+'</div>'+
    '</div>'+

    '<div class="card">'+
      '<h3>'+(selectedTeam?'Edit Team':'Create Team')+'</h3>'+
      '<div class="muted" style="margin-bottom:10px">'+(selectedTeam?('Editing: '+esc(selectedTeam.name)):'Create a new team and assign roles.')+'</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Team Name</label>'+
          '<input id="stName" placeholder="Billing" />'+
          '<div class="help">This should match the Ticket Type name you want it to support.</div>'+
        '</div>'+
        '<div>'+
          '<label>Team Emoji</label>'+
          '<input id="stEmoji" placeholder="emoji or &lt;:custom:123&gt;" />'+
          '<div class="help">Shown on buttons where supported.</div>'+
        '</div>'+
      '</div>'+

      '<label>Team Roles</label>'+
      roleSelect([],'stRoles')+
      '<div class="help">Pick roles by name; multiple roles are supported.</div>'+

      '<div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">'+
        '<button id="saveTeam" class="btn">Save</button>'+
        '<button id="resetTeam" class="btn-soft">Clear</button>'+
        (selectedTeam?'<button id="deleteTeamBtn" class="btn-danger">Delete</button>':'')+
      '</div>'+
    '</div>'+
  '</div>';
 }
function availabilityLabel(status){if(status==='reduced_assistance')return 'Reduced Assistance';if(status==='increased_volume')return 'Increased Volume';return 'Available'}
function availabilityBadge(info){const s=info.status||'available';const cls=s==='reduced_assistance'?'danger':(s==='increased_volume'?'warn':'ok');const src=info.source==='manual'?'Manual':'Auto';return '<span class="pill '+cls+'">'+availabilityLabel(s)+'</span> <span class="muted">'+src+' - '+(info.count||0)+' active</span>'}
function renderAvailability(){const types=(state.ticketTypes||[]);const byKey=new Map((state.availability||[]).map(v=>[v.key,v]));const opts='<option value=\"auto\">Automatic</option><option value=\"available\">Available</option><option value=\"increased_volume\">Increased Volume</option><option value=\"reduced_assistance\">Reduced Assistance</option>';const rows=types.map(t=>{const key=String(t.name||'').trim().toLowerCase();const info=byKey.get(key)||{status:'available',count:0,source:'automatic'};const manual=info.manualStatus||'auto';return '<div class=\"item\"><div class=\"item-top\"><strong>'+esc(t.name)+'</strong><span>'+availabilityBadge(info)+'</span></div><div class="row" style="margin-top:8px"><div><label>Override</label><select class="availSelect" data-name="'+esc(t.name)+'\">'+opts.replace('value=\"'+esc(manual)+'\"','value=\"'+esc(manual)+'\" selected')+'</select></div><div><label>Automatic</label><div class="muted">'+availabilityLabel(info.automaticStatus||'available')+'</div></div></div></div>'}).join('');return '<div class="grid"><div class="card"><h3>Ticket Availability</h3><p class="muted">Overrides apply per ticket type. Automatic mode uses active ticket thresholds.</p></div><div class="card"><h3>Per Ticket Type</h3><div class="list\">'+(rows||'<span class="muted">No ticket types configured yet.</span>')+'</div></div></div>'}
 function renderTypes(){
  const types=Array.isArray(state.ticketTypes)?state.ticketTypes:[];
  const selectedName=(ui&&ui.selectedType)?String(ui.selectedType):'';
  const selectedType=types.find(t=>t&&t.name===selectedName)||null;
  const list=types
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
     const active=t&&t.name===selectedName;
     const e=emojiHtml(t.emoji||'');
     const cat=(state.categoryCatalog||[]).find(c=>c.id===t.categoryId)?.name||'Default';
     return '<button type="button" class="list-btn ttPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
       '<div class="list-title">'+(e?e+' ':'')+esc(t.name)+'</div>'+
       '<div class="list-meta">'+esc(cat)+' - '+(t.requireReason===false?'No reason':'Reason required')+' - '+(t.allowAttachments===false?'No files':'Files ok')+'</div>'+
     '</button>';
   }).join('')||'<div class="muted">No ticket types yet.</div>';

  return '<div class="split">'+
    '<div class="card list-card">'+
      '<div class="list-head">'+
        '<div>'+
          '<h3 style="margin:0">Ticket Types</h3>'+
          '<div class="muted">Select a type to edit.</div>'+
        '</div>'+
        '<button id="newTypeBtn" class="btn-soft" style="width:auto">New</button>'+
      '</div>'+
      '<input id="typeSearch" placeholder="Search ticket types..." />'+
      '<div class="list list-compact" id="typesList" style="margin-top:10px">'+list+'</div>'+
    '</div>'+

    '<div class="card">'+
      '<h3>'+(selectedType?'Edit Ticket Type':'Create Ticket Type')+'</h3>'+
      '<div class="muted" style="margin-bottom:10px">'+(selectedType?('Editing: '+esc(selectedType.name)):'Create a new type, then configure its behavior.')+'</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Name</label>'+
          '<input id="ttName" placeholder="General Support" />'+
          '<div class="help">Displayed to users; also used to match Support Teams.</div>'+
        '</div>'+
        '<div>'+
          '<label>Emoji</label>'+
          '<input id="ttEmoji" placeholder="emoji or &lt;:custom:123&gt;" />'+
          '<div class="help">Optional; appears on buttons when available.</div>'+
        '</div>'+
      '</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Accent Color</label>'+
          '<input id="ttColor" value="#5865F2" />'+
          '<div class="help">Used in dashboard previews and embeds.</div>'+
        '</div>'+
        '<div>'+
          '<label>Channel Name Format</label>'+
          '<input id="ttFormat" placeholder="#support-{username}" />'+
          '<div class="help">Use presets or placeholders: <code>{number}</code>, <code>{userId}</code>, <code>{username}</code>, <code>{priority}</code>, <code>{type}</code>, <code>{suffix}</code>.</div>'+
        '</div>'+
      '</div>'+

      '<label>Format Presets</label>'+
      '<select id="ttFormatPreset">'+
        '<option value="">Choose a preset...</option>'+
        '<option value="ticket-{number}">ticket-1, ticket-2</option>'+
        '<option value="ticket-{userId}">ticket-(userid)</option>'+
        '<option value="{priority}-ticket-{number}">(priority)-ticket-(number)</option>'+
        '<option value="{type}-{number}">(type)-(number)</option>'+
        '<option value="{username}-{suffix}">(username)-(short id)</option>'+
      '</select>'+

      '<label>Ticket Category</label>'+
      categorySelect('ttCategory','','Use default ticket category')+
      '<div class="help">Routes tickets for this type into a Discord category.</div>'+

      '<label>Aliases</label>'+
      '<textarea id="ttAliases" placeholder="support, gs, general"></textarea>'+
      '<div class="help">Comma or newline separated.</div>'+

      '<label>Support Team Roles</label>'+
      roleSelect([],'ttRoles')+
      '<div class="help">Roles that can view/respond in the ticket channel.</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Open Message Title</label>'+
          '<input id="ttOpenTitle" placeholder="{ticketType}" />'+
        '</div>'+
        '<div>'+
          '<label>Open Message Description</label>'+
          '<textarea id="ttOpenDescription" placeholder="Requester: {requester}\\nReason: {reason}"></textarea>'+
          '<div class="help">Supports placeholders like <code>{requester}</code>, <code>{reason}</code>, <code>{channel}</code>.</div>'+
        '</div>'+
      '</div>'+

      '<div class="row" style="grid-template-columns:1fr 1fr">'+
        '<div style="display:grid;gap:6px;margin-top:6px">'+
         '<label class="checkbox-wrapper">'+
          '<input type="checkbox" id="ttRequireReason" checked />'+
          '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'+
          '<span class="label">Require reason</span>'+
         '</label>'+
         '<label class="checkbox-wrapper">'+
          '<input type="checkbox" id="ttAllowFiles" checked />'+
          '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'+
          '<span class="label">Allow file uploads</span>'+
         '</label>'+
        '</div>'+
      '</div>'+

      '<div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">'+
        '<button id="saveType" class="btn">Save</button>'+
        '<button id="resetType" class="btn-soft">Clear</button>'+
        (selectedType?'<button id="deleteTypeBtn" class="btn-danger">Delete</button>':'')+
      '</div>'+
    '</div>'+
  '</div>';
 }
 function renderTags(){
  const tags=Array.isArray(state.tags)?state.tags:[];
  const selectedName=(ui&&ui.selectedTag)?String(ui.selectedTag):'';
  const selectedTag=tags.find(t=>t&&t.name===selectedName)||null;
  const list=tags
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
    const active=t&&t.name===selectedName;
    return '<button type="button" class="list-btn tagPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
      '<div class="list-title">'+esc(t.name)+'</div>'+
      '<div class="list-meta">'+esc(t.kind||'suggestion')+' - '+esc(t.title||'')+'</div>'+
    '</button>';
   }).join('')||'<div class="muted">No tags yet.</div>';

  return \`
  <div class="split">
    <div class="card list-card">
      <div class="list-head">
        <div>
          <h3 style="margin:0">Tags</h3>
          <div class="muted">Select a tag to edit.</div>
        </div>
        <button id="newTagBtn" class="btn-soft" style="width:auto">New</button>
      </div>
      <input id="tagSearch" placeholder="Search tags..." />
      <div class="list list-compact" id="tagsList" style="margin-top:10px">\${list}</div>
    </div>

    <div class="card">
      <h3>\${selectedTag?'Edit Tag':'Create Tag'}</h3>
      <div class="muted" style="margin-bottom:10px">\${selectedTag?('Editing: '+esc(selectedTag.name)):'Tags power AI suggestions/solutions.'}</div>

      <div class="row">
        <div>
          <label>Name</label>
          <input id="tagName" placeholder="refund" />
          <div class="help">Short identifier users might refer to.</div>
        </div>
        <div>
          <label>Type</label>
          <select id="tagKind">
            <option value="suggestion">Suggestion</option>
            <option value="solution">Solution</option>
          </select>
          <div class="help">Solutions show a resolved button in AI flows.</div>
        </div>
      </div>

      <label>Title</label>
      <input id="tagTitle" placeholder="Refund Policy" />

      <label>Description</label>
      <textarea id="tagDesc" placeholder="Explain what to do next..."></textarea>

      <label>Keywords</label>
      <textarea id="tagKeys" placeholder="refund, chargeback, billing"></textarea>
      <div class="help">Comma or newline separated.</div>

      <div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">
        <button id="saveTag" class="btn">Save</button>
        <button id="resetTag" class="btn-soft">Clear</button>
        \${selectedTag?'<button id="deleteTagBtn" class="btn-danger">Delete</button>':''}
      </div>
    </div>
  </div>\`;
 }
function renderTickets(){
 const tickets=Array.isArray(state.tickets)?state.tickets:[];
 const guildId=state.guildId||'';
 const canClose=Boolean(state&&state.access&&state.access.canCloseTickets);
 const canEscalate=Boolean(state&&state.access&&state.access.canManageEscalations);
 const canNotes=Boolean(state&&state.access&&state.access.canEditNotes);
 const typeOptions=['<option value=\"\">All ticket types</option>'].concat((state.ticketTypes||[]).map(t=>'<option value=\"'+esc(t.name||'')+'\">'+esc(t.name||'')+'</option>')).join('');
 const escalationLabel=(level)=>level==='immediate'?'Immediate':level==='high'?'High':level==='medium'?'Medium':'None';
 const row=t=>{
  const name=t.channelName?('#'+t.channelName):('Ticket Channel');
  const url=guildId?('https://discord.com/channels/'+guildId+'/'+t.channelId):'';
  const topName=url?('<a href=\"'+esc(url)+'\" target=\"_blank\" rel=\"noreferrer\" style=\"color:inherit;text-decoration:none\">'+esc(name)+'</a>'):esc(name);
  const createdAt=esc(String(t.createdAt||'').replace('T',' ').slice(0,19));
  const u=(id)=>id?('<span class=\"mention user\">@'+esc(String(id).slice(0,10))+'</span>'):'<span class=\"muted\">(unknown)</span>';
  const claimed=t.claimedBy?u(t.claimedBy):'<span class=\"muted\">(unclaimed)</span>';
  const created=t.createdBy?u(t.createdBy):'<span class=\"muted\">(unknown)</span>';
  const type=esc(t.ticketType||'Unknown');
  const escalations=Array.isArray(t.escalations)?t.escalations:[];
  const latestEsc=escalations.length?escalations[escalations.length-1]:null;
  const escBadge=latestEsc?('<span class="pill '+(latestEsc.level==='immediate'?'danger':latestEsc.level==='high'?'warn':'')+'">Escalation: '+esc(escalationLabel(latestEsc.level))+'</span>'):'<span class="pill">Escalation: None</span>';
  const notes=Array.isArray(t.notes)?t.notes:[];
  const notesHtml=notes.length?notes.slice(-5).map(n=>'<div class="item" style="padding:10px 12px"><div><strong>'+esc((n.authorId||'staff').slice(0,12))+'</strong><div class="muted">'+esc(String(n.createdAt||'').replace('T',' ').slice(0,19))+'</div></div><div style="margin-top:6px;white-space:pre-wrap">'+esc(n.body||'')+'</div></div>').join(''):'<div class="muted">No notes yet.</div>';
  const noteComposer=canNotes?('<textarea class="ticketNoteBody" data-id="'+esc(t.channelId)+'" placeholder="Add an internal note..."></textarea><div class="row" style="margin-top:8px">'+
    '<button class="btn saveTicketNote" data-id="'+esc(t.channelId)+'">Save Note</button>'+
    (canEscalate?'<select class="ticketEscalationLevel" data-id="'+esc(t.channelId)+'"><option value="">Escalate...</option><option value="medium">Medium</option><option value="high">High</option><option value="immediate">Immediate</option></select><button class="btn-soft applyTicketEscalation" data-id="'+esc(t.channelId)+'">Apply</button>':'')+
   '</div>'):'';
  return '<div class="item"><div class="item-top"><strong>'+topName+'</strong><div style="display:flex;gap:6px"><button class="btn-soft copyTicket" data-id="'+esc(t.channelId)+'">Copy Link</button>'+(canClose?'<button class="btn-danger closeTicket" data-id="'+esc(t.channelId)+'">Close</button>':'')+'</div></div><div class="muted">Type: <strong>'+type+'</strong> &bull; Opened by '+created+' &bull; Claimed: '+claimed+(createdAt?' &bull; '+createdAt:'')+'</div><div style="margin-top:8px">'+escBadge+'</div><details class="acc" style="margin-top:10px"><summary><span>Internal Notes</span><span class="pill">'+notes.length+'</span></summary><div class="acc-body">'+notesHtml+noteComposer+'</div></details></div>';
 };

 const massClose=canClose?'<details class="acc"><summary><span>Advanced: Mass Close</span><span class="pill warn">Danger</span></summary><div class="acc-body">'+
  '<p class="muted">Closes matching active tickets and generates transcripts. Use carefully.</p>'+
  '<div class="row"><div><label>Ticket Type</label><select id="massCloseType">'+typeOptions+'</select></div><div><label>Limit</label><input id="massCloseLimit" type="number" value="25" min="1" max="100" /></div></div>'+
  '<label>Reason</label><input id="massCloseReason" placeholder="Mass closed via dashboard." />'+
  '<div class="row" style="margin-top:10px"><button id="massCloseBtn" class="btn-danger">Mass Close</button><button id="refreshTickets" class="btn-soft">Refresh</button></div>'+
 '</div></details>':'';

 return '<div class="grid">'+
  '<div class="card"><h3>Tickets</h3><p class="muted">A calmer queue view with escalation and internal notes for the team.</p>'+massClose+'</div>'+
  '<div class="card"><h3>Active Tickets</h3><div class="row"><div><label>Search</label><input id="ticketSearch" placeholder="#channel, type, user id..." /></div></div><div id="ticketsList" class="list" style="margin-top:10px">'+(tickets.length?tickets.map(row).join(''):'<div class="muted">No active tickets.</div>')+'</div></div>'+
 '</div>';
}
function renderTranscripts(){
 const items=Array.isArray(state.transcripts)?state.transcripts:[];
 const retention=Number(state.transcriptRetentionDays||0);
 const hint=retention>0?('Transcripts auto-delete after '+retention+' day(s).'):('Transcript retention is disabled.');
  const bytes=(n)=>{const v=Number(n||0);if(!v)return '-';const units=['B','KB','MB','GB'];let i=0,x=v;while(x>=1024&&i<units.length-1){x/=1024;i+=1}const out=i===0?String(x):x.toFixed(x<10?1:0);return out+' '+units[i]};
 const u=(id)=>id?('<span class=\"mention user\">@'+esc(String(id).slice(0,10))+'</span>'):'<span class=\"muted\">(unknown)</span>';
 const expires=(archivedAt)=>{if(!(retention>0)||!archivedAt)return '';const ts=Date.parse(archivedAt);if(!Number.isFinite(ts))return '';return new Date(ts+(retention*86400000)).toISOString().replace('T',' ').slice(0,19)};
 const row=t=>{
  const id=String(t.channelId||'');
  const title=t.channelName?('#'+t.channelName):('Transcript '+id.slice(0,10));
  const type=esc(t.ticketType||'Unknown');
  const archivedAt=String(t.archivedAt||t.closedAt||'');
  const closedAt=esc(archivedAt.replace('T',' ').slice(0,19));
  const opener=t.createdBy?u(t.createdBy):'<span class=\"muted\">(unknown)</span>';
  const closer=t.closedBy?u(t.closedBy):'<span class=\"muted\">(system)</span>';
  const size=esc(bytes(t.size));
   const exp=expires(archivedAt);
   const hay=[id,t.channelName,t.ticketType,t.createdBy,t.claimedBy,t.closedBy].filter(Boolean).join(' ').toLowerCase();
   const noteCount=Array.isArray(t.notes)?t.notes.length:0;
   const token=String(t.publicToken||'');
   const viewUrl=token?('/t/'+encodeURIComponent(token)):('/transcripts/'+encodeURIComponent(id));
   const downloadUrl=viewUrl+(viewUrl.includes('?')?'&':'?')+'download=1';
   const notes=noteCount?('<details class=\"acc\" style=\"margin-top:8px\"><summary><span>Notes</span><span class=\"pill\">'+noteCount+'</span></summary><div class=\"acc-body\">'+t.notes.slice(-5).map(n=>'<div class=\"item\" style=\"padding:10px 12px\"><div><strong>'+esc(String(n.authorId||'staff').slice(0,12))+'</strong><div class=\"muted\">'+esc(String(n.createdAt||'').replace('T',' ').slice(0,19))+'</div></div><div style=\"margin-top:6px;white-space:pre-wrap\">'+esc(n.body||'')+'</div></div>').join('')+'</div></details>'):'';
   const reason=t.closeReason?('<details class=\"acc\" style=\"margin-top:8px\"><summary><span>Reason</span><span class=\"pill\">View</span></summary><div class=\"acc-body\"><div class=\"muted\">'+esc(t.closeReason)+'</div></div></details>'):'';
   return '<div class=\"item transcriptItem\" data-hay=\"'+esc(hay)+'\"><div class=\"item-top\"><strong>'+esc(title)+'</strong><div style=\"display:flex;gap:6px\">'+
    '<button class=\"btn-soft viewTranscript\" data-url=\"'+esc(viewUrl)+'\">View</button>'+
    '<button class=\"btn-soft downloadTranscript\" data-url=\"'+esc(downloadUrl)+'\">Download</button>'+
    ''+
   '</div></div><div class=\"muted\">Type: <strong>'+type+'</strong> &bull; Opened by '+opener+' &bull; Closed by '+closer+(closedAt?' &bull; '+closedAt:'')+' &bull; '+size+(exp?(' &bull; Expires '+esc(exp)):'')+'</div>'+reason+notes+'</div>';
 };

 return '<div class=\"grid\">'+
  '<div class=\"card\"><h3>Transcripts</h3><p class=\"muted\">Browse saved ticket transcripts. '+esc(hint)+'</p><div class=\"row\"><div><label>Search</label><input id=\"transcriptSearch\" placeholder=\"#channel, type, user id...\" /></div></div></div>'+
  '<div class=\"card\"><h3>Saved Transcripts</h3><div id=\"transcriptsList\" class=\"list\" style=\"margin-top:10px\">'+(items.length?items.map(row).join(''):'<div class=\"muted\">No transcripts saved yet.</div>')+'</div></div>'+
 '</div>';
}
function renderPanels(){const panels=(state.guildConfigSummary&&state.guildConfigSummary.panels)||{};const selected=String((ui&&ui.selectedPanelChannel)||Object.keys(panels)[0]||'');const panel=selected&&panels[selected]&&typeof panels[selected]==='object'?panels[selected]:{};const toSelectValue=s=>String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,90);const typeOptions=['<option value="">Select ticket type</option>'].concat((state.ticketTypes||[]).map(t=>{const v=String(t.name||'');const selectValue=String(t.selectValue||toSelectValue(v));const current=String(panel.ticketType||'');const sel=(current===v||current===selectValue)?' selected':'';return '<option value="'+esc(v)+'"'+sel+'>'+esc(v)+'</option>'})).join('');const rows=Object.entries(panels).map(([id,p])=>'<button type="button" class="list-btn panelPick '+(id===selected?'active':'')+'" data-id="'+esc(id)+'"><div class="list-title">'+esc(p.title||p.name||channelLabel(id,'Panel'))+'</div><div class="list-meta">'+esc(channelLabel(id,'No channel'))+' &middot; '+esc((p.mode==='single'?'Single type':'Multi selector'))+'</div></button>').join('')||'<div class="muted">No custom panels yet.</div>';return '<div class="split"><div class="card list-card"><div class="list-head"><div><h3 style="margin:0">Panel Library</h3><div class="muted">Each channel can have its own panel copy and button.</div></div><button id="newPanelBtn" class="btn-soft" style="width:auto">New</button></div><div class="list list-compact" id="panelsList" style="margin-top:10px">'+rows+'</div></div><div class="card"><h3>'+(selected?'Edit Panel':'Create Panel')+'</h3><label>Destination Channel</label>'+channelSelect('panelChannel',selected,'Select panel channel')+'<div class="row"><div><label>Panel Mode</label><select id="panelMode"><option value="multi" '+(panel.mode!=='single'?'selected':'')+'>Multi-panel selector</option><option value="single" '+(panel.mode==='single'?'selected':'')+'>Single ticket type</option></select></div><div><label>Ticket Type</label><select id="panelTicketType">'+typeOptions+'</select></div></div><label>Panel Title</label><input id="panelEditTitle" value="'+esc(panel.title||panel.name||'Support Desk')+'" /><label>Panel Description</label><textarea id="panelEditDescription" style="min-height:150px" placeholder="Explain what this panel is for.">'+esc(panel.description||'')+'</textarea><label>Button Text</label><input id="panelButtonLabel" value="'+esc(panel.buttonLabel||'Select a prompt')+'" maxlength="80" /><label>Advisory</label><textarea id="panelEditAdvisory" placeholder="Rules, policy notes, or expected response times.">'+esc(panel.advisory||'')+'</textarea><div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr"><button id="savePanelDesign" class="btn">Save Panel</button><button id="publishPanelDesign" class="btn-soft">Publish Panel</button></div><div class="preview-shell" style="margin-top:14px"><div class="preview-msg"><div class="preview-avatar"></div><div class="preview-content"><div class="preview-name">'+esc((state.guildConfigSummary&&state.guildConfigSummary.branding&&state.guildConfigSummary.branding.botName)||'Tickets Bot')+' <span class="preview-tag">BOT</span></div><div class="preview-embed"><div class="preview-bar"></div><div class="preview-main"><div class="preview-title" id="panelPreviewTitle"></div><div class="preview-desc" id="panelPreviewDesc"></div><button type="button" class="btn-soft" id="panelPreviewButton" style="width:auto;margin-top:12px"></button></div></div></div></div></div></div></div>'}
function renderFeedback(){const feedbackChannel=state.botConfig.appealsChannelId||'';return '<div class="split">'+
 '<div class="card list-card"><div class="list-head"><div><h3 style="margin:0">Feedback Flow</h3><div class="muted">Choose where completed ticket feedback is sent.</div></div><span class="pill '+(feedbackChannel?'ok':'warn')+'">'+(feedbackChannel?'Ready':'Needs channel')+'</span></div><div class="list" style="margin-top:14px">'+
  '<div class="item"><div><strong>User runs /feedback</strong><div class="muted">Only the ticket opener can submit it after a staff member claims the ticket.</div></div></div>'+
  '<div class="item"><div><strong>Modal collects score and comments</strong><div class="muted">Ratings are validated from 1 to 5 before anything is posted.</div></div></div>'+
  '<div class="item"><div><strong>Staff channel receives the report</strong><div class="muted">The report includes ticket, requester, assigned staff, score, and comments.</div></div></div>'+
 '</div></div>'+
 '<div class="card"><h3>Configuration</h3><label>Feedback Channel</label>'+channelSelect('feedbackConfigId',feedbackChannel,'Select feedback channel')+'<div class="help">Use a private staff channel so customer comments stay internal.</div><div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr"><button id="saveFeedback" class="btn">Save Feedback</button><button id="feedbackCopyCommand" class="btn-soft" type="button">Copy /feedback</button></div></div>'+
 '<div class="card"><h3>User Preview</h3><div class="preview-shell"><div class="preview-msg"><div class="preview-avatar"></div><div class="preview-content"><div class="preview-name">'+esc((state.guildConfigSummary&&state.guildConfigSummary.branding&&state.guildConfigSummary.branding.botName)||'Tickets Bot')+' <span class="preview-tag">BOT</span></div><div class="preview-embed"><div class="preview-bar"></div><div class="preview-main"><div class="preview-title">Support Feedback</div><div class="preview-desc">Rating: 1-5\\nComments: optional details about the support experience.</div></div></div></div></div></div><div class="item" style="margin-top:12px"><div><strong>Best practice</strong><div class="muted">Ask for feedback before closing high-touch support tickets so your team has a clean quality signal.</div></div></div></div>'+
'</div>'}
function renderAppeal(){return renderFeedback()}
function renderStats(){const stats=state.statistics||{};const t=stats.totals||{activeTickets:0,totalClaimed:0,totalClosed:0};const top=(stats.topCloseReasons||[]).slice(0,6);const tags=(stats.tagUsage||[]).slice(0,6);return '<div class="grid">'+
 '<div class="card" style="grid-column:1/-1"><h3>Statistics Overview</h3><div class="stat-strip"><div class="stat-tile"><div class="muted">Active tickets</div><strong>'+t.activeTickets+'</strong></div><div class="stat-tile"><div class="muted">Claims</div><strong>'+t.totalClaimed+'</strong></div><div class="stat-tile"><div class="muted">Closed</div><strong>'+t.totalClosed+'</strong></div><div class="stat-tile"><div class="muted">Close rate</div><strong>'+Math.round((t.totalClosed/Math.max(1,t.totalClaimed))*100)+'%</strong></div></div></div>'+
 '<div class="card" style="grid-column:1/-1"><div class="item-top"><h3>Activity Graph</h3><div class="row" style="width:auto"><button class="btn-soft statsView" data-chart="bar">Bar</button><button class="btn-soft statsView" data-chart="line">Line</button><button class="btn-soft statsView" data-chart="area">Area</button></div></div><canvas id="statsChart" height="260" style="width:100%;max-height:320px"></canvas><div class="muted">Switch views to compare claimed and closed tickets over the last 14 days.</div></div>'+
 '<div class="card"><h3>Top Close Reasons</h3><div class="list">'+(top.length?top.map(r=>'<div class="item"><strong>'+esc(r.reason||'Unknown')+'</strong><span class="pill">'+esc(r.count||0)+'</span></div>').join(''):'<div class="muted">No close reason data yet.</div>')+'</div></div>'+
 '<div class="card"><h3>Popular Tags</h3><div class="list">'+(tags.length?tags.map(r=>'<div class="item"><strong>'+esc(r.name||'Unknown')+'</strong><span class="pill">'+esc(r.count||0)+'</span></div>').join(''):'<div class="muted">No tag data yet.</div>')+'</div></div>'+
 '<div class="card"><h3>Support Member Lookup</h3><label>User (ID or mention)</label><input id="staffLookupQuery" placeholder="<@123> or 123..." /><div class="row" style="margin-top:10px"><button id="staffLookupBtn" class="btn">Lookup</button><button id="staffLookupClear" class="btn-soft">Clear</button></div><div id="staffLookupResult" class="list" style="margin-top:10px"></div></div>'+
 '</div>'}
function renderBranding(){const templates=state.botConfig.embedTemplates||defaultEmbedTemplates;const keys=Object.keys(templates);const firstKey=keys[0]||'ticketClaimed';const first=templates[firstKey]||{title:'',description:'',color:'#5865F2'};const brand=(state.guildConfigSummary&&state.guildConfigSummary.branding)||{};const customBot=(state.aiAccess&&state.aiAccess.customBot)||{};const templateList=keys.map(k=>'<button type="button" class="list-btn brandTemplatePick '+(k===firstKey?'active':'')+'" data-key="'+esc(k)+'"><div class="list-title">'+esc(k)+'</div><div class="list-meta">'+esc(((templates[k]&&templates[k].title)||'No title'))+'</div></button>').join('')||'<div class="muted">No templates found.</div>';return '<div class="split">'+
 '<div class="card list-card"><div class="list-head"><div><h3 style="margin:0">Branding</h3><div class="muted">Edit your server identity and message templates in one place.</div></div><button id="saveServerBranding" class="btn-soft" type="button" style="width:auto">Save Identity</button></div><label>Display Name</label><input id="serverBrandName" value="'+esc(brand.botName||customBot.botName||'Tickets Bot')+'" placeholder="Tickets Bot" maxlength="80" /><label>Avatar URL</label><input id="serverBrandAvatar" value="'+esc(brand.avatarUrl||customBot.avatarUrl||'')+'" placeholder="https://..." /><div class="row"><div><label>Accent Color</label><input id="serverBrandAccent" value="'+esc(brand.accentColor||'#67E8F9')+'" placeholder="#67E8F9" maxlength="16" /></div><div><label>Footer Text</label><input id="serverBrandFooter" value="'+esc(brand.footerText||customBot.statusText||'')+'" placeholder="Powered by support" maxlength="120" /></div></div><div class="list list-compact" style="margin-top:14px">'+templateList+'</div></div>'+
 '<div class="card"><h3>Message Template</h3><div class="item" style="margin-bottom:12px"><div class="muted">Use <code>[[divider]]</code>, <code>[[divider:large]]</code>, <code>[[space]]</code>, or <code>[[space:large]]</code> on their own line for Components V2 spacing.</div></div><div class="row"><div><label>Template</label><select id="brandingKey">'+keys.map(k=>'<option value="'+esc(k)+'">'+esc(k)+'</option>').join('')+'</select></div><div><label>Accent Color</label><input id="brandingColor" value="'+esc(first.color||'#5865F2')+'" placeholder="#5865F2" maxlength="16" /></div></div><label>Title</label><input id="brandingTitle" value="'+esc(first.title||'')+'" maxlength="180" /><label>Description</label><textarea id="brandingDescription" style="min-height:180px">'+esc(first.description||'')+'</textarea><div class="row" style="margin-top:10px"><button id="applyBrandingTemplate" class="btn-soft">Apply Template</button><button id="saveBranding" class="btn">Save Templates</button></div><div class="row" style="margin-top:10px"><button id="resetBrandingDefaults" class="btn-soft">Reset Defaults</button><button id="formatBrandingJson" class="btn-soft">Format JSON</button></div></div>'+
 '<div class="card"><h3>Live Preview</h3><div class="preview-shell"><div class="preview-msg"><div class="preview-avatar" id="brandingPreviewAvatar"></div><div class="preview-content"><div class="preview-name" id="brandingPreviewName">'+esc(brand.botName||customBot.botName||'Tickets Bot')+' <span class="preview-tag">BOT</span></div><div id="brandingPreviewEmbed" class="preview-embed"><div id="brandingPreviewBar" class="preview-bar"></div><div class="preview-main"><div id="brandingPreviewTitle" class="preview-title"></div><div id="brandingPreviewDesc" class="preview-desc"></div></div></div></div></div></div><details class="acc" style="margin-top:14px"><summary><span>Advanced JSON</span><span class="pill">Optional</span></summary><div class="acc-body"><textarea id="brandingTemplates" style="min-height:240px;font-family:Consolas,monospace">'+esc(JSON.stringify(templates,null,2))+'</textarea></div></details></div>'+
'</div>'}
function renderPricing(){const plans=[{name:'Free',price:'$0',description:'Core support tools for getting started',features:['Unlimited tickets','Ticket panels','Logs and transcripts','Dashboard access'],active:true},{name:'Plus',price:'£8.99',description:'Better visibility for growing teams',features:['Statistics','Staff activity tracking','Priority support','Everything in Free'],featured:true},{name:'Pro',price:'£14.99',description:'Automation for busier support teams',features:['AI moderation','Advanced analytics','Higher automation limits','Everything in Plus']},{name:'Enterprise',price:'Custom',description:'Custom branded bot and guided setup',features:['Custom bot runtime','Developer Portal guidance','Webhook monitoring','Everything in Pro']}];const rows=[['Tickets','Yes','Yes','Yes','Yes'],['Panels','Yes','Yes','Yes','Yes'],['Logs and Transcripts','Yes','Yes','Yes','Yes'],['Statistics','No','Yes','Yes','Yes'],['AI Moderation','No','No','Yes','Yes'],['Custom Branded Bot','No','No','No','Yes'],['Priority Support','No','Yes','Yes','Yes']];const faqs=[{q:'Can I start on Free and upgrade later?','a':'Yes. Free is available immediately and upgrades keep your configuration.'},{q:'What does Plus add?','a':'Plus focuses on statistics, staff activity, and stronger operational visibility.'},{q:'What does Pro add?','a':'Pro adds AI moderation and advanced automation for busier support teams.'},{q:'What is Enterprise?','a':'Enterprise is the custom plan with branded bot runtime setup, monitoring, and guided Developer Portal configuration.'}];return '<div class="page-shell pricing-page">'+
    '<section class="pricing-hero card"><div class="row" style="align-items:flex-start;gap:24px"><div style="max-width:640px"><div class="page-kicker">Pricing</div><h3 style="margin:0 0 14px">Plans for ticket support and staff operations.</h3><p class="muted" style="max-width:620px">Pick the right plan for your community: Free, Plus, Pro, or Enterprise for fully custom branded bot operations.</p><div class="row" style="gap:10px;flex-wrap:wrap;margin-top:22px"><a class="btn primary" href="#plans">View plans</a><a class="btn-soft" href="#faq">Read FAQ</a></div></div><div class="pricing-hero-stats"><div class="pricing-stat"><strong>4 plans</strong><span>Free, Plus, Pro, and Enterprise</span></div><div class="pricing-stat"><strong>Custom bots</strong><span>Enterprise includes branded runtime monitoring</span></div></div></div></section>'+ 
    '<section id="plans" class="grid pricing-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:18px">'+
      plans.map(plan=>'<div class="pricing-card'+(plan.featured?' featured':'')+'"><div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="plan-name">'+esc(plan.name)+'</div><div class="plan-note">'+esc(plan.description)+'</div></div>'+(plan.featured?'<span class="plan-badge">Most Popular</span>':'')+'</div><div class="plan-price">'+esc(plan.price)+'</div><div class="pricing-feature-list">'+plan.features.map(feature=>'<div class="pricing-feature"><span class="dot"></span><div>'+esc(feature)+'</div></div>').join('')+'</div><div class="plan-action">'+(plan.active?'<button class="btn" type="button">Current plan</button>':(plan.name==='Enterprise'?'<button class="btn-soft" type="button">Contact sales</button>':'<button class="btn" type="button">Upgrade</button>'))+'</div></div>').join('')+
    '</section>'+ 
    '<section class="pricing-table card"><h3 style="margin:0 0 16px">Compare plans</h3><div style="overflow-x:auto"><table><thead><tr><th style="min-width:220px">Feature</th><th>Free</th><th>Plus</th><th>Pro</th><th>Enterprise</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+esc(row[0])+'</td><td class="'+(row[1]==='Yes'?'active':'')+'">'+esc(row[1])+'</td><td class="'+(row[2]==='Yes'?'active':'')+'">'+esc(row[2])+'</td><td class="'+(row[3]==='Yes'?'active':'')+'">'+esc(row[3])+'</td><td class="'+(row[4]==='Yes'?'active':'')+'">'+esc(row[4])+'</td></tr>').join('')+'</tbody></table></div></section>'+ 
    '<section id="faq" class="pricing-faq">'+faqs.map(item=>'<div class="faq-item"><strong>'+esc(item.q)+'</strong><p class="muted" style="margin:10px 0 0">'+esc(item.a)+'</p></div>').join('')+'</section>'+ 
    '<section class="pricing-cta card"><div style="max-width:760px;margin:0 auto"><div class="page-kicker">Ready to choose?</div><h3 style="margin:0 0 12px">Start with a plan that fits your team.</h3><p class="muted">Keep ticket flow clean, staff handoffs simple, and branded bot operations centralized.</p><div class="row" style="justify-content:center;gap:12px;margin-top:20px;flex-wrap:wrap"><button class="btn primary" type="button">Upgrade to Plus</button><button class="btn-soft" type="button">Discuss Enterprise</button></div></div></section>'+ 
  '</div>'}
function renderUpgrade(){return '<div class="grid">'+
    '<div class="card"><h3>Free</h3><p class="muted">Core ticket workflows, panels, logs, and transcripts.</p></div>'+ 
    '<div class="card"><h3>Plus</h3><p class="muted">Statistics, staff activity, and priority support for growing teams.</p><div style="margin-top:12px" class="row"><button class="btn primary">Upgrade to Plus</button></div></div>'+ 
    '<div class="card"><h3>Pro</h3><p class="muted">AI moderation and advanced automation for busier support teams.</p><div style="margin-top:12px"><ul><li>AI moderation</li><li>Advanced analytics</li><li>Higher automation limits</li><li>Everything in Plus</li></ul></div></div>'+ 
    '<div class="card"><h3>Enterprise</h3><p class="muted">Custom branded bot runtime with guided Developer Portal setup and webhook monitoring.</p><div style="margin-top:12px"><ul><li>Custom bot instance</li><li>Command sync monitoring</li><li>Startup reporting</li><li>Everything in Pro</li></ul></div><div style="margin-top:12px" class="row"><button class="btn-soft">Contact Sales</button></div></div>'+ 
  '</div>'}function renderTutorials(){
 const tutorials=Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[];
 const cards=tutorials.map((tutorial,index)=>'<button type="button" class="card tutorialCard" data-tutorial-open="'+index+'" style="text-align:left;padding:0;overflow:hidden">'+
   (tutorial.coverImage?'<div style="height:130px;background:#0b1020"><img src="'+esc(tutorial.coverImage)+'" alt="'+esc(tutorial.title)+'" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy" /></div>':'')+
   '<div style="padding:16px"><div class="item-top"><strong>'+esc(tutorial.title)+'</strong>'+(tutorial.badge?'<span class="pill">'+esc(tutorial.badge)+'</span>':'')+'</div><div class="muted">'+esc(tutorial.summary||'')+'</div><div class="muted" style="margin-top:10px">'+(tutorial.steps||[]).length+' step(s)</div></div></button>').join('');
 return '<div class="grid">'+
  '<div class="card welcome"><p class="floaty">Tutorials for your <span class="accent">team workflow</span>.</p><p class="muted">Pick a card to open the walkthrough in a focused modal.</p></div>'+
  '<div class="card" style="grid-column:1/-1"><div class="list" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">'+(cards||'<div class="muted">No tutorials configured yet.</div>')+'</div></div>'+
  '<div id="tutorialOverlay" style="display:none;position:fixed;inset:0;background:rgba(2,6,23,.96);backdrop-filter:blur(18px);z-index:90;padding:18px;align-items:center;justify-content:center">'+
   '<canvas id="tutorialConfetti" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas>'+
   '<div class="card" id="tutorialModalShell" style="position:relative;width:min(1080px,100%);max-height:96vh;overflow:hidden;padding:0">'+
    '<div style="padding:18px 18px 10px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:12px">'+
      '<div><strong id="tutorialModalTitle" style="font-size:24px">Tutorial</strong><div id="tutorialModalBadge" class="muted" style="margin-top:6px"></div></div><button type="button" class="btn-soft" id="tutorialClose">Close</button>'+
    '</div>'+
    '<div id="tutorialTransitionText" class="muted" style="position:absolute;left:50%;top:72px;transform:translateX(-50%);opacity:0;pointer-events:none;font-weight:800;letter-spacing:.08em;text-transform:uppercase;transition:opacity .35s ease,transform .35s ease"></div>'+
    '<div id="tutorialModalBody" style="padding:18px;min-height:60vh;overflow:auto;transition:opacity .28s ease,transform .28s ease"></div>'+
    '<div style="padding:14px 18px 18px;border-top:1px solid rgba(255,255,255,.08)">'+
      '<div id="tutorialProgressRow" style="display:grid;gap:10px">'+
        '<div style="height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden"><div id="tutorialProgressBar" style="height:100%;width:0%;border-radius:inherit;background:linear-gradient(90deg,rgba(56,189,248,.95),rgba(96,165,250,.78));box-shadow:0 0 30px rgba(56,189,248,.30);transition:width .32s ease"></div></div>'+
        '<div class="row" style="grid-template-columns:1fr 1fr;gap:10px"><button type="button" class="btn-soft" id="tutorialPrev">Back</button><button type="button" class="btn" id="tutorialNext">Next</button></div>'+
      '</div>'+
    '</div>'+
   '</div>'+
  '</div>'+
 '</div>';
}
function renderDocs(){
 const rows=[['{ticketType}','Ticket type name'],['{requester}','User mention'],['{username}','Requester username'],['{userId}','Requester ID'],['{reason}','Open reason'],['{timestamp}','Discord timestamp'],['{timestampIso}','ISO timestamp'],['{date}','Date YYYY-MM-DD'],['{time}','Time HH:mm:ss UTC'],['{channel}','Ticket channel mention'],['{channelId}','Ticket channel ID']];
 const docsSections=Array.isArray(state&&state.botConfig&&state.botConfig.docsSections)?state.botConfig.docsSections:[];
 const oauthRedirect=String((state&&state.publicBaseUrl)||'').replace(/\\/+$/,'')+'/auth/discord/callback';
 const embedExample=esc(JSON.stringify({content:'Optional message content',embeds:[{title:'Embed title',description:'Embed description',color:5793266,thumbnail:{url:'https://example.com/thumb.png'},image:{url:'https://example.com/image.png'},footer:{text:'Footer text'}}]},null,2));
 const attachmentExample=esc(JSON.stringify({content:'Image from attachment',embeds:[{title:'Proof',image:{url:'attachment://proof.png'}}]},null,2));
 const sepExample=esc('## Title\\n\\nFirst paragraph.\\n\\n[[divider]]\\n\\nSecond paragraph.\\n\\n[[space:large]]\\n\\nThird paragraph.');
 const ownerDocs=(state&&state.isOwner)?('<div class="card" style="grid-column:1/-1"><h3>Owner Documentation Editor</h3><div class="muted">Edit the public documentation sections shown below. JSON format: [{ "title": "...", "body": "..." }]</div><textarea id="docsJson" style="min-height:220px;font-family:Consolas,monospace">'+esc(JSON.stringify(docsSections,null,2))+'</textarea><div class="row" style="margin-top:10px"><button id="saveDocs" class="btn">Save Documentation</button><button id="formatDocs" class="btn-soft">Format JSON</button></div></div>'):'';
 const customDocs=docsSections.length?('<div class="card" style="grid-column:1/-1"><h3>Guide Sections</h3><div class="grid" style="margin-top:10px">'+docsSections.map(section=>'<div class="item" style="display:block"><strong>'+esc(section.title)+'</strong><div class="muted" style="margin-top:8px;white-space:pre-wrap">'+esc(section.body)+'</div></div>').join('')+'</div></div>'):'';
  return '<div class="grid">'+
   ownerDocs+
   customDocs+
   '<div class="card"><h3>Placeholders</h3><div class="list">'+
   rows.map(r=>'<div class="item"><div class="item-top"><strong>'+r[0]+'</strong><button class="btn-soft copyPH" data-v="'+r[0]+'">Copy</button></div><div class="muted">'+r[1]+'</div></div>').join('')+
  '</div></div>'+

  '<div class="card"><h3>Embeds: Images</h3><div class="muted">Use <code>thumbnail.url</code> and <code>image.url</code> inside an embed payload.</div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+embedExample+'</pre>'+
   '<div class="muted" style="margin-top:10px">To reference an attached file, set <code>image.url</code> to <code>attachment://filename.png</code> and upload the file with that name.</div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+attachmentExample+'</pre>'+
  '</div>'+

  '<div class="card"><h3>Components V2: Dividers & Spacing</h3>'+
   '<div class="muted">Components V2 messages use containers/text displays. In the <span class="muted">Embed Editor</span>, you can add separators (dividers) and spacing (margins) inside template descriptions using tokens on their own line.</div>'+
   '<div class="item" style="margin-top:10px"><div class="muted">'+
    '<div><code>[[divider]]</code> &mdash; divider, small spacing</div>'+
    '<div><code>[[divider:large]]</code> &mdash; divider, large spacing</div>'+
    '<div><code>[[space]]</code> &mdash; spacing only (no line), small</div>'+
    '<div><code>[[space:large]]</code> &mdash; spacing only (no line), large</div>'+
   '</div></div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+sepExample+'</pre>'+
   '<div class="item" style="margin-top:10px"><div class="muted">Tip: keep accent colors minimal; the bot applies accent automatically for success/error notices.</div></div>'+
   '</div>'+
   '<div class="card"><h3>Dashboard Operations</h3><div class="list">'+
    '<div class="item"><div><strong>Themes and menus</strong><div class="muted">Use the top theme picker for Dark, Light, Ocean, Sunset, and Diamond. Navigation is grouped into General, Tickets, Tools, and Plans.</div></div></div>'+
    '<div class="item"><div><strong>Staff permissions</strong><div class="muted">Configure role families with STAFF_EXECUTIVE_ROLE_IDS, STAFF_SUPPORT_ROLE_IDS, STAFF_QA_ROLE_IDS, STAFF_COMMUNITY_ROLE_IDS, or SENIOR_STAFF_ROLE_IDS. Comma or space separated role IDs are supported.</div></div></div>'+
    '<div class="item"><div><strong>Online transcripts</strong><div class="muted">Saved transcripts open through /t/&lt;token&gt; when a public token exists. Downloads add ?download=1.</div></div></div>'+
    '<div class="item"><div><strong>Discord OAuth redirect</strong><div class="muted">Add this exact URI to the Discord Developer Portal for transcript login: <code>'+esc(oauthRedirect)+'</code>. If Discord says invalid redirect_uri, update PUBLIC_BASE_URL to your public HTTPS origin and make this URI match exactly.</div></div></div>'+
    '<div class="item"><div><strong>Feedback setup</strong><div class="muted">Set a feedback channel on the Feedback page. Users run /feedback inside a claimed ticket and staff receive the rating report.</div></div></div>'+
    '<div class="item"><div><strong>Branding</strong><div class="muted">Enterprise/custom servers can edit server identity, embed templates, and preview the bot message before saving.</div></div></div>'+
    '<div class="item"><div><strong>Recommended bot permissions</strong><div class="muted">View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Use Slash Commands, Manage Channels, Manage Roles, Create Public Threads, Send Messages in Threads. Add Manage Messages only if you want cleanup/moderation actions.</div></div></div>'+
   '</div></div>'+
  '</div>'}
function selectedRoles(id){return Array.from(document.querySelectorAll('input[data-ms-check="'+id+'"]:checked')).map(el=>el.value)}
function setRoleSelection(id,values){const selectedSet=new Set((values||[]).map(String));document.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=selectedSet.has(el.value)});updateRoleSelectionUi(id)}
function updateRoleSelectionUi(id){const values=selectedRoles(id);const count=document.getElementById(id+'Count');if(count)count.textContent=values.length+' selected';const chipsEl=document.getElementById(id+'Chips');if(chipsEl){const roleMap=new Map((state.roleCatalog||[]).map(r=>[r.id,r]));chipsEl.innerHTML=values.map(v=>roleMap.get(v)).filter(Boolean).map(r=>'<span class="ms-chip">@'+esc(r.name)+'</span>').join('')}}
function closePickers(){document.querySelectorAll('.custom-select.open').forEach(el=>el.classList.remove('open'));document.querySelectorAll('.role-ms.open').forEach(el=>el.classList.remove('open'));document.querySelectorAll('.topnav.open').forEach(el=>el.classList.remove('open'))}
function placeDropdown(wrap){if(!wrap)return;wrap.classList.remove('drop-up');requestAnimationFrame(()=>{const menu=wrap.querySelector('.cs-menu,.ms-menu');if(!menu)return;const r=menu.getBoundingClientRect();if(r.bottom>window.innerHeight-18&&wrap.getBoundingClientRect().top>r.height+18)wrap.classList.add('drop-up')})}
function wireRoleMultiSelect(id){const wrap=document.querySelector('[data-role-ms="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-ms-trigger="'+id+'"]');const search=wrap.querySelector('[data-ms-search="'+id+'"]');const allBtn=wrap.querySelector('.select-all[data-select="'+id+'"]');const clearBtn=wrap.querySelector('.clear-all[data-select="'+id+'"]');if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');placeDropdown(wrap);if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();wrap.querySelectorAll('[data-ms-item="'+id+'"]').forEach(item=>{item.style.display=!q||String(item.getAttribute('data-name')||'').includes(q)?'flex':'none'});placeDropdown(wrap)};if(allBtn)allBtn.onclick=()=>{wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=true});updateRoleSelectionUi(id)};if(clearBtn)clearBtn.onclick=()=>{wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=false});updateRoleSelectionUi(id)};wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.onchange=()=>updateRoleSelectionUi(id)});updateRoleSelectionUi(id)}
function wireChannelSelect(id,placeholder){const wrap=document.querySelector('[data-cs="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-cs-trigger="'+id+'"]');const hidden=document.getElementById(id);const label=document.getElementById(id+'Label');const search=wrap.querySelector('[data-cs-search="'+id+'"]');const opts=Array.from(wrap.querySelectorAll('[data-cs-opt="'+id+'"]'));if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');placeDropdown(wrap);if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();opts.forEach(btn=>{btn.style.display=!q||btn.textContent.toLowerCase().includes(q)?'flex':'none'});placeDropdown(wrap)};opts.forEach(btn=>{btn.onclick=()=>{const v=btn.getAttribute('data-value')||'';if(hidden)hidden.value=v;if(label)label.textContent=channelLabel(v,placeholder);opts.forEach(o=>o.classList.toggle('active',o===btn));wrap.classList.remove('open')}})}
function wireCategorySelect(id,placeholder){const wrap=document.querySelector('[data-cs="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-cs-trigger="'+id+'"]');const hidden=document.getElementById(id);const label=document.getElementById(id+'Label');const search=wrap.querySelector('[data-cs-search="'+id+'"]');const opts=Array.from(wrap.querySelectorAll('[data-cs-opt="'+id+'"]'));if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');placeDropdown(wrap);if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();opts.forEach(btn=>{btn.style.display=!q||btn.textContent.toLowerCase().includes(q)?'flex':'none'});placeDropdown(wrap)};opts.forEach(btn=>{btn.onclick=()=>{const v=btn.getAttribute('data-value')||'';if(hidden)hidden.value=v;if(label)label.textContent=categoryLabel(v,placeholder);opts.forEach(o=>o.classList.toggle('active',o===btn));wrap.classList.remove('open')}})}
function fillType(name){const t=state.ticketTypes.find(x=>x.name===name);if(!t)return;ttName.value=t.name||'';ttEmoji.value=t.emoji||'';ttColor.value=t.embedColor||'#5865F2';ttFormat.value=t.format||'';const catEl=document.getElementById('ttCategory');if(catEl)catEl.value=t.categoryId||'';const catLabel=document.getElementById('ttCategoryLabel');if(catLabel)catLabel.textContent=categoryLabel((catEl&&catEl.value)||'', 'Use default ticket category');ttAliases.value=(t.aliases||[]).join(', ');ttOpenTitle.value=(t.openEmbed&&t.openEmbed.title)||'';ttOpenDescription.value=(t.openEmbed&&t.openEmbed.description)||'';ttRequireReason.checked=t.requireReason!==false;ttAllowFiles.checked=t.allowAttachments!==false;setRoleSelection('ttRoles',t.roleIds||[])}
function fillTag(name){const t=state.tags.find(x=>x.name===name);if(!t)return;tagName.value=t.name||'';tagKind.value=t.kind||'suggestion';tagTitle.value=t.title||'';tagDesc.value=t.description||'';tagKeys.value=(t.keywords||[]).join(', ')}
function fillTeam(name){const t=state.supportTeams.find(x=>x.name===name);if(!t)return;stName.value=t.name||'';stEmoji.value=t.emoji||'';setRoleSelection('stRoles',(t.roleIds||(t.roleId?[t.roleId]:[]))||[])}
function getBrandingTemplates(){const box=document.getElementById('brandingTemplates');if(!box)return {};try{const parsed=JSON.parse(box.value);return parsed&&typeof parsed==='object'?parsed:{};}catch{return {}}}
function renderBrandingPreview(){const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');const brandNameEl=document.getElementById('serverBrandName');const brandAvatarEl=document.getElementById('serverBrandAvatar');const bar=document.getElementById('brandingPreviewBar');const titleView=document.getElementById('brandingPreviewTitle');const descView=document.getElementById('brandingPreviewDesc');const nameView=document.getElementById('brandingPreviewName');const avatarView=document.getElementById('brandingPreviewAvatar');const color=((colorEl&&colorEl.value)||'#5865F2').trim();if(bar)bar.style.background=color.startsWith('#')?color:('#'+color.replace('#',''));if(nameView)nameView.innerHTML=esc((brandNameEl&&brandNameEl.value)||'Tickets Bot')+' <span class="preview-tag">BOT</span>';if(avatarView){const avatar=((brandAvatarEl&&brandAvatarEl.value)||'').trim();avatarView.style.backgroundImage=avatar?'url('+avatar.replace(/["')]/g,'')+')':'';avatarView.style.backgroundSize='cover';avatarView.style.backgroundPosition='center'}if(titleView)titleView.textContent=(titleEl&&titleEl.value)||'(No title)';const rawDesc=(descEl&&descEl.value)||'';const cleaned=rawDesc.split(/\\r?\\n/).map(line=>{const t=String(line||'').trim();if(/^\\[\\[(divider|sep|separator)(?::(small|large))?\\]\\]$/i.test(t))return '--------';if(/^\\[\\[(space|spacer)(?::(small|large))?\\]\\]$/i.test(t))return '';return line}).join('\\n').replace(/\\n{3,}/g,'\\n\\n').trim()||'(No description)';if(descView)descView.textContent=cleaned}
function loadBrandingKey(key){const templates=getBrandingTemplates();const t=templates[key]||defaultEmbedTemplates[key]||{title:'',description:'',color:'#5865F2'};const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');if(colorEl)colorEl.value=t.color||'#5865F2';if(titleEl)titleEl.value=t.title||'';if(descEl)descEl.value=t.description||'';renderBrandingPreview()}
function applyBrandingFormToTemplate(){const keyEl=document.getElementById('brandingKey');const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');const box=document.getElementById('brandingTemplates');if(!keyEl||!box)return;const key=keyEl.value;const templates=getBrandingTemplates();templates[key]={...(templates[key]||{}),color:((colorEl&&colorEl.value)||'').trim(),title:(titleEl&&titleEl.value)||'',description:(descEl&&descEl.value)||''};box.value=JSON.stringify(templates,null,2);renderBrandingPreview()}
function renderPanelPreview(){const title=document.getElementById('panelEditTitle');const desc=document.getElementById('panelEditDescription');const adv=document.getElementById('panelEditAdvisory');const button=document.getElementById('panelButtonLabel');const mode=document.getElementById('panelMode');const type=document.getElementById('panelTicketType');const titleView=document.getElementById('panelPreviewTitle');const descView=document.getElementById('panelPreviewDesc');const buttonView=document.getElementById('panelPreviewButton');if(titleView)titleView.textContent=(title&&title.value)||'Support Desk';const bits=[(desc&&desc.value)||'',(adv&&adv.value)||''].filter(v=>String(v||'').trim());if(descView)descView.textContent=bits.join('\\n\\n')||'Panel description preview';if(buttonView){const suffix=mode&&mode.value==='single'&&type&&type.value?(' - '+type.value):'';buttonView.textContent=((button&&button.value)||'Select a prompt')+suffix;}}
async function savePanelDesign(publish=false){const channelId=(document.getElementById('panelChannel')?.value||'').trim();if(!channelId)return note('Choose a panel channel first.','danger');const payload={guildId:state.guildId,channelId,title:(document.getElementById('panelEditTitle')?.value||'').trim(),description:document.getElementById('panelEditDescription')?.value||'',advisory:document.getElementById('panelEditAdvisory')?.value||'',buttonLabel:(document.getElementById('panelButtonLabel')?.value||'').trim(),mode:document.getElementById('panelMode')?.value||'multi',ticketType:document.getElementById('panelTicketType')?.value||''};await api('/api/panel/upsert',{method:'POST',body:JSON.stringify(payload)});ui.selectedPanelChannel=channelId;saveUi();if(publish)await api('/api/panel/publish',{method:'POST',body:JSON.stringify({guildId:state.guildId,channelId})});note(publish?'Panel saved and published.':'Panel saved.','ok');await boot()}
function setupModuleDrilldown(){
 if(['/overview','/tutorials','/documentation','/pricing','/upgrade'].includes(currentPath))return;
 const root=app.querySelector(':scope > .grid, :scope > .split');
 if(!root||root.dataset.drillReady==='true')return;
 const panels=Array.from(root.children).filter(el=>el&&el.classList&&el.classList.contains('card'));
 if(panels.length<2)return;
 root.dataset.drillReady='true';
 root.classList.add('module-root');
 panels.forEach(panel=>panel.classList.add('module-panel'));

 const drill=document.createElement('div');
 drill.className='module-drill';
 const options=document.createElement('div');
 options.className='module-options';
 const source=document.createElement('div');
 source.className='module-source';
 root.parentNode.insertBefore(drill,root);
 drill.appendChild(options);
 drill.appendChild(source);
 source.appendChild(root);

 const openPanel=(panel,title)=>{
  panels.forEach(p=>p.classList.remove('active-panel'));
  panel.classList.add('active-panel');
  if(!panel.querySelector(':scope > .module-editor-head')){
   const head=document.createElement('div');
   head.className='module-editor-head';
   head.innerHTML='<div><div class="module-editor-title">Overlay configuration modal</div><h3 style="margin:4px 0 0">'+esc(title)+'</h3></div><button type="button" class="btn-soft moduleBack" style="width:auto">X Close</button>';
   panel.insertBefore(head,panel.firstChild);
   const back=head.querySelector('.moduleBack');
   if(back)back.onclick=()=>{
    drill.classList.remove('editing');
    panels.forEach(p=>p.classList.remove('active-panel'));
    document.body.style.overflow='';
   };
  }
  drill.classList.add('editing');
  document.body.style.overflow='hidden';
  window.scrollTo({top:0,behavior:'smooth'});
 };

 panels.forEach((panel,index)=>{
  const title=(panel.querySelector('h3')&&panel.querySelector('h3').textContent)||('Module '+(index+1));
  const desc=(panel.querySelector('.muted')&&panel.querySelector('.muted').textContent)||'Open this module page.';
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='module-option';
  btn.innerHTML='<span><strong>'+esc(title)+'</strong><span class="muted">'+esc(desc)+'</span></span><span class="pill">Open</span>';
  btn.onclick=()=>openPanel(panel,title);
  options.appendChild(btn);
 });
 drill.addEventListener('click',ev=>{if(ev.target===drill){drill.classList.remove('editing');panels.forEach(p=>p.classList.remove('active-panel'));document.body.style.overflow='';}});
 if(!window.__moduleEscBound){window.__moduleEscBound=true;document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){document.querySelectorAll('.module-drill.editing').forEach(d=>d.classList.remove('editing'));document.querySelectorAll('.module-panel.active-panel').forEach(p=>p.classList.remove('active-panel'));document.body.style.overflow='';}});}
}
function setupStatsChart(){
 const canvas=document.getElementById('statsChart');if(!canvas)return;
 const ctx=canvas.getContext('2d');let mode='bar';
 const byDay=(state.statistics&&state.statistics.byDay)||{};
 const labels=Object.keys(byDay);
 const claimed=labels.map(k=>Number(byDay[k].claimed||0));
 const closed=labels.map(k=>Number(byDay[k].closed||0));
 function draw(){
  const dpr=window.devicePixelRatio||1,w=canvas.clientWidth||900,h=260;canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const max=Math.max(1,...claimed,...closed),pad=34,plotW=w-pad*2,plotH=h-pad*2;
  ctx.strokeStyle='rgba(255,255,255,.12)';ctx.lineWidth=1;for(let i=0;i<=4;i++){const y=pad+plotH*(i/4);ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();}
  const x=i=>pad+(labels.length<=1?plotW/2:(plotW*i/(labels.length-1))); const y=v=>pad+plotH-(v/max)*plotH;
  function line(data,color,fill){ctx.beginPath();data.forEach((v,i)=>{if(i)ctx.lineTo(x(i),y(v));else ctx.moveTo(x(i),y(v));});if(fill){ctx.lineTo(x(data.length-1),h-pad);ctx.lineTo(x(0),h-pad);ctx.closePath();ctx.fillStyle=color.replace('1)','.16)');ctx.fill();}ctx.beginPath();data.forEach((v,i)=>{if(i)ctx.lineTo(x(i),y(v));else ctx.moveTo(x(i),y(v));});ctx.strokeStyle=color;ctx.lineWidth=3;ctx.stroke();}
  if(mode==='bar'){const bw=Math.max(8,plotW/Math.max(1,labels.length)/3);labels.forEach((_,i)=>{ctx.fillStyle='rgba(56,189,248,.85)';ctx.fillRect(x(i)-bw-2,y(claimed[i]),bw,h-pad-y(claimed[i]));ctx.fillStyle='rgba(87,242,135,.78)';ctx.fillRect(x(i)+2,y(closed[i]),bw,h-pad-y(closed[i]));});}else{line(claimed,'rgba(56,189,248,1)',mode==='area');line(closed,'rgba(87,242,135,1)',mode==='area');}
  ctx.fillStyle='rgba(247,248,255,.72)';ctx.font='12px Inter, sans-serif';ctx.fillText('Claimed',pad,18);ctx.fillText('Closed',pad+78,18);
 }
 document.querySelectorAll('.statsView').forEach(btn=>btn.onclick=()=>{mode=btn.dataset.chart||'bar';draw()});
 draw();window.addEventListener('resize',draw,{once:true});
}
function wire(){
 setupStatsChart();
 if(!window.__navWired){
 window.__navWired=true;
  const pageTitleEl=document.getElementById('pageTitle');
  const topNav=document.getElementById('topNav');
  const topNavBtn=document.getElementById('topNavBtn');
  const topNavLabel=document.getElementById('topNavLabel');
  const topNavMenu=document.getElementById('topNavMenu');
  const topNavItems=Array.from(document.querySelectorAll('[data-topnav-item]'));
  const themeNav=document.getElementById('themeNav');
  const themeBtn=document.getElementById('themeBtn');
  const themeLabel=document.getElementById('themeLabel');
  const themeItems=Array.from(document.querySelectorAll('[data-theme-item]'));
    const menuBtn=document.getElementById('menuBtn');
    const menuOverlay=document.getElementById('menuOverlay');
    const closeMenu=()=>{try{document.body.classList.remove('menu-open')}catch{}};
    if(menuBtn)menuBtn.onclick=()=>{document.body.classList.toggle('menu-open')};
    if(menuOverlay)menuOverlay.onclick=()=>closeMenu();
    const navTitleForPath=(p)=>({ '/overview':'Home','/settings':'Settings','/availability':'Availability','/tutorials':'Tutorials','/commands/ticket-types':'Ticket Types','/panels':'Panels','/commands/tag':'Tags','/tickets':'Tickets','/transcripts':'Transcripts','/commands/feedback':'Feedback','/statistics':'Statistics','/embed-editor':'Branding','/documentation':'Documentation'}[p]||'Dashboard');
    const pageDescForPath=(p)=>({ '/overview':'A cleaner snapshot of ticket activity, queue health, and the most common next actions.','/settings':'Core server configuration, routing, and system behavior in one place.','/availability':'Adjust queue expectations per ticket type without digging through commands.','/tutorials':'Guides, walkthroughs, and internal onboarding material for your staff.','/commands/ticket-types':'Shape each ticket flow, assign support coverage, and keep categories tidy.','/panels':'Design, save, and publish channel-specific ticket panels.','/commands/tag':'Store reusable answers and keep repeat support responses consistent.','/tickets':'Review active conversations, add notes, and handle escalations quickly.','/transcripts':'Browse saved transcripts and archive history without leaving the dashboard.','/commands/feedback':'Control where feedback lands and how the flow is presented.','/statistics':'Track recent performance, close reasons, and staff activity trends.','/embed-editor':'Customize server branding and reusable bot message templates.','/documentation':'Reference placeholders, templates, and dashboard usage notes.'}[p]||'Manage this part of the dashboard with a simpler, more focused layout.');
     const groupForPath=(p)=>{if(p==='/overview'||p==='/settings'||p==='/availability'||p==='/tutorials')return 'general';if(p==='/commands/ticket-types'||p==='/commands/tag'||p==='/tickets'||p==='/transcripts')return 'tickets';return 'content'};
     const allowedPages=()=>{const access=(state&&state.access)||{};const plan=(state&&state.aiAccess)||{};const set=new Set(['/documentation','/tutorials','/pricing','/upgrade','/privacy','/terms']);if(access.isOwner||access.canFullDashboard){['/overview','/settings','/availability','/commands/ticket-types','/panels','/commands/tag','/tickets','/transcripts','/commands/feedback','/pricing','/upgrade'].forEach(p=>set.add(p));if(plan.isPlusOrHigher)set.add('/statistics');if(plan.isCustom)set.add('/embed-editor');return set}if(access.canManageTicketTypes){set.add('/settings');set.add('/commands/ticket-types');set.add('/panels');if(plan.isCustom)set.add('/embed-editor')}if(plan.isPlusOrHigher&&access.canManageTicketTypes)set.add('/statistics');if(access.canManageAvailability)set.add('/availability');if(access.canViewTickets||access.canManageEscalations)set.add('/tickets');if(access.canViewTranscripts)set.add('/transcripts');return set};
     let darkSecretCount=0;
     const normaliseTheme=(t)=>{const v=String(t||'').trim().toLowerCase();if(v==='hacker'&&!isHackerUnlocked())return 'dark';return ['dark','light','ocean','sunset','diamond','hacker'].includes(v)?v:'dark'};
     const syncThemeUi=()=>{const cur=normaliseTheme(document.body.dataset.theme);const labels={dark:'Dark',light:'Light',ocean:'Ocean',sunset:'Sunset',diamond:'Diamond',hacker:'Hacker'};if(themeLabel)themeLabel.textContent='Theme: '+(labels[cur]||'Dark');themeItems.forEach(btn=>{const v=btn.getAttribute('data-theme-item')||'';btn.classList.toggle('active',v===cur)})};
     const applyTheme=(t)=>{document.body.dataset.theme=normaliseTheme(t);syncThemeUi()};
     const setTheme=(t)=>{const next=normaliseTheme(t);try{localStorage.setItem(themeKey,next)}catch{}applyTheme(next)};
     const registerDarkSecret=()=>false;
     applyTheme(document.body.dataset.theme||'dark');
     if(themeNav&&themeBtn){themeBtn.onclick=(ev)=>{ev.stopPropagation();const next=!themeNav.classList.contains('open');closePickers();if(next)themeNav.classList.add('open');else themeNav.classList.remove('open')}};
     themeItems.forEach(btn=>{btn.onclick=()=>{const pick=btn.getAttribute('data-theme-item')||'';if(pick==='dark'){darkSecretCount+=1;if(darkSecretCount>=7){try{localStorage.setItem(hackerUnlockKey,'true')}catch{}document.body.dataset.hackerUnlocked='true'}}else{darkSecretCount=0}setTheme(pick);closePickers()}});
     const closeTopNav=()=>{if(topNav)topNav.classList.remove('open')};
   const setTopNavValue=(p)=>{const next=String(p||'');if(topNav)topNav.dataset.value=next;if(topNavLabel)topNavLabel.textContent=navTitleForPath(next);topNavItems.forEach(b=>{const v=b.getAttribute('data-value')||'';b.classList.toggle('active',v===next)})};
   const syncNav=()=>{document.querySelectorAll('.nav-item').forEach(a=>{const p=a.getAttribute('data-nav')||a.getAttribute('href')||'';a.classList.toggle('active',p===currentPath)})};
   const syncGroups=()=>{const g=groupForPath(currentPath);document.querySelectorAll('[data-nav-group]').forEach(el=>{const name=el.getAttribute('data-nav-group');el.classList.toggle('open',name===g)})};
   const navigate=(p)=>{const next=String(p||'').trim();if(!next||next===currentPath||!allowedPages().has(next))return;closeMenu();closeTopNav();history.pushState({},'',next);currentPath=next;if(pageTitleEl)pageTitleEl.textContent=navTitleForPath(currentPath);const pageHintEl=document.getElementById('pageHint');if(pageHintEl)pageHintEl.textContent=pageDescForPath(currentPath);document.title=${JSON.stringify(createDocumentTitle('Dashboard'))}.replace('Dashboard',navTitleForPath(currentPath));setTopNavValue(currentPath);render();syncNav();syncGroups();window.scrollTo({top:0,behavior:'smooth'})};
   window.__dashNav={navTitleForPath,navigate,syncNav,syncGroups};
   document.querySelectorAll('[data-nav]').forEach(a=>{a.onclick=(ev)=>{ev.preventDefault();navigate(a.getAttribute('data-nav'))}});
   document.querySelectorAll('[data-nav-group-btn]').forEach(b=>{b.onclick=()=>{const g=b.getAttribute('data-nav-group-btn');if(!g)return;document.querySelectorAll('[data-nav-group]').forEach(el=>{el.classList.toggle('open',el.getAttribute('data-nav-group')===g && !el.classList.contains('open'))})}});
   if(topNav&&topNavBtn){topNavBtn.onclick=(ev)=>{ev.stopPropagation();const next=!topNav.classList.contains('open');closePickers();if(next)topNav.classList.add('open');else topNav.classList.remove('open')}};
   topNavItems.forEach(btn=>{const v=btn.getAttribute('data-value')||'';btn.style.display=allowedPages().has(v)?'flex':'none';btn.onclick=()=>{navigate(v)}});
    setTopNavValue(currentPath);
    window.onpopstate=()=>{currentPath=location.pathname||'/overview';if(pageTitleEl)pageTitleEl.textContent=navTitleForPath(currentPath);const pageHintEl=document.getElementById('pageHint');if(pageHintEl)pageHintEl.textContent=pageDescForPath(currentPath);document.title=${JSON.stringify(createDocumentTitle('Dashboard'))}.replace('Dashboard',navTitleForPath(currentPath));setTopNavValue(currentPath);render();syncNav();syncGroups()};
    syncNav();syncGroups();
    window.addEventListener('keydown',(ev)=>{if(ev.key==='Escape'){closeMenu();closePickers();closeTopNav();}}, { passive: true });
 
   document.querySelectorAll('input[name=\"navGroupPick\"]').forEach(r=>{
    r.onchange=()=>{const v=r.value;document.querySelectorAll('[data-nav-group]').forEach(el=>{el.classList.toggle('open',el.getAttribute('data-nav-group')===v)})};
   });
 }
 document.onclick=(ev)=>{if(!ev.target.closest('.custom-select')&&!ev.target.closest('.role-ms')&&!ev.target.closest('.topnav'))closePickers()};
  document.querySelectorAll('.qa').forEach(b=>b.onclick=()=>{const p=b.getAttribute('data-go');if(p&&window.__dashNav&&typeof window.__dashNav.navigate==='function')window.__dashNav.navigate(p)});
 document.querySelectorAll('.copyPH').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.v||'');note('Placeholder copied.','ok')});
 const saveConfig=document.getElementById('saveConfig');if(saveConfig)saveConfig.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,appealsChannelId:feedbackId.value||null,setup:{step:4}})});note('Settings saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const savePanelConfig=document.getElementById('savePanelConfig');if(savePanelConfig)savePanelConfig.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,panelConfig:{title:(document.getElementById('panelTitle')?.value||'').trim(),description:document.getElementById('panelDescription')?.value||'',advisory:document.getElementById('panelAdvisory')?.value||''},setup:{step:4}})});note('Panel saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const aiUpsell=document.getElementById('aiUpsell');if(aiUpsell)aiUpsell.onclick=()=>{window.location='/pricing'};
 const aiStartTrial=document.getElementById('aiStartTrial');if(aiStartTrial)aiStartTrial.onclick=async()=>{try{await api('/api/owner/guild-ai',{method:'POST',body:JSON.stringify({guildId:state.guildId,action:'start-trial',days:7})});note('AI free trial started for this server.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const aiSetPlus=document.getElementById('aiSetPlus');if(aiSetPlus)aiSetPlus.onclick=async()=>{try{await api('/api/owner/guild-ai',{method:'POST',body:JSON.stringify({guildId:state.guildId,action:'set-plan',plan:'plus'})});note('Plus enabled for this server.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const aiToggleEnabled=document.getElementById('aiToggleEnabled');if(aiToggleEnabled)aiToggleEnabled.onclick=async()=>{try{await api('/api/owner/guild-ai',{method:'POST',body:JSON.stringify({guildId:state.guildId,action:(state&&state.aiAccess&&state.aiAccess.enabled)?'disable':'enable'})});note('AI access updated.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const aiClear=document.getElementById('aiClear');if(aiClear)aiClear.onclick=async()=>{try{const confirmed=prompt('Type CLEAR to remove AI access for this server.');if(confirmed!=='CLEAR')return;await api('/api/owner/guild-ai',{method:'POST',body:JSON.stringify({guildId:state.guildId,action:'clear'})});note('AI access cleared.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const saveHomeImages=document.getElementById('saveHomeImages');if(saveHomeImages)saveHomeImages.onclick=async()=>{try{const urls=[document.getElementById('homeImg1')?.value||'',document.getElementById('homeImg2')?.value||'',document.getElementById('homeImg3')?.value||''].map(s=>String(s||'').trim()).filter(Boolean);await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:urls,tutorials:Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[],docsSections:Array.isArray(state&&state.botConfig&&state.botConfig.docsSections)?state.botConfig.docsSections:[],siteAnnouncement:(state&&state.botConfig&&state.botConfig.siteAnnouncement)||{}})});note('Home images saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const clearHomeImages=document.getElementById('clearHomeImages');if(clearHomeImages)clearHomeImages.onclick=async()=>{try{await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:[],tutorials:Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[],docsSections:Array.isArray(state&&state.botConfig&&state.botConfig.docsSections)?state.botConfig.docsSections:[],siteAnnouncement:(state&&state.botConfig&&state.botConfig.siteAnnouncement)||{}})});note('Home images cleared.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const saveFeedback=document.getElementById('saveFeedback');if(saveFeedback)saveFeedback.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,appealsChannelId:feedbackConfigId.value||null,setup:{step:4}})});note('Feedback settings saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const feedbackCopyCommand=document.getElementById('feedbackCopyCommand');if(feedbackCopyCommand)feedbackCopyCommand.onclick=async()=>{try{await navigator.clipboard.writeText('/feedback');note('Feedback command copied.','ok')}catch{note('Copy failed.','danger')}};
 const refreshTickets=document.getElementById('refreshTickets');if(refreshTickets)refreshTickets.onclick=async()=>{try{await boot();note('Tickets refreshed.','ok')}catch(e){note(e.message,'danger')}};
 const massCloseBtn=document.getElementById('massCloseBtn');if(massCloseBtn)massCloseBtn.onclick=async()=>{try{const typeEl=document.getElementById('massCloseType');const limitEl=document.getElementById('massCloseLimit');const reasonEl=document.getElementById('massCloseReason');const ticketType=(typeEl&&typeEl.value)||'';const limit=Number((limitEl&&limitEl.value)||25);const reason=(reasonEl&&reasonEl.value)||'Mass closed via dashboard.';const confirmText=prompt('Type CLOSE to confirm mass close of up to '+limit+' ticket(s).');if(confirmText!=='CLOSE')return;const result=await api('/api/tickets/mass-close',{method:'POST',body:JSON.stringify({ticketType,limit,reason})});note('Mass close complete. Closed '+(result.closed||0)+'.','ok');await boot()}catch(e){note(e.message,'danger')}};
 document.querySelectorAll('.copyTicket').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const gid=(state&&state.guildId)?String(state.guildId):'';const link=(gid&&id)?('https://discord.com/channels/'+gid+'/'+id):id;await navigator.clipboard.writeText(link);note('Ticket link copied.','ok')}catch(e){note('Copy failed.','danger')}});
 document.querySelectorAll('.closeTicket').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const reason=prompt('Close ticket '+id+'? Enter a reason:', 'Closed via dashboard.');if(reason===null)return;await api('/api/ticket/close',{method:'POST',body:JSON.stringify({channelId:id,reason:String(reason)})});note('Ticket closed.','ok');await boot()}catch(e){note(e.message,'danger')}});
 document.querySelectorAll('.saveTicketNote').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const box=document.querySelector('.ticketNoteBody[data-id=\"'+id+'\"]');const noteBody=(box&&box.value)||'';if(!String(noteBody||'').trim())return note('Write a note first.','danger');await api('/api/ticket/note',{method:'POST',body:JSON.stringify({channelId:id,note:noteBody})});note('Note saved.','ok');await boot()}catch(e){note(e.message,'danger')}});
 document.querySelectorAll('.applyTicketEscalation').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const levelEl=document.querySelector('.ticketEscalationLevel[data-id=\"'+id+'\"]');const level=(levelEl&&levelEl.value)||'';if(!level)return note('Choose an escalation level.','danger');await api('/api/ticket/escalate',{method:'POST',body:JSON.stringify({channelId:id,level})});note('Escalation updated.','ok');await boot()}catch(e){note(e.message,'danger')}});
 const ticketSearch=document.getElementById('ticketSearch');if(ticketSearch)ticketSearch.oninput=()=>{const q=(ticketSearch.value||'').toLowerCase().trim();document.querySelectorAll('#ticketsList .item').forEach(it=>{const show=!q||it.textContent.toLowerCase().includes(q);it.style.display=show?'':'none'})};
 document.querySelectorAll('.viewTranscript').forEach(b=>b.onclick=()=>{const url=b.dataset.url||'';if(!url)return;window.open(url,'_blank','noopener')});
 document.querySelectorAll('.downloadTranscript').forEach(b=>b.onclick=()=>{const url=b.dataset.url||'';if(!url)return;window.open(url,'_blank','noopener')});
 document.querySelectorAll('.deleteTranscript').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';if(!id)return;const confirmText=prompt('Type DELETE to remove transcript '+id+' from disk.');if(confirmText!=='DELETE')return;await api('/api/transcript/delete',{method:'POST',body:JSON.stringify({channelId:id})});note('Transcript deleted.','ok');await boot()}catch(e){note(e.message,'danger')}});
 const transcriptSearch=document.getElementById('transcriptSearch');if(transcriptSearch)transcriptSearch.oninput=()=>{const q=(transcriptSearch.value||'').toLowerCase().trim();document.querySelectorAll('.transcriptItem').forEach(it=>{const hay=String(it.getAttribute('data-hay')||'');const show=!q||hay.includes(q);it.style.display=show?'':'none'})};
  const saveTeam=document.getElementById('saveTeam');if(saveTeam)saveTeam.onclick=async()=>{try{await api('/api/support-team/upsert',{method:'POST',body:JSON.stringify({guildId:state.guildId,name:stName.value.trim(),emoji:stEmoji.value.trim(),roleIds:selectedRoles('stRoles')})});ui.selectedTeam=stName.value.trim();saveUi();note('Support team saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const resetTeam=document.getElementById('resetTeam');if(resetTeam)resetTeam.onclick=()=>{stName.value='';stEmoji.value='';setRoleSelection('stRoles',[])};
  const saveType=document.getElementById('saveType');if(saveType)saveType.onclick=async()=>{try{await api('/api/ticket-type/upsert',{method:'POST',body:JSON.stringify({guildId:state.guildId,name:ttName.value.trim(),emoji:ttEmoji.value.trim(),embedColor:ttColor.value.trim(),format:ttFormat.value.trim(),categoryId:(document.getElementById('ttCategory')?.value||'').trim(),aliases:ttAliases.value,roleIds:selectedRoles('ttRoles'),openTitle:ttOpenTitle.value.trim(),openDescription:ttOpenDescription.value,requireReason:ttRequireReason.checked,allowAttachments:ttAllowFiles.checked})});ui.selectedType=ttName.value.trim();saveUi();note('Ticket type saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
  const ttFormatPreset=document.getElementById('ttFormatPreset');if(ttFormatPreset)ttFormatPreset.onchange=()=>{const v=ttFormatPreset.value||'';if(v&&document.getElementById('ttFormat'))document.getElementById('ttFormat').value=v};
  const resetType=document.getElementById('resetType');if(resetType)resetType.onclick=()=>{['ttName','ttEmoji','ttFormat','ttAliases','ttOpenTitle','ttOpenDescription'].forEach(id=>document.getElementById(id).value='');const catEl=document.getElementById('ttCategory');if(catEl)catEl.value='';const catLabel=document.getElementById('ttCategoryLabel');if(catLabel)catLabel.textContent=categoryLabel('', 'Use default ticket category');ttColor.value='#5865F2';ttRequireReason.checked=true;ttAllowFiles.checked=true;setRoleSelection('ttRoles',[])};
const saveBranding=document.getElementById('saveBranding');if(saveBranding)saveBranding.onclick=async()=>{try{const parsed=getBrandingTemplates();await api('/api/config/embeds',{method:'POST',body:JSON.stringify({embedTemplates:parsed})});note('Branding templates saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const saveServerBranding=document.getElementById('saveServerBranding');if(saveServerBranding)saveServerBranding.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,branding:{botName:(document.getElementById('serverBrandName')?.value||'').trim(),avatarUrl:(document.getElementById('serverBrandAvatar')?.value||'').trim(),accentColor:(document.getElementById('serverBrandAccent')?.value||'').trim(),footerText:(document.getElementById('serverBrandFooter')?.value||'').trim()},setup:{step:4}})});note('Server branding saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const applyBrandingTemplate=document.getElementById('applyBrandingTemplate');if(applyBrandingTemplate)applyBrandingTemplate.onclick=()=>applyBrandingFormToTemplate();
const formatBrandingJson=document.getElementById('formatBrandingJson');if(formatBrandingJson)formatBrandingJson.onclick=()=>{const box=document.getElementById('brandingTemplates');if(box)box.value=JSON.stringify(getBrandingTemplates(),null,2)};
const resetBrandingDefaults=document.getElementById('resetBrandingDefaults');if(resetBrandingDefaults)resetBrandingDefaults.onclick=()=>{const box=document.getElementById('brandingTemplates');if(box)box.value=JSON.stringify(defaultEmbedTemplates,null,2);if(brandingKey)loadBrandingKey(brandingKey.value)};
const brandingKey=document.getElementById('brandingKey');if(brandingKey)brandingKey.onchange=()=>loadBrandingKey(brandingKey.value);
document.querySelectorAll('.brandTemplatePick').forEach(b=>b.onclick=()=>{const key=b.dataset.key||'';const select=document.getElementById('brandingKey');if(select&&key){select.value=key;loadBrandingKey(key);document.querySelectorAll('.brandTemplatePick').forEach(x=>x.classList.toggle('active',x===b))}});
const brandingTitle=document.getElementById('brandingTitle');if(brandingTitle)brandingTitle.oninput=()=>renderBrandingPreview();
const brandingDescription=document.getElementById('brandingDescription');if(brandingDescription)brandingDescription.oninput=()=>renderBrandingPreview();
const brandingColor=document.getElementById('brandingColor');if(brandingColor)brandingColor.oninput=()=>renderBrandingPreview();
['serverBrandName','serverBrandAvatar','serverBrandAccent','serverBrandFooter'].forEach(id=>{const el=document.getElementById(id);if(el)el.oninput=()=>renderBrandingPreview()});
 if(brandingKey)loadBrandingKey(brandingKey.value);
const savePanelDesignBtn=document.getElementById('savePanelDesign');if(savePanelDesignBtn)savePanelDesignBtn.onclick=async()=>{try{await savePanelDesign(false)}catch(e){note(e.message,'danger')}};
const publishPanelDesign=document.getElementById('publishPanelDesign');if(publishPanelDesign)publishPanelDesign.onclick=async()=>{try{await savePanelDesign(true)}catch(e){note(e.message,'danger')}};
const newPanelBtn=document.getElementById('newPanelBtn');if(newPanelBtn)newPanelBtn.onclick=()=>{ui.selectedPanelChannel='';saveUi();if(window.__dashNav)window.__dashNav.navigate('/panels')};
document.querySelectorAll('.panelPick').forEach(b=>b.onclick=()=>{ui.selectedPanelChannel=b.dataset.id||'';saveUi();if(window.__dashNav)window.__dashNav.navigate('/panels')});
['panelEditTitle','panelEditDescription','panelEditAdvisory','panelButtonLabel','panelMode','panelTicketType'].forEach(id=>{const el=document.getElementById(id);if(el)el.oninput=renderPanelPreview;if(el)el.onchange=renderPanelPreview});
if(document.getElementById('panelPreviewTitle'))renderPanelPreview();

  const wirePickList=(opts)=>{
    const {pickSelector,searchId,listId,newBtnId,deleteBtnId,onPick,onNew,onDelete,initialPick}=opts||{};
    document.querySelectorAll(pickSelector||'').forEach(btn=>btn.onclick=()=>{const name=btn.dataset.name||'';if(!name)return;onPick&&onPick(name)});
    const newBtn=document.getElementById(newBtnId||'');if(newBtn)newBtn.onclick=()=>{onNew&&onNew()};
    const delBtn=document.getElementById(deleteBtnId||'');if(delBtn)delBtn.onclick=()=>{onDelete&&onDelete()};
    const search=document.getElementById(searchId||'');const list=document.getElementById(listId||'');
    if(search&&list){search.oninput=()=>{const q=(search.value||'').trim().toLowerCase();Array.from(list.querySelectorAll('.list-btn')).forEach(it=>{const show=!q||it.textContent.toLowerCase().includes(q);it.style.display=show?'':'none'})};}
    if(initialPick) initialPick();
  };

  if(currentPath==='/commands/ticket-types'){
    wirePickList({
      pickSelector:'.ttPick',
      searchId:'typeSearch',
      listId:'typesList',
      newBtnId:'newTypeBtn',
      deleteBtnId:'deleteTypeBtn',
      onPick:(name)=>{ui.selectedType=name;saveUi();fillType(name);note('Editing ticket type: '+name,'')},
      onNew:()=>{ui.selectedType='';saveUi();if(document.getElementById('resetType'))document.getElementById('resetType').click();note('Creating new ticket type.','')},
      onDelete:async()=>{
        const name=String(ui.selectedType||'').trim();
        if(!name)return;
        if(!confirm('Delete ticket type \"'+name+'\"?'))return;
        try{await api('/api/ticket-type/delete',{method:'POST',body:JSON.stringify({guildId:state.guildId,name})});ui.selectedType='';saveUi();note('Ticket type deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedType){fillType(ui.selectedType)}}
    });
  }

  if(currentPath==='/commands/tag'){
    wirePickList({
      pickSelector:'.tagPick',
      searchId:'tagSearch',
      listId:'tagsList',
      newBtnId:'newTagBtn',
      deleteBtnId:'deleteTagBtn',
      onPick:(name)=>{ui.selectedTag=name;saveUi();fillTag(name);note('Editing tag: '+name,'')},
      onNew:()=>{ui.selectedTag='';saveUi();if(document.getElementById('resetTag'))document.getElementById('resetTag').click();note('Creating new tag.','')},
      onDelete:async()=>{
        const name=String(ui.selectedTag||'').trim();
        if(!name)return;
        if(!confirm('Delete tag \"'+name+'\"?'))return;
        try{await api('/api/tag/delete',{method:'POST',body:JSON.stringify({guildId:state.guildId,name})});ui.selectedTag='';saveUi();note('Tag deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedTag){fillTag(ui.selectedTag)}}
    });
  }

  if(currentPath==='/settings'){
    wirePickList({
      pickSelector:'.teamPick',
      searchId:'teamSearch',
      listId:'teamsList',
      newBtnId:'newTeamBtn',
      deleteBtnId:'deleteTeamBtn',
      onPick:(name)=>{ui.selectedTeam=name;saveUi();fillTeam(name);note('Editing team: '+name,'')},
      onNew:()=>{ui.selectedTeam='';saveUi();if(document.getElementById('resetTeam'))document.getElementById('resetTeam').click();note('Creating new team.','')},
      onDelete:async()=>{
        const name=String(ui.selectedTeam||'').trim();
        if(!name)return;
        if(!confirm('Delete support team \"'+name+'\"?'))return;
        try{await api('/api/support-team/delete',{method:'POST',body:JSON.stringify({guildId:state.guildId,name})});ui.selectedTeam='';saveUi();note('Support team deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedTeam){fillTeam(ui.selectedTeam)}}
    });
  }
wireRoleMultiSelect('ttRoles');
wireRoleMultiSelect('stRoles');
wireChannelSelect('feedbackId','Select feedback channel');
wireChannelSelect('feedbackConfigId','Select feedback channel');
wireChannelSelect('panelChannel','Select panel channel');
wireCategorySelect('ttCategory','Use default ticket category');
const saveTag=document.getElementById('saveTag');if(saveTag)saveTag.onclick=async()=>{try{await api('/api/tag/upsert',{method:'POST',body:JSON.stringify({guildId:state.guildId,name:tagName.value.trim(),kind:tagKind.value,title:tagTitle.value.trim(),description:tagDesc.value,keywords:tagKeys.value})});ui.selectedTag=tagName.value.trim();saveUi();note('Tag saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const resetTag=document.getElementById('resetTag');if(resetTag)resetTag.onclick=()=>{['tagName','tagTitle','tagDesc','tagKeys'].forEach(id=>document.getElementById(id).value='');if(document.getElementById('tagKind'))document.getElementById('tagKind').value='suggestion'};
/* Dyno-style pick list handles tag selection/deletion */
 document.querySelectorAll('.availSelect').forEach(sel=>{sel.onchange=async()=>{try{await api('/api/availability',{method:'POST',body:JSON.stringify({guildId:state.guildId,ticketType:sel.dataset.name,status:sel.value})});note('Availability updated.','ok');await boot()}catch(e){note(e.message,'danger')}}});
 const staffLookupBtn=document.getElementById('staffLookupBtn');if(staffLookupBtn)staffLookupBtn.onclick=async()=>{try{const q=(document.getElementById('staffLookupQuery').value||'').trim();const r=await api('/api/staff/lookup',{method:'POST',body:JSON.stringify({query:q})});const box=document.getElementById('staffLookupResult');if(box){const tag=r.user&&r.user.tag?r.user.tag:('User '+esc(r.user.id));const mk=(label,val)=>'<div class="item"><div class="item-top"><strong>'+label+'</strong><span>'+val+'</span></div></div>';box.innerHTML=[mk('User',esc(tag)+' ('+esc(r.user.id)+')'),mk('Last 7d','Claimed '+(r.stats.days7.claimed||0)+' / Closed '+(r.stats.days7.closed||0)),mk('Last 14d','Claimed '+(r.stats.days14.claimed||0)+' / Closed '+(r.stats.days14.closed||0)),mk('Last 30d','Claimed '+(r.stats.days30.claimed||0)+' / Closed '+(r.stats.days30.closed||0))].join('')}note('Lookup complete.','ok')}catch(e){note(e.message,'danger')}};
 const staffLookupClear=document.getElementById('staffLookupClear');if(staffLookupClear)staffLookupClear.onclick=()=>{const q=document.getElementById('staffLookupQuery');const box=document.getElementById('staffLookupResult');if(q)q.value='';if(box)box.innerHTML='';note('', '')};
 const formatTutorials=document.getElementById('formatTutorials');if(formatTutorials)formatTutorials.onclick=()=>{try{const box=document.getElementById('tutorialsJson');if(box)box.value=JSON.stringify(JSON.parse(box.value),null,2)}catch(e){note('Tutorial JSON is invalid.','danger')}};
 const saveTutorials=document.getElementById('saveTutorials');if(saveTutorials)saveTutorials.onclick=async()=>{try{const box=document.getElementById('tutorialsJson');const tutorials=JSON.parse((box&&box.value)||'[]');await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:Array.isArray(state&&state.botConfig&&state.botConfig.homeImages)?state.botConfig.homeImages:[],tutorials,docsSections:Array.isArray(state&&state.botConfig&&state.botConfig.docsSections)?state.botConfig.docsSections:[],siteAnnouncement:(state&&state.botConfig&&state.botConfig.siteAnnouncement)||{}})});note('Tutorials saved.','ok');await boot()}catch(e){note(e.message||'Invalid tutorial JSON.','danger')}};
 const formatDocs=document.getElementById('formatDocs');if(formatDocs)formatDocs.onclick=()=>{try{const box=document.getElementById('docsJson');if(box)box.value=JSON.stringify(JSON.parse(box.value),null,2)}catch(e){note('Documentation JSON is invalid.','danger')}};
 const saveDocs=document.getElementById('saveDocs');if(saveDocs)saveDocs.onclick=async()=>{try{const box=document.getElementById('docsJson');const docsSections=JSON.parse((box&&box.value)||'[]');await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:Array.isArray(state&&state.botConfig&&state.botConfig.homeImages)?state.botConfig.homeImages:[],tutorials:Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[],docsSections,siteAnnouncement:(state&&state.botConfig&&state.botConfig.siteAnnouncement)||{}})});note('Documentation saved.','ok');await boot()}catch(e){note(e.message||'Invalid documentation JSON.','danger')}};
 const saveAnnouncement=document.getElementById('saveAnnouncement');if(saveAnnouncement)saveAnnouncement.onclick=async()=>{try{const next={enabled:(document.getElementById('announcementEnabled')?.value||'false')==='true',text:document.getElementById('announcementText')?.value||'',ctaLabel:document.getElementById('announcementCta')?.value||'',linkUrl:document.getElementById('announcementUrl')?.value||''};await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:Array.isArray(state&&state.botConfig&&state.botConfig.homeImages)?state.botConfig.homeImages:[],tutorials:Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[],docsSections:Array.isArray(state&&state.botConfig&&state.botConfig.docsSections)?state.botConfig.docsSections:[],siteAnnouncement:next})});note('Announcement saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const tutorialCards=Array.from(document.querySelectorAll('[data-tutorial-open]'));if(tutorialCards.length){const tutorials=Array.isArray(state&&state.botConfig&&state.botConfig.tutorials)?state.botConfig.tutorials:[];const overlay=document.getElementById('tutorialOverlay');const close=document.getElementById('tutorialClose');const title=document.getElementById('tutorialModalTitle');const badge=document.getElementById('tutorialModalBadge');const body=document.getElementById('tutorialModalBody');const prev=document.getElementById('tutorialPrev');const next=document.getElementById('tutorialNext');const progressBar=document.getElementById('tutorialProgressBar');const transitionText=document.getElementById('tutorialTransitionText');const confettiCanvas=document.getElementById('tutorialConfetti');let ti=0,si=0;let confettiFrame=0;let confettiPieces=[];const stopConfetti=()=>{confettiFrame=9999;try{const ctx=confettiCanvas&&confettiCanvas.getContext?confettiCanvas.getContext('2d'):null;if(ctx)ctx.clearRect(0,0,confettiCanvas.width||0,confettiCanvas.height||0)}catch{}};const fireConfetti=()=>{if(!confettiCanvas||!confettiCanvas.getContext)return;const ctx=confettiCanvas.getContext('2d');if(!ctx)return;const dpr=Math.max(1,window.devicePixelRatio||1);confettiCanvas.width=Math.floor(window.innerWidth*dpr);confettiCanvas.height=Math.floor(window.innerHeight*dpr);confettiCanvas.style.width=window.innerWidth+'px';confettiCanvas.style.height=window.innerHeight+'px';ctx.setTransform(dpr,0,0,dpr,0,0);confettiPieces=Array.from({length:220},(_,i)=>({x:Math.random()*window.innerWidth,y:-20-Math.random()*window.innerHeight*.35,vx:(Math.random()-.5)*7,vy:3+Math.random()*6,size:6+Math.random()*10,rot:Math.random()*Math.PI,color:['#57f287','#38bdf8','#fbbf24','#fb7185','#a78bfa','#f97316'][i%6]}));confettiFrame=0;(function tick(){ctx.clearRect(0,0,window.innerWidth,window.innerHeight);for(const p of confettiPieces){p.x+=p.vx;p.y+=p.vy;p.rot+=0.08;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);ctx.fillStyle=p.color;ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size*.7);ctx.restore();}confettiFrame+=1;if(confettiFrame<220&&overlay&&overlay.style.display==='flex'){requestAnimationFrame(tick)}else{ctx.clearRect(0,0,window.innerWidth,window.innerHeight)}})()};const flashText=(text)=>{if(!transitionText)return;transitionText.textContent=text;transitionText.style.opacity='1';transitionText.style.transform='translateX(-50%) translateY(0)';setTimeout(()=>{if(transitionText){transitionText.style.opacity='0';transitionText.style.transform='translateX(-50%) translateY(-6px)'}},900)};const media=(step,tutorial)=>{if(step.videoUrl){return '<div style="margin-bottom:14px;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.24)"><video src="'+esc(step.videoUrl)+'" controls playsinline style="width:100%;max-height:52vh;display:block;background:#020617"></video></div>'}if(step.imageUrl){return '<div style="margin-bottom:14px;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.24)"><img src="'+esc(step.imageUrl)+'" alt="'+esc(step.title||tutorial.title||'Tutorial media')+'" style="width:100%;max-height:52vh;object-fit:cover;display:block" loading="lazy" /></div>'}return ''};const draw=()=>{const tutorial=tutorials[ti]||null;const step=tutorial&&tutorial.steps?tutorial.steps[si]:null;if(!tutorial||!step)return;const total=tutorial.steps.length||1;const percent=Math.max(0,Math.min(100,((si+1)/total)*100));title.textContent=tutorial.title||'Tutorial';badge.textContent=(tutorial.badge?String(tutorial.badge)+' - ':'')+'Step '+(si+1)+' of '+total;body.style.opacity='0';body.style.transform='translateY(10px)';setTimeout(()=>{body.innerHTML='<div style="display:grid;gap:14px"><div class="pill" style="width:max-content">'+esc(si+1===total?'Final step':'Guided step')+'</div>'+media(step,tutorial)+'<div><h3 style="margin:0 0 10px;font-size:28px">'+esc(step.title||'Step')+'</h3><div class="muted" style="font-size:15px;line-height:1.8;white-space:pre-wrap">'+esc(step.body||'')+'</div></div></div>';body.style.opacity='1';body.style.transform='translateY(0)'},120);if(progressBar)progressBar.style.width=percent+'%';prev.disabled=si<=0;next.textContent=si>=total-1?'Finish':'Next';if(si===total-2)flashText('Almost done!')};const open=(index)=>{ti=index;si=0;stopConfetti();draw();if(overlay)overlay.style.display='flex'};const hide=()=>{stopConfetti();if(overlay)overlay.style.display='none'};tutorialCards.forEach(btn=>btn.onclick=()=>open(Number(btn.getAttribute('data-tutorial-open')||0)));if(close)close.onclick=hide;if(overlay)overlay.onclick=(e)=>{if(e.target===overlay)hide()};if(prev)prev.onclick=()=>{if(si>0){si-=1;draw()}};if(next)next.onclick=()=>{const tutorial=tutorials[ti]||null;if(!tutorial)return hide();if(si<tutorial.steps.length-1){si+=1;draw()}else{flashText('Completed!');fireConfetti();setTimeout(()=>hide(),1300)}};window.addEventListener('resize',()=>{if(overlay&&overlay.style.display==='flex'&&confettiFrame>0&&confettiFrame<220)fireConfetti()},{passive:true});}
}
function renderOverview(){
 const totals=(state&&state.statistics&&state.statistics.totals)||{activeTickets:0,totalClaimed:0,totalClosed:0};
 const avail=Array.isArray(state&&state.availability)?state.availability:[];
 const reduced=avail.filter(a=>a&&a.status==='reduced_assistance').length;
 const limited=avail.filter(a=>a&&a.status==='increased_volume').length;
 const topReasons=Array.isArray(state&&state.statistics&&state.statistics.topCloseReasons)?state.statistics.topCloseReasons.slice(0,4):[];
 const tags=Array.isArray(state&&state.statistics&&state.statistics.tagUsage)?state.statistics.tagUsage.slice(0,6):[];
 const imgs=Array.isArray(state&&state.botConfig&&state.botConfig.homeImages)?state.botConfig.homeImages:[];
 const img0=esc(imgs[0]||''),img1=esc(imgs[1]||''),img2=esc(imgs[2]||'');
 const hour=(new Date()).getHours();
 const greet=hour<12?'Good morning':(hour<18?'Good afternoon':'Good evening');
 const isOwner=Boolean(state&&state.isOwner);
 const tutorialOn=Boolean(state&&state.guildConfigSummary&&state.guildConfigSummary.tutorialEnabled);
 const rolePermanent=!(state&&state.guildConfigSummary&&state.guildConfigSummary.rolePermanence===false);
 const pill=(n)=>'<span class="pill">'+Number(n||0)+'</span>';
 const preview=imgs.length
  ? ('<div class="row" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px">'+
     imgs.slice(0,3).map(u=>'<a href=\"'+esc(u)+'\" target=\"_blank\" rel=\"noreferrer\" style=\"display:block;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)\"><img src=\"'+esc(u)+'\" style=\"display:block;width:100%;height:92px;object-fit:cover\" loading=\"lazy\" /></a>').join('')+
    '</div>')
  : '';
 const imagesCard='';
 const tutorialCard=tutorialOn
  ? ('<div class="card"><h3>Tutorial Library</h3><div class="muted">Open the tutorial cards for walkthroughs, screenshots, and step-by-step staff flows.</div><div class="row" style="grid-template-columns:1fr;gap:10px;margin-top:12px"><button type="button" class="btn qa" data-go="/tutorials">Open Tutorials</button></div><div class="muted" style="margin-top:10px">'+(rolePermanent?'Role permanence is enabled.':'Role permanence is disabled.')+'</div></div>')
  : '';

 return '<div class="page-shell">'+
  '<div class="card page-hero welcome"><div class="page-hero-head"><div><div class="page-kicker">Overview</div><h3>'+greet+', welcome back.</h3><p>Keep an eye on queue pressure, jump into the right module quickly, and only surface the things that need attention.</p></div><div class="page-pill-row">'+pill(totals.activeTickets||0)+' '+pill(limited)+' '+pill(reduced)+'</div></div></div>'+
  '<div class="stat-strip">'+
   '<div class="stat-tile"><div class="muted">Active tickets</div><strong>'+Number(totals.activeTickets||0)+'</strong></div>'+
   '<div class="stat-tile"><div class="muted">Closed (14d)</div><strong>'+Number(totals.totalClosed||0)+'</strong></div>'+
   '<div class="stat-tile"><div class="muted">Limited types</div><strong>'+limited+'</strong></div>'+
   '<div class="stat-tile"><div class="muted">Reduced types</div><strong>'+reduced+'</strong></div>'+
  '</div>'+
  '<div class="grid">'+
  '<div class="card"><h3>Quick Actions</h3><p class="muted">Open the next place you are likely to need without digging through menus.</p>'+
   '<div class="quick-grid" style="margin-top:10px">'+
    '<button type="button" class="btn-soft qa" data-go="/tickets">View Tickets</button>'+
    '<button type="button" class="btn-soft qa" data-go="/commands/ticket-types">Ticket Types</button>'+
    '<button type="button" class="btn-soft qa" data-go="/availability">Availability</button>'+
    '<button type="button" class="btn-soft qa" data-go="/panels">Panels</button>'+
    '<button type="button" class="btn-soft qa" data-go="/embed-editor">Branding</button>'+
   '</div>'+
  '</div>'+

  imagesCard+
  tutorialCard+

  '<div class="card"><h3>Top Close Reasons (30d)</h3><div class="list" style="margin-top:10px">'+
   (topReasons.length?topReasons.map(r=>'<div class="item"><div class="item-top"><strong>'+esc(r.reason||'Unknown')+'</strong>'+pill(r.count)+'</div></div>').join(''):'<div class="muted">No data yet.</div>')+
  '</div></div>'+

  '<div class="card"><h3>Popular Tags</h3><div class="list" style="margin-top:10px">'+
   (tags.length?tags.map(t=>'<div class="item"><div class="item-top"><strong>'+esc(t.name||'')+'</strong>'+pill(t.count)+'</div></div>').join(''):'<div class="muted">No tag usage yet.</div>')+
  '</div></div>'+
 '</div></div>'}
function renderAnnouncementBar(){const box=document.getElementById('announcementBar');if(!box)return;const ann=(state&&state.botConfig&&state.botConfig.siteAnnouncement)||{};if(!ann.enabled||!ann.text){box.innerHTML='';return}box.innerHTML='<div class="card" style="margin-bottom:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px"><div><strong>Announcement</strong><div class="muted">'+esc(ann.text)+'</div></div>'+(ann.ctaLabel&&ann.linkUrl?'<a class="btn" href="'+esc(ann.linkUrl)+'" target="_blank" rel="noreferrer">'+esc(ann.ctaLabel)+'</a>':'')+'</div>'}
function renderPageHero(path){
  const title=navTitleForPath(path);
  const desc=pageDescForPath(path);
 const access=(state&&state.access)||{};
 const chips=[];
 if(state&&state.guildId)chips.push('<span class="pill">Guild '+esc(state.guildId)+'</span>');
 if(access.isOwner)chips.push('<span class="pill">Owner access</span>');
 else if(access.isManager)chips.push('<span class="pill">Manager access</span>');
 else if(access.isStaff)chips.push('<span class="pill">Staff access</span>');
 return '<div class="card page-hero"><div class="page-hero-head"><div><div class="page-kicker">Module</div><h3>'+esc(title)+'</h3><p>'+esc(desc)+'</p></div><div class="page-pill-row">'+chips.join('')+'</div></div></div>';
}
function render(){const access=(state&&state.access)||{};const plan=(state&&state.aiAccess)||{};const allowed=new Set(['/documentation','/tutorials','/pricing','/upgrade','/privacy','/terms']);if(access.isOwner||access.canFullDashboard){['/overview','/settings','/availability','/commands/ticket-types','/panels','/commands/tag','/tickets','/transcripts','/commands/feedback','/pricing','/upgrade'].forEach(p=>allowed.add(p));if(plan.isPlusOrHigher)allowed.add('/statistics');if(plan.isCustom)allowed.add('/embed-editor')}else{if(access.canManageTicketTypes){allowed.add('/settings');allowed.add('/commands/ticket-types');allowed.add('/panels');if(plan.isCustom)allowed.add('/embed-editor')}if(plan.isPlusOrHigher&&access.canManageTicketTypes)allowed.add('/statistics');if(access.canManageAvailability)allowed.add('/availability');if(access.canViewTickets||access.canManageEscalations)allowed.add('/tickets');if(access.canViewTranscripts)allowed.add('/transcripts')}let html='';if(!allowed.has(currentPath)){html='<div class="card"><h3>Access Restricted</h3><p class="muted">This module is not available for your current role or server plan.</p></div>'}else if(currentPath==='/overview')html=renderOverview();else if(currentPath==='/settings')html=renderPageHero(currentPath)+renderSettings();else if(currentPath==='/availability')html=renderPageHero(currentPath)+renderAvailability();else if(currentPath==='/tutorials')html=renderPageHero(currentPath)+renderTutorials();else if(currentPath==='/commands/ticket-types')html=renderPageHero(currentPath)+renderTypes();else if(currentPath==='/panels')html=renderPageHero(currentPath)+renderPanels();else if(currentPath==='/commands/tag')html=renderPageHero(currentPath)+renderTags();else if(currentPath==='/tickets')html=renderPageHero(currentPath)+renderTickets();else if(currentPath==='/transcripts')html=renderPageHero(currentPath)+renderTranscripts();else if(currentPath==='/commands/feedback')html=renderPageHero(currentPath)+renderFeedback();else if(currentPath==='/commands/appeal')html=renderPageHero(currentPath)+renderAppeal();else if(currentPath==='/statistics')html=renderPageHero(currentPath)+renderStats();else if(currentPath==='/embed-editor')html=renderPageHero(currentPath)+renderBranding();else if(currentPath==='/pricing')html=renderPageHero(currentPath)+renderPricing();else if(currentPath==='/upgrade')html=renderPageHero(currentPath)+renderUpgrade();else html=renderPageHero(currentPath)+renderDocs();document.title=${JSON.stringify(BRAND_NAME + ' - ')}+({"/overview":"Home","/settings":"Settings","/availability":"Availability","/tutorials":"Tutorials","/commands/ticket-types":"Ticket Types","/panels":"Panels","/commands/tag":"Tags","/tickets":"Tickets","/transcripts":"Transcripts","/commands/feedback":"Feedback","/statistics":"Statistics","/embed-editor":"Branding","/pricing":"Pricing","/upgrade":"Upgrade","/documentation":"Documentation","/privacy":"Privacy","/terms":"Terms"}[currentPath]||'Dashboard');renderAnnouncementBar();app.classList.add('swap');requestAnimationFrame(()=>{app.innerHTML=html;requestAnimationFrame(()=>{app.classList.remove('swap');wire()})})}
function showUpgradeCelebration(plan){const label=String(plan||'Plus');let overlay=document.getElementById('upgradeOverlay');if(!overlay){overlay=document.createElement('div');overlay.id='upgradeOverlay';overlay.className='upgrade-overlay';overlay.innerHTML='<canvas class="upgrade-confetti" id="upgradeConfetti"></canvas><div class="upgrade-card"><div class="page-kicker">Upgrade complete</div><h2 id="upgradeTitle"></h2><div class="muted">You\\'ve unlocked:</div><ul id="upgradeList"></ul><button class="btn" id="upgradeClose" style="margin-top:18px">Continue</button></div>';document.body.appendChild(overlay)}const title=document.getElementById('upgradeTitle');const list=document.getElementById('upgradeList');if(title)title.textContent='You\\'ve upgraded to '+label+'!';const items=label==='Custom'?['White-label bot branding','Diamond dashboard theme','Custom bot instance controls','Everything in Plus and Pro']:label==='Pro'?['Statistics','Advanced operations','Priority support controls']:['Statistics','Improved analytics','Premium dashboard modules'];if(list)list.innerHTML=items.map(x=>'<li>'+esc(x)+'</li>').join('');overlay.classList.add('show');const canvas=document.getElementById('upgradeConfetti');if(canvas&&canvas.getContext){const ctx=canvas.getContext('2d');const dpr=Math.max(1,window.devicePixelRatio||1);canvas.width=Math.floor(window.innerWidth*dpr);canvas.height=Math.floor(window.innerHeight*dpr);canvas.style.width=window.innerWidth+'px';canvas.style.height=window.innerHeight+'px';ctx.setTransform(dpr,0,0,dpr,0,0);const pieces=Array.from({length:180},(_,i)=>({x:Math.random()*window.innerWidth,y:window.innerHeight+Math.random()*80,vx:(Math.random()-.5)*5,vy:-(4+Math.random()*7),g:.08+Math.random()*.04,s:5+Math.random()*9,r:Math.random()*6,c:['#67e8f9','#d9f99d','#fef08a','#c4b5fd','#f8fafc'][i%5]}));let frame=0;(function tick(){ctx.clearRect(0,0,window.innerWidth,window.innerHeight);pieces.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=p.g;p.r+=.12;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s*.65);ctx.restore()});frame++;if(frame<210&&overlay.classList.contains('show'))requestAnimationFrame(tick);else ctx.clearRect(0,0,window.innerWidth,window.innerHeight)})()}const close=document.getElementById('upgradeClose');if(close)close.onclick=()=>overlay.classList.remove('show')}
function handlePlanExperience(){const plan=(state&&state.aiAccess)||{};if(!plan.hasAccess||!plan.grantedAt)return;const key='dash_upgrade_seen_'+String(state.guildId||'global');const marker=String(plan.plan||'')+'@'+String(plan.grantedAt||'');try{if(localStorage.getItem(key)!==marker){localStorage.setItem(key,marker);showUpgradeCelebration(plan.planLabel||'upgrade')}}catch{}}
async function boot(){state=await api('/api/state'+(location.search||''));handlePlanExperience();render()}
const refreshStateBtn=document.getElementById('refreshStateBtn');if(refreshStateBtn)refreshStateBtn.onclick=async()=>{try{await boot();note('Dashboard refreshed.','ok')}catch(e){note(e.message,'danger')}};
const authLoginBtn=document.getElementById('authLogin');if(authLoginBtn)authLoginBtn.onclick=async()=>{try{localStorage.setItem(tokenKey,authToken.value.trim());await api('/api/auth/login',{method:'POST',body:JSON.stringify({token:authToken.value.trim()})});auth.style.display='none';authMsg.textContent='';await boot()}catch(e){authMsg.textContent=e.message||'Login failed'}};
(function(){try{if(authDiscord)authDiscord.href='/login?next='+encodeURIComponent(location.pathname+location.search)}catch{}})();
(async()=>{try{await boot()}catch(e){if((e&&e.message)==='Unauthorized')auth.style.display='flex';else note((e&&e.message)||'Dashboard failed to load.','danger')}})();
</script></body></html>`;
}

function startDashboard(client, customBotManager = null) {
    if (!getDashboardEnabled()) {
        dashboardLog('Dashboard disabled via DASHBOARD_ENABLED=false.');
        return null;
    }

    if (dashboardServer) return dashboardServer;

    dashboardServer = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;

            const requestedGuildId = String(url.searchParams.get('guild') || '').trim();
            if (/^\d{17,20}$/.test(requestedGuildId) && isAuthed(req) && client?.guilds?.cache?.has(requestedGuildId)) {
                const userId = getDashboardSessionUserId(req);
                const ownerId = getBotOwnerId();
                const allowed = !userId || (ownerId && userId === ownerId) || getDashboardSessionGuildIds(req).includes(requestedGuildId);
                if (allowed) {
                    appendSetCookie(res, `dashboard_guild=${encodeURIComponent(requestedGuildId)}; ${cookieAttributes({
                        maxAge: 2592000,
                        secure: isHttpsPublicBaseUrl()
                    })}`);
                }
            }

            if (pathname.startsWith('/api/')) {
                const handled = await handleApi(req, res, url, client, customBotManager);
                if (!handled) sendJson(res, 404, { error: 'Not found' });
                return;
            }

            if (pathname.startsWith('/assets/')) {
                const rel = pathname.replace(/^\/assets\//, '');
                const resolved = path.resolve(ASSETS_DIR, rel);
                if (!resolved.startsWith(path.resolve(ASSETS_DIR))) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }

                const ext = path.extname(resolved).toLowerCase();
                const contentType = ext === '.svg'
                    ? 'image/svg+xml'
                    : ext === '.css'
                        ? 'text/css; charset=utf-8'
                        : ext === '.js'
                            ? 'text/javascript; charset=utf-8'
                    : ext === '.png'
                        ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                        ? 'image/jpeg'
                            : ext === '.webp'
                                ? 'image/webp'
                                : ext === '.ico'
                                    ? 'image/x-icon'
                                    : 'application/octet-stream';

                res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
                res.end(fs.readFileSync(resolved));
                return;
            }

            if (pathname === '/') {
                sendHtml(res, 200, createHomeHtml({ showOwnerGallery: isStrictOwnerViewer(req) }));
                return;
            }

            if (pathname === '/home') {
                sendHtml(res, 200, createHomeHtml({ showOwnerGallery: isStrictOwnerViewer(req) }));
                return;
            }

            if (pathname === '/controller' || pathname === '/controller/') {
                if (hasDiscordOAuthConfigured() && !getDashboardSessionUserId(req)) {
                    const next = encodeURIComponent('/controller' + (url.search || ''));
                    res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                if (!isBotOwnerUser(req)) {
                    sendHtml(res, 403, '<h1>403</h1><p>Owner user only.</p>');
                    return;
                }
                sendHtml(res, 200, createControllerHtml(req));
                return;
            }

            if (pathname === '/owner' || pathname === '/owner/') {
                if (hasDiscordOAuthConfigured() && !getDashboardSessionUserId(req)) {
                    const next = encodeURIComponent('/owner' + (url.search || ''));
                    res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                if (!isBotOwnerUser(req)) {
                    sendHtml(res, 403, '<h1>403</h1><p>Owner user only.</p>');
                    return;
                }
                sendHtml(res, 200, createOwnerHtml(req));
                return;
            }

            if (pathname === '/dashboard' || pathname === '/dashboard/') {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent('/dashboard' + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }
                const ownerView = isStrictOwnerViewer(req);
                const staffAccess = await getSeniorStaffAccess(client, req);
                sendHtml(res, 200, createServerPickerHtml({ ownerView, showStaffLink: ownerView || staffAccess.allowed, req }));
                return;
            }

            if (pathname === '/staff' || pathname === '/staff/') {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent('/staff' + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }
                {
                    const staffAccess = await getSeniorStaffAccess(client, req);
                    if (!staffAccess.allowed) {
                        sendHtml(res, 403, '<h1>403</h1><p>Senior staff only.</p>');
                        return;
                    }
                }
                sendHtml(res, 200, createStaffHtml({ ownerView: isStrictOwnerViewer(req), req }));
                return;
            }

            if (pathname === '/setup' || pathname === '/setup/') {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent('/setup' + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }
                {
                    const targetGuildId = requestedGuildId || getDashboardGuild(client, req)?.id || null;
                    const access = await getDashboardAccess(client, req, targetGuildId);
                    const allowedPages = getAllowedDashboardPages(access);
                    if (!allowedPages.has('/setup')) {
                        sendHtml(res, 403, '<h1>403</h1><p>You do not have access to setup for this server.</p>');
                        return;
                    }
                    if (!access?.isOwner && !isStrictOwnerViewer(req) && targetGuildId) {
                        const setupConfig = typeof ticketStore.getGuildConfig === 'function'
                            ? ticketStore.getGuildConfig(targetGuildId, ticketStore.getActiveStorage())
                            : {};
                        if (Boolean(setupConfig?.setup?.completed)) {
                            sendHtml(res, 403, '<h1>403</h1><p>This server has already completed setup.</p>');
                            return;
                        }
                    }
                }
                sendHtml(res, 200, createSetupHtml(req));
                return;
            }

            function createPricingPage(req = null) {
                return baseDashboardPage({
                    title: 'Pricing',
                    body: `
                        <div class="pricing-page">
                            <section class="pricing-hero card">
                                <div class="pricing-kicker">Pricing</div>
                                <h1>Plans for cleaner Discord support.</h1>
                                <p class="muted" style="max-width:680px;margin:0">Choose Free, Plus, Pro, or Enterprise for custom branded bot operations.</p>
                                <div class="row" style="margin-top:8px">
                                    <a class="btn primary" href="#plans">View plans</a>
                                    <a class="btn" href="#faq">FAQ</a>
                                </div>
                            </section>
                            <section id="plans" class="pricing-grid">
                                <div class="pricing-card"><div class="plan-top"><div><div class="plan-name">Free</div><div class="plan-note">Core ticket workflows.</div></div></div><div class="plan-price">$0</div><div class="pricing-feature-list"><div class="pricing-feature"><span class="dot"></span>Unlimited Tickets</div><div class="pricing-feature"><span class="dot"></span>Custom Panels</div><div class="pricing-feature"><span class="dot"></span>Logs and Transcripts</div></div><a class="btn" href="/dashboard">Get started</a></div>
                                <div class="pricing-card featured"><div class="plan-top"><div><div class="plan-name">Plus</div><div class="plan-note">Better visibility for growing teams.</div></div><span class="plan-badge">Most Popular</span></div><div class="plan-price">$12/mo</div><div class="pricing-feature-list"><div class="pricing-feature"><span class="dot"></span>Statistics</div><div class="pricing-feature"><span class="dot"></span>Staff Activity</div><div class="pricing-feature"><span class="dot"></span>Priority Support</div><div class="pricing-feature"><span class="dot"></span>Everything in Free</div></div><a class="btn primary" href="/upgrade">Upgrade</a></div>
                                <div class="pricing-card"><div class="plan-top"><div><div class="plan-name">Pro</div><div class="plan-note">Automation for busier support teams.</div></div></div><div class="plan-price">$24/mo</div><div class="pricing-feature-list"><div class="pricing-feature"><span class="dot"></span>AI Moderation</div><div class="pricing-feature"><span class="dot"></span>Advanced Analytics</div><div class="pricing-feature"><span class="dot"></span>Higher Automation Limits</div><div class="pricing-feature"><span class="dot"></span>Everything in Plus</div></div><a class="btn" href="/upgrade">Upgrade</a></div>
                                <div class="pricing-card"><div class="plan-top"><div><div class="plan-name">Enterprise</div><div class="plan-note">Custom branded bot and guided setup.</div></div></div><div class="plan-price">Custom</div><div class="pricing-feature-list"><div class="pricing-feature"><span class="dot"></span>Custom Bot Runtime</div><div class="pricing-feature"><span class="dot"></span>Developer Portal Guidance</div><div class="pricing-feature"><span class="dot"></span>Webhook Monitoring</div><div class="pricing-feature"><span class="dot"></span>Everything in Pro</div></div><a class="btn" href="/upgrade">Contact sales</a></div>
                            </section>
                            <section class="pricing-table card">
                                <h2 style="margin:0 0 16px">Feature comparison</h2>
                                <table><thead><tr><th>Feature</th><th>Free</th><th>Plus</th><th>Pro</th><th>Enterprise</th></tr></thead><tbody>
                                    <tr><td>Tickets</td><td class="active">Yes</td><td class="active">Yes</td><td class="active">Yes</td><td class="active">Yes</td></tr>
                                    <tr><td>Statistics</td><td>-</td><td class="active">Yes</td><td class="active">Yes</td><td class="active">Yes</td></tr>
                                    <tr><td>AI Moderation</td><td>-</td><td>-</td><td class="active">Yes</td><td class="active">Yes</td></tr>
                                    <tr><td>Custom Branded Bot</td><td>-</td><td>-</td><td>-</td><td class="active">Yes</td></tr>
                                    <tr><td>Priority Support</td><td>-</td><td class="active">Yes</td><td class="active">Yes</td><td class="active">Yes</td></tr>
                                </tbody></table>
                            </section>
                            <section id="faq" class="pricing-faq">
                                <div class="faq-item"><strong>Can I upgrade later?</strong><p class="muted">Yes. Start free and upgrade without losing your dashboard setup.</p></div>
                                <div class="faq-item"><strong>What does Plus add?</strong><p class="muted">Statistics, staff activity, and priority support.</p></div>
                                <div class="faq-item"><strong>What does Pro add?</strong><p class="muted">AI moderation and advanced automation for busier teams.</p></div>
                                <div class="faq-item"><strong>What is Enterprise?</strong><p class="muted">Enterprise adds the custom branded bot runtime and guided setup.</p></div>
                            </section>
                            <section class="pricing-cta card"><div class="pricing-kicker">Ready</div><h2 style="margin:0 0 10px">Choose the support setup that fits your server.</h2><p class="muted">Keep it simple now, upgrade when the queue grows.</p><div class="row" style="justify-content:center;margin-top:18px"><a class="btn primary" href="/upgrade">Upgrade to Plus</a><a class="btn" href="/dashboard">Open dashboard</a></div></section>
                        </div>
                    `,
                    ownerView: false,
                    showStaffLink: false
                });
            }            function createUpgradePage(req = null) {
                return baseDashboardPage({
                    title: 'Upgrade',
                    body: '<section class="card upgrade-reward">' +
                        '<div class="upgrade-word w1">FREE</div><div class="upgrade-word w2">PLUS</div><div class="upgrade-word w3">PRO</div><div class="upgrade-word w4">ENTERPRISE</div>' +
                        '<div style="position:relative;z-index:1;max-width:900px"><div class="pricing-kicker">Upgrade options</div><h1 style="font-size:clamp(38px,6vw,72px);line-height:1;margin:0 0 14px">Choose your next support tier.</h1><p class="muted" style="font-size:16px">Free keeps tickets running. Plus adds visibility. Pro adds automation. Enterprise adds the custom branded bot runtime and guided setup.</p><div class="pricing-grid" style="margin-top:24px;text-align:left"><div class="pricing-card"><div class="plan-name">Free</div><div class="plan-price">$0</div><div class="plan-note">Tickets, panels, logs, and transcripts.</div></div><div class="pricing-card featured"><div class="plan-name">Plus</div><div class="plan-price">$12/mo</div><div class="plan-note">Statistics, staff activity, and priority support.</div></div><div class="pricing-card"><div class="plan-name">Pro</div><div class="plan-price">$24/mo</div><div class="plan-note">AI moderation and advanced automation.</div></div><div class="pricing-card"><div class="plan-name">Enterprise</div><div class="plan-price">Custom</div><div class="plan-note">Custom branded bot runtime and monitoring.</div></div></div><div class="row" style="justify-content:center;margin-top:24px"><a class="btn primary" href="https://discord.gg/JSUX9GQP6J" target="_blank" rel="noreferrer">Contact us in support</a><a class="btn-soft" href="/pricing">Compare plans</a></div></div>' +
                    '</section>',
                    ownerView: false,
                    showStaffLink: false
                });
            }
            if (pathname === '/pricing' || pathname === '/pricing/') {
                sendHtml(res, 200, createPricingPage(req));
                return;
            }

            if (pathname === '/upgrade' || pathname === '/upgrade/') {
                sendHtml(res, 200, createUpgradePage(req));
                return;
            }

            if (pathname === '/privacy' || pathname === '/privacy/') {
                sendHtml(res, 200, createLegalHtml('privacy'));
                return;
            }

            if (pathname === '/terms' || pathname === '/terms/') {
                sendHtml(res, 200, createLegalHtml('terms'));
                return;
            }

            if (pathname === '/commands/appeal') {
                res.writeHead(302, { Location: '/commands/feedback' });
                res.end();
                return;
            }

            if (pathname === '/login') {
                const next = safeDashboardNextPath(url.searchParams.get('next'));
                if (getDashboardSessionUserId(req)) {
                    res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1><p>Set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET.</p>');
                    return;
                }

                const redirectUri = `${getPublicBaseUrl()}/auth/dashboard/callback`;
                const state = randomToken(18);
                dashboardOauthStates.set(state, { next, createdAt: Date.now() });

                const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
                authorizeUrl.searchParams.set('client_id', getDiscordOAuthClientId());
                authorizeUrl.searchParams.set('redirect_uri', redirectUri);
                authorizeUrl.searchParams.set('response_type', 'code');
                authorizeUrl.searchParams.set('scope', 'identify guilds');
                authorizeUrl.searchParams.set('state', state);

                res.writeHead(302, { Location: authorizeUrl.toString(), 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/dashboard/callback') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1>');
                    return;
                }

                const code = String(url.searchParams.get('code') || '').trim();
                const state = String(url.searchParams.get('state') || '').trim();
                const saved = dashboardOauthStates.get(state);
                dashboardOauthStates.delete(state);
                const next = safeDashboardNextPath(saved?.next);

                if (!code || !state || !saved) {
                    sendHtml(res, 400, '<h1>Invalid OAuth callback</h1><p>Try signing in again.</p>');
                    return;
                }

                try {
                    const redirectUri = `${getPublicBaseUrl()}/auth/dashboard/callback`;
                    const body = new URLSearchParams();
                    body.set('client_id', getDiscordOAuthClientId());
                    body.set('client_secret', getDiscordOAuthClientSecret());
                    body.set('grant_type', 'authorization_code');
                    body.set('code', code);
                    body.set('redirect_uri', redirectUri);

                    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body
                    });

                    const tokenJson = await tokenRes.json().catch(() => ({}));
                    if (!tokenRes.ok) {
                        throw new Error(String(tokenJson?.error_description || tokenJson?.error || 'OAuth token exchange failed.'));
                    }

                    const accessToken = String(tokenJson.access_token || '').trim();
                    if (!accessToken) {
                        throw new Error('No access token returned from Discord.');
                    }

                    const userRes = await fetch('https://discord.com/api/users/@me', {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    const userJson = await userRes.json().catch(() => ({}));
                    if (!userRes.ok) {
                        throw new Error('Unable to fetch Discord user.');
                    }

                    const userId = String(userJson?.id || '').trim();
                    if (!/^\d{17,20}$/.test(userId)) {
                        throw new Error('Invalid Discord user id.');
                    }

                    const ownerId = getBotOwnerId();
                    let manageableGuildIds = [];
                    let oauthGuilds = [];

                    // Owner gets global access automatically.
                    if (ownerId && userId === ownerId) {
                        manageableGuildIds = [...client.guilds.cache.keys()];
                    } else {
                        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        });
                        const guildsJson = await guildsRes.json().catch(() => ([]));
                        if (!guildsRes.ok || !Array.isArray(guildsJson)) {
                            throw new Error('Unable to fetch guild list (OAuth scope "guilds" required).');
                        }

                        for (const g of guildsJson) {
                            const id = String(g?.id || '').trim();
                            if (!/^\d{17,20}$/.test(id)) continue;
                            oauthGuilds.push({
                                id,
                                name: String(g?.name || '').trim(),
                                icon: String(g?.icon || '').trim() || null,
                                owner: Boolean(g?.owner),
                                permissions: String(g?.permissions || '0').trim() || '0'
                            });
                            if (!client.guilds.cache.has(id)) continue; // only guilds this bot is in
                            manageableGuildIds.push(id);
                        }
                        manageableGuildIds = [...new Set(manageableGuildIds)];
                    }

                    setDashboardSession(res, userId, manageableGuildIds, oauthGuilds);
                    res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                } catch (error) {
                    console.error('[Dashboard] OAuth error:', error);
                    sendHtml(res, 500, `<h1>OAuth Error</h1><p>${String(error?.message || error)}</p>`);
                    return;
                }
            }

            if (pathname === '/logout') {
                clearDashboardSession(res);
                res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/discord') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1><p>Set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET.</p>');
                    return;
                }

                const redirectUri = `${getPublicBaseUrl()}/auth/discord/callback`;
                const next = safeNextPath(url.searchParams.get('next'));
                const state = randomToken(18);
                transcriptOauthStates.set(state, { next, createdAt: Date.now() });

                const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
                authorizeUrl.searchParams.set('client_id', getDiscordOAuthClientId());
                authorizeUrl.searchParams.set('redirect_uri', redirectUri);
                authorizeUrl.searchParams.set('response_type', 'code');
                authorizeUrl.searchParams.set('scope', 'identify');
                authorizeUrl.searchParams.set('state', state);

                res.writeHead(302, { Location: authorizeUrl.toString(), 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/discord/callback') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1>');
                    return;
                }

                const code = String(url.searchParams.get('code') || '').trim();
                const state = String(url.searchParams.get('state') || '').trim();
                const saved = transcriptOauthStates.get(state);
                transcriptOauthStates.delete(state);
                const next = safeNextPath(saved?.next);

                if (!code || !state || !saved) {
                    sendHtml(res, 400, '<h1>Invalid OAuth callback</h1><p>Try opening the transcript link again.</p>');
                    return;
                }

                try {
                    const redirectUri = `${getPublicBaseUrl()}/auth/discord/callback`;
                    const body = new URLSearchParams();
                    body.set('client_id', getDiscordOAuthClientId());
                    body.set('client_secret', getDiscordOAuthClientSecret());
                    body.set('grant_type', 'authorization_code');
                    body.set('code', code);
                    body.set('redirect_uri', redirectUri);

                    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body
                    });

                    const tokenJson = await tokenRes.json().catch(() => ({}));
                    if (!tokenRes.ok) {
                        throw new Error(String(tokenJson?.error_description || tokenJson?.error || 'OAuth token exchange failed.'));
                    }

                    const accessToken = String(tokenJson.access_token || '').trim();
                    if (!accessToken) {
                        throw new Error('No access token returned from Discord.');
                    }

                    const userRes = await fetch('https://discord.com/api/users/@me', {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    const userJson = await userRes.json().catch(() => ({}));
                    if (!userRes.ok) {
                        throw new Error('Unable to fetch Discord user.');
                    }

                    const userId = String(userJson?.id || '').trim();
                    if (!/^\d{17,20}$/.test(userId)) {
                        throw new Error('Invalid Discord user id.');
                    }

                    setTranscriptSession(res, userId);
                    res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                } catch (error) {
                    console.error('[Dashboard] OAuth error:', error);
                    sendHtml(res, 500, `<h1>OAuth Error</h1><p>${String(error?.message || error)}</p>`);
                    return;
                }
            }

            if (pathname === '/auth/logout') {
                clearTranscriptSession(res);
                res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/t/' || pathname === '/t') {
                sendHtml(res, 404, '<h1>404</h1>');
                return;
            }

            if (pathname.startsWith('/t/')) {
                const token = String(pathname.slice('/t/'.length) || '').trim();
                if (!token || token.includes('/')) {
                    sendHtml(res, 404, '<h1>404</h1>');
                    return;
                }

                const activeStorage = ticketStore.getActiveStorage();
                const archives = Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : [];
                const entry = archives.find(a => a && String(a.publicToken || '') === token) || null;

                if (!entry) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const oauthConfigured = hasDiscordOAuthConfigured();
                const oauthRequired = isTranscriptOAuthRequired();
                const userId = getTranscriptSessionUserId(req);

                if (oauthRequired && !oauthConfigured) {
                    sendHtml(res, 503, '<h1>Transcript Viewer Not Configured</h1><p>Admin: set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET (or set TRANSCRIPT_REQUIRE_OAUTH=false to allow link-only access).</p>');
                    return;
                }

                if (oauthConfigured) {
                    if (!userId) {
                        const next = encodeURIComponent(pathname + (url.search || ''));
                        res.writeHead(302, { Location: `/auth/discord?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }

                    const allowed = Array.isArray(entry.allowedUserIds) ? entry.allowedUserIds.map(String) : [];
                    if (allowed.length && !allowed.includes(String(userId))) {
                        sendHtml(res, 403, '<h1>403</h1><p>You are not allowed to view this transcript.</p>');
                        return;
                    }
                }

                const channelId = String(entry.channelId || '').trim();
                const fileName = String(entry.fileName || `${channelId}.html`);
                const filePath = resolveTranscriptPath(channelId, fileName);

                if (!fs.existsSync(filePath)) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const downloadRaw = String(url.searchParams.get('download') || url.searchParams.get('dl') || '').toLowerCase();
                const wantsDownload = downloadRaw === '1' || downloadRaw === 'true' || url.searchParams.has('download');
                const headers = {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Robots-Tag': 'noindex, nofollow'
                };
                if (wantsDownload) headers['Content-Disposition'] = `attachment; filename="${channelId}.html"`;
                res.writeHead(200, headers);
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            if (pathname === '/transcripts/') {
                res.writeHead(302, { Location: '/transcripts' });
                res.end();
                return;
            }

            if (pathname.startsWith('/transcripts/')) {
                if (!isAuthed(req)) {
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }

                const id = String(pathname.slice('/transcripts/'.length) || '').trim();
                if (!/^\d{17,20}$/.test(id)) {
                    sendHtml(res, 404, '<h1>404</h1>');
                    return;
                }

                const activeStorage = ticketStore.getActiveStorage();
                const archives = Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : [];
                const entry = archives.find(a => a && String(a.channelId) === id) || null;
                const fileName = String(entry?.fileName || `${id}.html`);
                const filePath = resolveTranscriptPath(id, fileName);

                if (!fs.existsSync(filePath)) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const downloadRaw = String(url.searchParams.get('download') || url.searchParams.get('dl') || '').toLowerCase();
                const wantsDownload = downloadRaw === '1' || downloadRaw === 'true' || url.searchParams.has('download');
                const headers = {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                };
                if (wantsDownload) headers['Content-Disposition'] = `attachment; filename="${id}.html"`;
                res.writeHead(200, headers);
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            const pages = new Set(['/overview', '/settings', '/availability', '/tutorials', '/commands/ticket-types', '/panels', '/commands/tag', '/tickets', '/transcripts', '/commands/feedback', '/statistics', '/embed-editor', '/documentation', '/privacy', '/terms']);
            if (pages.has(pathname)) {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent(pathname + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }

                const access = await getDashboardAccess(client, req, requestedGuildId || getDashboardGuild(client, req)?.id || null);
                const allowedPages = getAllowedDashboardPages(access);
                if (!allowedPages.has(pathname)) {
                    sendHtml(res, 403, '<h1>403</h1><p>You do not have access to this page.</p>');
                    return;
                }
                sendHtml(res, 200, createUiHtml(pathname));
                return;
            }

            sendHtml(res, 404, '<h1>404</h1>');
        } catch (error) {
            console.error('[Dashboard] Request error:', error);
            if (!res.writableEnded) sendJson(res, 500, { error: 'Internal server error' });
        }
    });

    const portConfigured = isDashboardPortConfigured();
    const startingPort = getDashboardPort();
    let port = startingPort;
    const host = getDashboardHost();
    const attempted = new Set();

    const tryListen = nextPort => {
        attempted.add(nextPort);
        port = nextPort;
        dashboardServer.listen(nextPort, host, () => {
            const displayHost = host === '0.0.0.0' ? '<your-computer-ip>' : host;
            dashboardLog(`Running at http://${displayHost}:${nextPort} (bound to ${host})`);
        });
    };

    dashboardServer.on('error', error => {
        const code = error && typeof error === 'object' ? error.code : null;
        if (code === 'EADDRINUSE') {
            if (!portConfigured) {
                const upper = startingPort + 15;
                let next = null;
                for (let p = startingPort; p <= upper; p += 1) {
                    if (!attempted.has(p)) { next = p; break; }
                }
                if (next !== null) {
                    dashboardLog(`Port ${port} is in use; trying ${next}...`);
                    tryListen(next);
                    return;
                }
            }

            dashboardLog(`Port ${port} is already in use; dashboard will not start. Set DASHBOARD_PORT or stop the other process.`);
        } else {
            console.error('[Dashboard] Server error:', error);
        }

        try { dashboardServer?.close?.(); } catch {}
        dashboardServer = null;
    });

    tryListen(port);
    return dashboardServer;
}

module.exports = { startDashboard };




