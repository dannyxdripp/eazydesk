const fs = require('fs');
const path = require('path');
const { BUNDLED_JSON_DIR, getRuntimeJsonDir, ensureJsonFile } = require('./storage-paths');

const JSON_DIR = getRuntimeJsonDir();
const ACTIVE_STORAGE_PATH = path.join(JSON_DIR, 'active-storage.json');
const TICKET_TYPES_PATH = path.join(JSON_DIR, 'ticket-types.json');
const SUPPORT_TEAMS_PATH = path.join(JSON_DIR, 'support-teams.json');
const TAGS_PATH = path.join(JSON_DIR, 'tags.json');
const guildConfigStore = require('./guild-config-store');

ensureJsonFile(ACTIVE_STORAGE_PATH, path.join(BUNDLED_JSON_DIR, 'active-storage.json'), {});
ensureJsonFile(TICKET_TYPES_PATH, path.join(BUNDLED_JSON_DIR, 'ticket-types.json'), { ticketTypes: [] });
ensureJsonFile(SUPPORT_TEAMS_PATH, path.join(BUNDLED_JSON_DIR, 'support-teams.json'), { teams: [] });
ensureJsonFile(TAGS_PATH, path.join(BUNDLED_JSON_DIR, 'tags.json'), { tags: [] });

const jsonCache = new Map();

function getTestGuildId() {
    return String(process.env.TEST_GUILD_ID || process.env.GUILD_ID || '').trim();
}

function isTestGuild(guildId) {
    const testId = getTestGuildId();
    const id = String(guildId || '').trim();
    return Boolean(testId && id && testId === id);
}

function stripTicketTypeForTemplate(type) {
    if (!type || typeof type !== 'object') return null;
    const next = { ...type };
    delete next.roleIds;
    delete next.categoryId;
    return next;
}

function stripSupportTeamForTemplate(team) {
    if (!team || typeof team !== 'object') return null;
    const next = { ...team };
    delete next.roleIds;
    delete next.roleId;
    return next;
}

function normalizeType(value) {
    return String(value || '').trim().toLowerCase();
}

function toTicketSelectValue(name) {
    return normalizeType(name).replace(/\s+/g, '-');
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 4));
}

function readJsonCached(filePath, fallback) {
    const key = path.resolve(filePath);
    try {
        const stat = fs.statSync(key);
        const cached = jsonCache.get(key);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
        const parsed = readJson(key, fallback);
        jsonCache.set(key, { mtimeMs: stat.mtimeMs, value: parsed });
        return parsed;
    } catch {
        const cached = jsonCache.get(key);
        if (cached) return cached.value;
        return fallback;
    }
}

function writeJsonCached(filePath, value) {
    const key = path.resolve(filePath);
    writeJson(key, value);
    try {
        const stat = fs.statSync(key);
        jsonCache.set(key, { mtimeMs: stat.mtimeMs, value });
    } catch {
        jsonCache.set(key, { mtimeMs: Date.now(), value });
    }
}

function getTicketTypes() {
    const data = readJsonCached(TICKET_TYPES_PATH, { ticketTypes: [] });
    return Array.isArray(data.ticketTypes) ? data.ticketTypes : [];
}

function saveTicketTypes(ticketTypes) {
    writeJsonCached(TICKET_TYPES_PATH, { ticketTypes: Array.isArray(ticketTypes) ? ticketTypes : [] });
}

function getSupportTeams() {
    const data = readJsonCached(SUPPORT_TEAMS_PATH, { teams: [] });
    return Array.isArray(data.teams) ? data.teams : [];
}

function saveSupportTeams(teams) {
    writeJsonCached(SUPPORT_TEAMS_PATH, { teams: Array.isArray(teams) ? teams : [] });
}

function getTags() {
    const data = readJsonCached(TAGS_PATH, { tags: [] });
    return Array.isArray(data.tags) ? data.tags : [];
}

function saveTags(tags) {
    writeJsonCached(TAGS_PATH, { tags });
}

function getTicketTypesForGuild(guildId, storage = null) {
    if (!guildId || isTestGuild(guildId)) return getTicketTypes();
    const cfg = getGuildConfig(guildId, storage);
    return Array.isArray(cfg.ticketTypes) ? cfg.ticketTypes : [];
}

