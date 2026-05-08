const fs = require('fs');
const path = require('path');
const { BUNDLED_JSON_DIR, getRuntimeGuildConfigDir } = require('./storage-paths');

const BASE_DIR = getRuntimeGuildConfigDir();
const BUNDLED_BASE_DIR = path.join(BUNDLED_JSON_DIR, 'guilds');
const CACHE_MAX = Math.max(10, Number(process.env.GUILD_CONFIG_CACHE_MAX || 75));

const cache = new Map();

function ensureDir() {
    fs.mkdirSync(BASE_DIR, { recursive: true });
}

function isValidGuildId(value) {
    return /^\d{17,20}$/.test(String(value || '').trim());
}

function resolvePath(guildId) {
    const id = String(guildId || '').trim();
    if (!isValidGuildId(id)) return null;
    return path.join(BASE_DIR, `${id}.json`);
}

function resolveBundledPath(guildId) {
    const id = String(guildId || '').trim();
    if (!isValidGuildId(id)) return null;
    return path.join(BUNDLED_BASE_DIR, `${id}.json`);
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(filePath, value) {
    ensureDir();
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 4));
    fs.renameSync(tmp, filePath);
}

function touchCache(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function getGuildConfig(guildId) {
    const filePath = resolvePath(guildId);
    if (!filePath) return {};

    const bundledPath = resolveBundledPath(guildId);
    if (!fs.existsSync(filePath) && bundledPath && fs.existsSync(bundledPath)) {
        ensureDir();
        fs.copyFileSync(bundledPath, filePath);
    }

    try {
        const stat = fs.statSync(filePath);
        const cached = cache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            touchCache(filePath, cached);
            return cached.value;
        }
        const value = readJson(filePath, {});
        const entry = { mtimeMs: stat.mtimeMs, value: value && typeof value === 'object' ? value : {} };
        touchCache(filePath, entry);
        return entry.value;
    } catch {
        const cached = cache.get(filePath);
        if (cached) return cached.value;
        return {};
    }
}

function setGuildConfig(guildId, patch) {
    const filePath = resolvePath(guildId);
    if (!filePath) return null;

    const existing = getGuildConfig(guildId);
    const next = { ...existing, ...(patch && typeof patch === 'object' ? patch : {}) };
    if (patch && typeof patch === 'object' && patch.setup && typeof patch.setup === 'object') {
        next.setup = { ...(existing.setup || {}), ...(patch.setup || {}) };
    }

    writeJsonAtomic(filePath, next);
    try {
        const stat = fs.statSync(filePath);
        touchCache(filePath, { mtimeMs: stat.mtimeMs, value: next });
    } catch {
        touchCache(filePath, { mtimeMs: Date.now(), value: next });
    }

    return next;
}

function deleteGuildConfig(guildId) {
    const filePath = resolvePath(guildId);
    if (!filePath) return false;
    cache.delete(filePath);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
    } catch {}
    return false;
}

module.exports = {
    BASE_DIR,
    getGuildConfig,
    setGuildConfig,
    deleteGuildConfig
};