function saveTicketTypesForGuild(guildId, ticketTypes, storage = null) {
    if (!guildId || isTestGuild(guildId)) return saveTicketTypes(ticketTypes);
    return setGuildConfig(guildId, { ticketTypes: Array.isArray(ticketTypes) ? ticketTypes : [] }, storage);
}

function getSupportTeamsForGuild(guildId, storage = null) {
    if (!guildId || isTestGuild(guildId)) return getSupportTeams();
    const cfg = getGuildConfig(guildId, storage);
    return Array.isArray(cfg.supportTeams) ? cfg.supportTeams : [];
}

function saveSupportTeamsForGuild(guildId, teams, storage = null) {
    if (!guildId || isTestGuild(guildId)) return saveSupportTeams(teams);
    return setGuildConfig(guildId, { supportTeams: Array.isArray(teams) ? teams : [] }, storage);
}

function getTagsForGuild(guildId, storage = null) {
    if (!guildId || isTestGuild(guildId)) return getTags();
    const cfg = getGuildConfig(guildId, storage);
    return Array.isArray(cfg.tags) ? cfg.tags : [];
}

function saveTagsForGuild(guildId, tags, storage = null) {
    if (!guildId || isTestGuild(guildId)) return saveTags(tags);
    return setGuildConfig(guildId, { tags: Array.isArray(tags) ? tags : [] }, storage);
}

function findTagByName(name, guildId = null, storage = null) {
    const normalized = normalizeType(name);
    return getTagsForGuild(guildId, storage).find(tag => normalizeType(tag.name) === normalized) || null;
}

function upsertTag(tag, guildId = null, storage = null) {
    const tags = getTagsForGuild(guildId, storage);
    const normalized = normalizeType(tag.name);
    const index = tags.findIndex(existing => normalizeType(existing.name) === normalized);
    if (index === -1) {
        tags.push(tag);
    } else {
        tags[index] = { ...tags[index], ...tag };
    }
    saveTagsForGuild(guildId, tags, storage);
    return findTagByName(tag.name, guildId, storage);
}

function deleteTagByName(name, guildId = null, storage = null) {
    const tags = getTagsForGuild(guildId, storage);
    const normalized = normalizeType(name);
    const nextTags = tags.filter(tag => normalizeType(tag.name) !== normalized);
    const removed = nextTags.length !== tags.length;
    if (removed) saveTagsForGuild(guildId, nextTags, storage);
    return removed;
}

function getActiveStorage() {
    const data = readJson(ACTIVE_STORAGE_PATH, {});
    if (!Array.isArray(data.tickets)) data.tickets = [];
    if (!Array.isArray(data.staffStatsEvents)) data.staffStatsEvents = [];
    if (!Array.isArray(data.closeRequestReasonEvents)) data.closeRequestReasonEvents = [];
    if (!Array.isArray(data.transcriptArchives)) data.transcriptArchives = [];
    if (!data.tagUsage || typeof data.tagUsage !== 'object') data.tagUsage = {};
    if (!data.availabilityOverrides || typeof data.availabilityOverrides !== 'object') {
        data.availabilityOverrides = {};
    }
    if (!data.closeRequests || typeof data.closeRequests !== 'object') {
        data.closeRequests = {};
    }
    if (!data.pendingUrgentReasons || typeof data.pendingUrgentReasons !== 'object') {
        data.pendingUrgentReasons = {};
    }
    if (!data.aiControl || typeof data.aiControl !== 'object') {
        data.aiControl = {
            manualDisabled: false,
            rateLimitedUntil: null
        };
    }
    if (!data.botConfig || typeof data.botConfig !== 'object') {
        data.botConfig = {};
    }
    if (!data.ticketNotes || typeof data.ticketNotes !== 'object') {
        data.ticketNotes = {};
    }
    // This bot is intended to be global/public: avoid letting per-guild configs bloat active-storage.json.
    // Legacy installations may still have botConfig.guilds; keep it for one process read, but do not persist it.
    if (data.botConfig.guilds && typeof data.botConfig.guilds === 'object') {
        // no-op here; `setGuildConfig` migration will delete per guild on write
    }
    return data;
}

function saveActiveStorage(storage) {
    writeJson(ACTIVE_STORAGE_PATH, storage);
}

function findTicketTypeBySelectValue(value, guildId = null, storage = null) {
    return getTicketTypesForGuild(guildId, storage).find(t => toTicketSelectValue(t.name) === value) || null;
}

function findTicketType(value, guildId = null, storage = null) {
    const normalized = normalizeType(value);
    return getTicketTypesForGuild(guildId, storage).find(type => {
        if (normalizeType(type.name) === normalized) return true;
        if (toTicketSelectValue(type.name) === normalized) return true;
        return Array.isArray(type.aliases) && type.aliases.some(alias => normalizeType(alias) === normalized);
    }) || null;
}

function findSupportTeamForTicketType(ticketTypeName, guildId = null, storage = null) {
    const normalized = normalizeType(ticketTypeName);
    return getSupportTeamsForGuild(guildId, storage).find(team => normalizeType(team.name) === normalized) || null;
}

function toRoleIdArray(input) {
    if (!input) return [];
    const list = Array.isArray(input) ? input : [input];
    const ids = list
        .map(value => String(value || '').trim())
        .filter(value => /^\d{17,20}$/.test(value));
    return [...new Set(ids)];
}

function getSupportTeamRoleIds(team) {
    if (!team || typeof team !== 'object') return [];
    const fromArray = toRoleIdArray(team.roleIds);
    if (fromArray.length) return fromArray;
    return toRoleIdArray(team.roleId);
}

function getTicketByChannelId(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    return activeStorage.tickets.find(t => t.channelId === channelId) || null;
}

function removeTicketByChannelId(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const nextTickets = activeStorage.tickets.filter(t => t.channelId !== channelId);
    const removed = nextTickets.length !== activeStorage.tickets.length;
    activeStorage.tickets = nextTickets;
    if (removed) saveActiveStorage(activeStorage);
    return removed;
}

function cleanupMissingTicketChannels(guild, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const filtered = activeStorage.tickets.filter(ticket => guild.channels.cache.has(ticket.channelId));
    if (filtered.length !== activeStorage.tickets.length) {
        activeStorage.tickets = filtered;
        saveActiveStorage(activeStorage);
    }
    return activeStorage;
}

function getActiveTicketCountForType(ticketTypeName, storage = null, guildId = null) {
    const activeStorage = storage || getActiveStorage();
    const normalized = normalizeType(ticketTypeName);
    const gid = guildId ? String(guildId) : null;
    return activeStorage.tickets.filter(t => {
        if (normalizeType(t.ticketType) !== normalized) return false;
        if (!gid) return true;
        return String(t.guildId || '') === gid;
    }).length;
}

function getCloseRequest(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    return activeStorage.closeRequests?.[channelId] || null;
}

function setCloseRequest(channelId, value, storage = null) {
    const activeStorage = storage || getActiveStorage();
    activeStorage.closeRequests[channelId] = value;
    saveActiveStorage(activeStorage);
    return activeStorage.closeRequests[channelId];
}

function removeCloseRequest(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const existed = Boolean(activeStorage.closeRequests?.[channelId]);
    if (activeStorage.closeRequests?.[channelId]) {
        delete activeStorage.closeRequests[channelId];
        saveActiveStorage(activeStorage);
    }
    return existed;
}

function setPendingUrgentReason(userId, value, storage = null) {
    const activeStorage = storage || getActiveStorage();
    activeStorage.pendingUrgentReasons[userId] = value;
    saveActiveStorage(activeStorage);
    return activeStorage.pendingUrgentReasons[userId];
}

function popPendingUrgentReason(userId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const value = activeStorage.pendingUrgentReasons?.[userId] || null;
    if (value) {
        delete activeStorage.pendingUrgentReasons[userId];
        saveActiveStorage(activeStorage);
    }
    return value;
}

function getAiControl(storage = null) {
    const activeStorage = storage || getActiveStorage();
    return activeStorage.aiControl || { manualDisabled: false, rateLimitedUntil: null };
}

function setAiControl(nextControl, storage = null) {
    const activeStorage = storage || getActiveStorage();
    activeStorage.aiControl = {
        manualDisabled: Boolean(nextControl.manualDisabled),
        rateLimitedUntil: nextControl.rateLimitedUntil || null
    };
    saveActiveStorage(activeStorage);
    return activeStorage.aiControl;
}

function recordStaffStatsEvent(type, userId, channelId = null, createdBy = null, createdAt = null, storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.staffStatsEvents)) activeStorage.staffStatsEvents = [];

    // Best-effort: infer ticket creator from the currently active ticket list when not provided.
    let inferredCreatedBy = createdBy ? String(createdBy) : null;
    let inferredGuildId = null;
    if (!inferredCreatedBy && channelId && Array.isArray(activeStorage.tickets)) {
        const ticket = activeStorage.tickets.find(t => t && String(t.channelId) === String(channelId));
        if (ticket?.createdBy) inferredCreatedBy = String(ticket.createdBy);
        if (ticket?.guildId) inferredGuildId = String(ticket.guildId);
    }

    activeStorage.staffStatsEvents.push({
        type,
        userId: String(userId),
        guildId: inferredGuildId,
        createdBy: inferredCreatedBy,
        channelId: channelId ? String(channelId) : null,
        createdAt: createdAt || new Date().toISOString()
    });

    saveActiveStorage(activeStorage);
    return activeStorage.staffStatsEvents[activeStorage.staffStatsEvents.length - 1];
}

function getStaffStatsForUserLastDays(userId, days = 30, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const events = Array.isArray(activeStorage.staffStatsEvents) ? activeStorage.staffStatsEvents : [];
    const now = Date.now();
    const windowMs = Number(days) * 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;
    const normalizedUserId = String(userId);

    let claimed = 0;
    let closed = 0;

    for (const event of events) {
        if (!event || String(event.userId) !== normalizedUserId) continue;
        // Exclude self-opened tickets (support members opening their own tickets).
        if (event.createdBy && String(event.createdBy) === normalizedUserId) continue;
        const timestamp = Date.parse(event.createdAt || '');
        if (Number.isNaN(timestamp) || timestamp < cutoff) continue;

        if (event.type === 'claimed') claimed += 1;
        if (event.type === 'closed') closed += 1;
    }

    return { claimed, closed };
}

function normalizeReason(reason) {
    return String(reason || '').trim().replace(/\s+/g, ' ');
}

function recordCloseRequestReason(reason, userId, createdAt = null, storage = null) {
    const normalizedReason = normalizeReason(reason);
    if (!normalizedReason) return null;

    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.closeRequestReasonEvents)) {
        activeStorage.closeRequestReasonEvents = [];
    }

    activeStorage.closeRequestReasonEvents.push({
        reason: normalizedReason,
        userId: String(userId),
        guildId: null,
        createdAt: createdAt || new Date().toISOString()
    });

    saveActiveStorage(activeStorage);
    return activeStorage.closeRequestReasonEvents[activeStorage.closeRequestReasonEvents.length - 1];
}

function recordCloseRequestReasonForGuild(reason, userId, guildId, createdAt = null, storage = null) {
    const normalizedReason = normalizeReason(reason);
    if (!normalizedReason) return null;

    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.closeRequestReasonEvents)) {
        activeStorage.closeRequestReasonEvents = [];
    }

    const gid = String(guildId || '').trim();
    activeStorage.closeRequestReasonEvents.push({
        reason: normalizedReason,
        userId: String(userId),
        guildId: /^\d{17,20}$/.test(gid) ? gid : null,
        createdAt: createdAt || new Date().toISOString()
    });

    saveActiveStorage(activeStorage);
    return activeStorage.closeRequestReasonEvents[activeStorage.closeRequestReasonEvents.length - 1];
}

function getTopCloseRequestReasons(days = 30, userId = null, limit = 3, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const events = Array.isArray(activeStorage.closeRequestReasonEvents) ? activeStorage.closeRequestReasonEvents : [];
    const now = Date.now();
    const cutoff = now - (Number(days) * 24 * 60 * 60 * 1000);
    const requestedUserId = userId ? String(userId) : null;
    const counts = new Map();

    for (const event of events) {
        if (!event || !event.reason) continue;
        const timestamp = Date.parse(event.createdAt || '');
        if (Number.isNaN(timestamp) || timestamp < cutoff) continue;
        if (requestedUserId && String(event.userId) !== requestedUserId) continue;

        counts.set(event.reason, (counts.get(event.reason) || 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(limit))
        .map(([reason, count]) => ({ reason, count }));
}

function getTopCloseRequestReasonsForGuild(days = 30, guildId = null, userId = null, limit = 3, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const events = Array.isArray(activeStorage.closeRequestReasonEvents) ? activeStorage.closeRequestReasonEvents : [];
    const now = Date.now();
    const cutoff = now - (Number(days) * 24 * 60 * 60 * 1000);
    const requestedUserId = userId ? String(userId) : null;
    const requestedGuildId = guildId ? String(guildId) : null;
    const counts = new Map();

    for (const event of events) {
        if (!event || !event.reason) continue;
        const timestamp = Date.parse(event.createdAt || '');
        if (Number.isNaN(timestamp) || timestamp < cutoff) continue;
        if (requestedUserId && String(event.userId) !== requestedUserId) continue;
        if (requestedGuildId && String(event.guildId || '') !== requestedGuildId) continue;

        counts.set(event.reason, (counts.get(event.reason) || 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(limit))
        .map(([reason, count]) => ({ reason, count }));
}

function recordTagUsage(tagName, storage = null) {
    return recordTagUsageForGuild(tagName, null, storage);
}

function recordTagUsageForGuild(tagName, guildId = null, storage = null) {
    const normalized = normalizeType(tagName);
    if (!normalized) return 0;

    const gid = String(guildId || '').trim();
    const activeStorage = storage || getActiveStorage();

    if (!gid || isTestGuild(gid)) {
        if (!activeStorage.tagUsage || typeof activeStorage.tagUsage !== 'object') activeStorage.tagUsage = {};
        activeStorage.tagUsage[normalized] = Number(activeStorage.tagUsage[normalized] || 0) + 1;
        saveActiveStorage(activeStorage);
        return activeStorage.tagUsage[normalized];
    }

    const cfg = getGuildConfig(gid, activeStorage);
    const existing = cfg?.tagUsage && typeof cfg.tagUsage === 'object' ? cfg.tagUsage : {};
    const next = { ...existing };
    next[normalized] = Number(next[normalized] || 0) + 1;
    setGuildConfig(gid, { tagUsage: next }, activeStorage);
    return next[normalized];
}

function getTagUsageCount(tagName, storage = null) {
    return getTagUsageCountForGuild(tagName, null, storage);
}

function getTagUsageCountForGuild(tagName, guildId = null, storage = null) {
    const normalized = normalizeType(tagName);
    if (!normalized) return 0;

    const gid = String(guildId || '').trim();
    const activeStorage = storage || getActiveStorage();

    if (!gid || isTestGuild(gid)) {
        if (!activeStorage.tagUsage || typeof activeStorage.tagUsage !== 'object') return 0;
        return Number(activeStorage.tagUsage[normalized] || 0);
    }

    const cfg = getGuildConfig(gid, activeStorage);
    const usage = cfg?.tagUsage && typeof cfg.tagUsage === 'object' ? cfg.tagUsage : null;
    if (!usage) return 0;
    return Number(usage[normalized] || 0);
}

function getTagUsageForGuild(guildId = null, storage = null) {
    const gid = String(guildId || '').trim();
    const activeStorage = storage || getActiveStorage();

    if (!gid || isTestGuild(gid)) {
        if (!activeStorage.tagUsage || typeof activeStorage.tagUsage !== 'object') activeStorage.tagUsage = {};
        return { ...(activeStorage.tagUsage || {}) };
    }

    const cfg = getGuildConfig(gid, activeStorage);
    const usage = cfg?.tagUsage && typeof cfg.tagUsage === 'object' ? cfg.tagUsage : {};
    return { ...usage };
}

function upsertTicketType(nextType, guildId = null, storage = null) {
    const list = getTicketTypesForGuild(guildId, storage);
    const normalized = normalizeType(nextType.name);
    const index = list.findIndex(item => normalizeType(item.name) === normalized);
    if (index === -1) {
        list.push(nextType);
    } else {
        list[index] = { ...list[index], ...nextType };
    }
    saveTicketTypesForGuild(guildId, list, storage);
    return getTicketTypesForGuild(guildId, storage).find(item => normalizeType(item.name) === normalized) || null;
}

function deleteTicketTypeByName(name, guildId = null, storage = null) {
    const normalized = normalizeType(name);
    if (!normalized) return false;
    const list = getTicketTypesForGuild(guildId, storage);
    const next = list.filter(item => normalizeType(item.name) !== normalized);
    const removed = next.length !== list.length;
    if (removed) saveTicketTypesForGuild(guildId, next, storage);
    return removed;
}

function upsertSupportTeam(team, guildId = null, storage = null) {
    const teams = getSupportTeamsForGuild(guildId, storage);
    const normalized = normalizeType(team.name);
    const index = teams.findIndex(item => normalizeType(item.name) === normalized);
    const nextTeam = {
        ...team,
        roleIds: getSupportTeamRoleIds(team)
    };
    if (!nextTeam.roleIds.length && team.roleId) {
        nextTeam.roleIds = toRoleIdArray(team.roleId);
    }
    if (!nextTeam.roleIds.length) {
        delete nextTeam.roleIds;
    }

    if (index === -1) {
        teams.push(nextTeam);
    } else {
        const merged = { ...teams[index], ...nextTeam };
        const mergedRoleIds = getSupportTeamRoleIds(merged);
        if (mergedRoleIds.length) {
            merged.roleIds = mergedRoleIds;
            merged.roleId = mergedRoleIds[0];
        }
        teams[index] = merged;
    }
    saveSupportTeamsForGuild(guildId, teams, storage);
    return getSupportTeamsForGuild(guildId, storage).find(item => normalizeType(item.name) === normalized) || null;
}

function deleteSupportTeamByName(name, guildId = null, storage = null) {
    const normalized = normalizeType(name);
    if (!normalized) return false;
    const teams = getSupportTeamsForGuild(guildId, storage);
    const next = teams.filter(item => normalizeType(item.name) !== normalized);
    const removed = next.length !== teams.length;
    if (removed) saveSupportTeamsForGuild(guildId, next, storage);
    return removed;
}

function getBotConfig(storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!activeStorage.botConfig || typeof activeStorage.botConfig !== 'object') {
        activeStorage.botConfig = {};
    }
    return activeStorage.botConfig;
}

function setBotConfig(nextConfig, storage = null) {
    const activeStorage = storage || getActiveStorage();
    activeStorage.botConfig = {
        ...(activeStorage.botConfig || {}),
        ...(nextConfig || {})
    };
    saveActiveStorage(activeStorage);
    return activeStorage.botConfig;
}

function getGuildConfig(guildId, storage = null) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return {};

    const fileConfig = guildConfigStore.getGuildConfig(id);
    if (fileConfig && typeof fileConfig === 'object' && Object.keys(fileConfig).length) return fileConfig;

    // Back-compat: migrate from legacy in-storage config if present.
    const legacy = (() => {
        try {
            const botConfig = getBotConfig(storage);
            const guilds = botConfig?.guilds && typeof botConfig.guilds === 'object' ? botConfig.guilds : {};
            const value = guilds?.[id];
            return value && typeof value === 'object' ? value : null;
        } catch {
            return null;
        }
    })();

    if (legacy) {
        const migrated = guildConfigStore.setGuildConfig(id, legacy);
        return migrated || legacy;
    }

    return {};
}

function setGuildConfig(guildId, patch, storage = null) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return null;
    const next = guildConfigStore.setGuildConfig(id, patch || {});

    // If this guild used to live in active-storage botConfig.guilds, remove it to avoid growth.
    try {
        const activeStorage = storage || getActiveStorage();
        const botConfig = getBotConfig(activeStorage);
        if (botConfig?.guilds && typeof botConfig.guilds === 'object' && botConfig.guilds[id]) {
            delete botConfig.guilds[id];
            activeStorage.botConfig = botConfig;
            saveActiveStorage(activeStorage);
        }
    } catch {}

    return next;
}

function bootstrapGuildConfig(guildId, options = {}) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return null;

    const existing = getGuildConfig(id, options.storage || null);
    if (existing && typeof existing === 'object' && Object.keys(existing).length) return existing;

    const useTemplate = isTestGuild(id);
    const templateTicketTypes = useTemplate
        ? getTicketTypes().map(stripTicketTypeForTemplate).filter(Boolean)
        : [];
    const templateSupportTeams = useTemplate
        ? getSupportTeams().map(stripSupportTeamForTemplate).filter(Boolean)
        : [];
    const templateTags = useTemplate ? getTags() : [];

    const now = new Date().toISOString();
    return setGuildConfig(id, {
        setup: {
            completed: false,
            createdAt: now,
            source: useTemplate ? 'template' : 'blank'
        },
        ticketTypes: templateTicketTypes,
        supportTeams: templateSupportTeams,
        tags: templateTags,
        panels: {},
        channelTicketTypeRestrictions: {}
    }, options.storage || null);
}

function getTranscriptArchives(storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.transcriptArchives)) activeStorage.transcriptArchives = [];
    return activeStorage.transcriptArchives;
}

function getTicketNotes(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!activeStorage.ticketNotes || typeof activeStorage.ticketNotes !== 'object') {
        activeStorage.ticketNotes = {};
    }
    const id = String(channelId || '').trim();
    const notes = activeStorage.ticketNotes[id];
    return Array.isArray(notes) ? notes : [];
}

function addTicketNote(channelId, note, storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!activeStorage.ticketNotes || typeof activeStorage.ticketNotes !== 'object') {
        activeStorage.ticketNotes = {};
    }
    const id = String(channelId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return null;
    const existing = Array.isArray(activeStorage.ticketNotes[id]) ? activeStorage.ticketNotes[id] : [];
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        body: String(note?.body || '').trim().slice(0, 4000),
        authorId: note?.authorId ? String(note.authorId) : null,
        createdAt: note?.createdAt || new Date().toISOString()
    };
    if (!entry.body) return null;
    activeStorage.ticketNotes[id] = [...existing, entry].slice(-100);
    saveActiveStorage(activeStorage);
    return entry;
}

function deleteTicketNotes(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    const id = String(channelId || '').trim();
    if (!activeStorage.ticketNotes || typeof activeStorage.ticketNotes !== 'object') {
        activeStorage.ticketNotes = {};
    }
    if (!activeStorage.ticketNotes[id]) return false;
    delete activeStorage.ticketNotes[id];
    saveActiveStorage(activeStorage);
    return true;
}

function upsertTranscriptArchive(entry, storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.transcriptArchives)) activeStorage.transcriptArchives = [];
    const channelId = String(entry?.channelId || '').trim();
    if (!/^\d{17,20}$/.test(channelId)) return null;

    const archives = activeStorage.transcriptArchives;
    const index = archives.findIndex(item => item && String(item.channelId) === channelId);
    const nextEntry = { ...(index >= 0 ? archives[index] : {}), ...(entry || {}), channelId };

    if (index >= 0) archives[index] = nextEntry;
    else archives.push(nextEntry);

    activeStorage.transcriptArchives = archives;
    saveActiveStorage(activeStorage);
    return nextEntry;
}

function deleteTranscriptArchive(channelId, storage = null) {
    const activeStorage = storage || getActiveStorage();
    if (!Array.isArray(activeStorage.transcriptArchives)) activeStorage.transcriptArchives = [];
    const id = String(channelId || '').trim();
    const next = activeStorage.transcriptArchives.filter(item => String(item?.channelId || '') !== id);
    const removed = next.length !== activeStorage.transcriptArchives.length;
    if (removed) {
        activeStorage.transcriptArchives = next;
        saveActiveStorage(activeStorage);
    }
    return removed;
}

function getChannelTicketTypeRestrictions(storage = null) {
    const config = getBotConfig(storage);
    if (!config.channelTicketTypeRestrictions || typeof config.channelTicketTypeRestrictions !== 'object') {
        config.channelTicketTypeRestrictions = {};
    }
    return config.channelTicketTypeRestrictions;
}

function getChannelTicketTypeRestrictionsForGuild(guildId, storage = null) {
    if (!guildId || isTestGuild(guildId)) return getChannelTicketTypeRestrictions(storage);
    const cfg = getGuildConfig(guildId, storage);
    if (!cfg.channelTicketTypeRestrictions || typeof cfg.channelTicketTypeRestrictions !== 'object') {
        cfg.channelTicketTypeRestrictions = {};
        setGuildConfig(guildId, { channelTicketTypeRestrictions: cfg.channelTicketTypeRestrictions }, storage);
    }
    return cfg.channelTicketTypeRestrictions;
}

function resolveTicketTypeSelectValue(input, guildId = null, storage = null) {
    const normalized = normalizeType(input);
    if (!normalized) return null;
    const byName = findTicketType(input, guildId, storage);
    if (byName) return toTicketSelectValue(byName.name);
    const bySelect = findTicketTypeBySelectValue(normalized, guildId, storage);
    if (bySelect) return toTicketSelectValue(bySelect.name);
    return null;
}

function getRestrictedTicketTypeForChannel(channelId, storage = null, guildId = null) {
    const id = String(channelId || '').trim();
    if (!id) return null;
    const map = getChannelTicketTypeRestrictionsForGuild(guildId, storage);
    const value = map[id];
    return value ? String(value) : null;
}

function setRestrictedTicketTypeForChannel(channelId, ticketTypeInput, storage = null, guildId = null) {
    const id = String(channelId || '').trim();
    if (!id) return null;
    const activeStorage = storage || getActiveStorage();
    const map = getChannelTicketTypeRestrictionsForGuild(guildId, activeStorage);

    if (!ticketTypeInput) {
        delete map[id];
        if (!guildId || isTestGuild(guildId)) {
            const config = getBotConfig(activeStorage);
            config.channelTicketTypeRestrictions = map;
            saveActiveStorage(activeStorage);
        } else {
            setGuildConfig(guildId, { channelTicketTypeRestrictions: map }, activeStorage);
        }
        return null;
    }

    const selectValue = resolveTicketTypeSelectValue(ticketTypeInput, guildId, activeStorage);
    if (!selectValue) return null;

    map[id] = selectValue;
    if (!guildId || isTestGuild(guildId)) {
        const config = getBotConfig(activeStorage);
        config.channelTicketTypeRestrictions = map;
        saveActiveStorage(activeStorage);
    } else {
        setGuildConfig(guildId, { channelTicketTypeRestrictions: map }, activeStorage);
    }
    return selectValue;
}

module.exports = {
    getTestGuildId,
    isTestGuild,
    normalizeType,
    toTicketSelectValue,
    getTags,
    saveTags,
    getTagsForGuild,
    saveTagsForGuild,
    findTagByName,
    upsertTag,
    deleteTagByName,
    getTicketTypes,
    saveTicketTypes,
    getTicketTypesForGuild,
    saveTicketTypesForGuild,
    deleteTicketTypeByName,
    getSupportTeams,
    saveSupportTeams,
    getSupportTeamsForGuild,
    saveSupportTeamsForGuild,
    deleteSupportTeamByName,
    getActiveStorage,
    saveActiveStorage,
    getTranscriptArchives,
    upsertTranscriptArchive,
    deleteTranscriptArchive,
    getTicketNotes,
    addTicketNote,
    deleteTicketNotes,
    findTicketTypeBySelectValue,
    findTicketType,
    findSupportTeamForTicketType,
    getSupportTeamRoleIds,
    getTicketByChannelId,
    removeTicketByChannelId,
    cleanupMissingTicketChannels,
    getActiveTicketCountForType,
    getCloseRequest,
    setCloseRequest,
    removeCloseRequest,
    setPendingUrgentReason,
    popPendingUrgentReason,
    getAiControl,
    setAiControl,
    recordStaffStatsEvent,
    getStaffStatsForUserLastDays,
    recordCloseRequestReason,
    recordCloseRequestReasonForGuild,
    getTopCloseRequestReasons,
    getTopCloseRequestReasonsForGuild,
    recordTagUsage,
    recordTagUsageForGuild,
    getTagUsageCount,
    getTagUsageCountForGuild,
    getTagUsageForGuild,
    getBotConfig,
    setBotConfig,
    getGuildConfig,
    setGuildConfig,
    bootstrapGuildConfig,
    getChannelTicketTypeRestrictions,
    getChannelTicketTypeRestrictionsForGuild,
    resolveTicketTypeSelectValue,
    getRestrictedTicketTypeForChannel,
    setRestrictedTicketTypeForChannel,
    upsertTicketType,
    upsertSupportTeam
};
