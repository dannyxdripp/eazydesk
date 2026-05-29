const fs = require('fs');
const path = require('path');
const { getRuntimeJsonDir, getRuntimeGuildConfigDir } = require('./storage-paths');

let cachedMega = null;
let warnedMissingPackage = false;
let queue = Promise.resolve();
let lastSuccessfulBackup = null;
let lastBackupError = null;

function isEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.MEGA_BACKUP_ENABLED || '').trim().toLowerCase());
}

function getConfig() {
    return {
        email: String(process.env.MEGA_EMAIL || '').trim(),
        password: String(process.env.MEGA_PASSWORD || '').trim(),
        folder: String(process.env.MEGA_BACKUP_FOLDER || 'tickets-bot-backups').trim() || 'tickets-bot-backups'
    };
}

function canUseMega() {
    const cfg = getConfig();
    return isEnabled() && cfg.email && cfg.password;
}

function loadMega() {
    if (cachedMega) return cachedMega;
    try {
        cachedMega = require('megajs');
        return cachedMega;
    } catch (error) {
        if (!warnedMissingPackage && isEnabled()) {
            warnedMissingPackage = true;
            console.warn('[MEGA Backup] Install the optional "megajs" package to enable MEGA backups.');
        }
        return null;
    }
}

function backupNameFor(filePath) {
    const resolved = path.resolve(filePath);
    const jsonRoot = path.resolve(getRuntimeJsonDir());
    const guildRoot = path.resolve(getRuntimeGuildConfigDir());
    let relative = path.basename(resolved);
    if (resolved.startsWith(guildRoot + path.sep)) {
        relative = path.join('guilds', path.relative(guildRoot, resolved));
    } else if (resolved.startsWith(jsonRoot + path.sep)) {
        relative = path.relative(jsonRoot, resolved);
    }
    return relative.replace(/[\\/]+/g, '__');
}

function listJsonFiles(dirPath) {
    const files = [];
    try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                files.push(...listJsonFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                files.push(fullPath);
            }
        }
    } catch {}
    return files;
}

function waitForReady(storage) {
    if (!storage) return Promise.resolve(storage);
    if (storage.ready && typeof storage.ready.then === 'function') return storage.ready.then(() => storage);
    return Promise.resolve(storage);
}

async function getStorage() {
    const mega = loadMega();
    if (!mega) return null;
    const cfg = getConfig();
    const Storage = mega.Storage || mega.default?.Storage;
    if (!Storage) throw new Error('megajs Storage export was not found');
    const storage = new Storage({ email: cfg.email, password: cfg.password });
    return waitForReady(storage);
}

function getChildren(node) {
    if (!node) return [];
    if (Array.isArray(node.children)) return node.children;
    if (node.children && typeof node.children === 'object') return Object.values(node.children);
    return [];
}

function parseBackupFileName(name) {
    const match = String(name || '').match(/^(.+?)(?:\.([a-z0-9_-]+))?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/i);
    if (!match) return null;
    return {
        targetKey: match[1],
        reason: match[2] || '',
        timestamp: match[3]
    };
}

function targetPathForBackupKey(targetKey) {
    const key = String(targetKey || '').trim();
    if (!key || key.includes('..')) return null;
    const parts = key.split('__').filter(Boolean);
    if (!parts.length || !parts[parts.length - 1].endsWith('.json')) return null;
    return path.join(getRuntimeJsonDir(), ...parts);
}

async function getBackupFolder(storage) {
    const cfg = getConfig();
    const root = storage.root || storage;
    const existing = getChildren(root).find(child => child && child.name === cfg.folder);
    if (existing) return existing;
    if (typeof root.mkdir === 'function') return root.mkdir(cfg.folder);
    if (typeof storage.mkdir === 'function') return storage.mkdir(cfg.folder);
    return root;
}

async function uploadToNode(node, name, buffer) {
    if (!node || typeof node.upload !== 'function') throw new Error('MEGA upload target is unavailable');
    const upload = node.upload({ name }, buffer);
    if (upload && upload.complete && typeof upload.complete.then === 'function') return upload.complete;
    if (upload && typeof upload.then === 'function') return upload;
    return upload;
}

async function downloadNodeBuffer(node) {
    if (!node || typeof node.downloadBuffer !== 'function') throw new Error('MEGA download target is unavailable');
    return node.downloadBuffer({});
}

async function uploadJsonBackup(filePath, value) {
    if (!canUseMega()) return false;
    const storage = await getStorage();
    if (!storage) return false;
    try {
        const folder = await getBackupFolder(storage);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `${backupNameFor(filePath)}.${stamp}.json`;
        const buffer = Buffer.from(JSON.stringify(value, null, 4), 'utf8');
        await uploadToNode(folder, name, buffer);
        lastSuccessfulBackup = {
            at: new Date().toISOString(),
            filePath,
            name,
            bytes: buffer.length
        };
        lastBackupError = null;
        return true;
    } finally {
        if (storage && typeof storage.close === 'function') {
            storage.close().catch(() => {});
        }
    }
}

async function uploadFileBackup(storage, folder, filePath, reason = 'snapshot') {
    const buffer = await fs.promises.readFile(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason || 'snapshot').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'snapshot';
    const name = `${backupNameFor(filePath)}.${safeReason}.${stamp}.json`;
    await uploadToNode(folder, name, buffer);
    return { filePath, name, bytes: buffer.length };
}

async function backupAllJsonNow(reason = 'snapshot') {
    if (!canUseMega()) return { ok: false, skipped: true, reason: 'MEGA backup is not configured' };
    const storage = await getStorage();
    if (!storage) return { ok: false, skipped: true, reason: 'MEGA SDK unavailable' };
    const files = listJsonFiles(getRuntimeJsonDir());
    const startedAt = new Date().toISOString();
    const result = { ok: true, reason, startedAt, completedAt: null, files: 0, bytes: 0, uploaded: [] };
    try {
        const folder = await getBackupFolder(storage);
        for (const filePath of files) {
            const uploaded = await uploadFileBackup(storage, folder, filePath, reason);
            result.files += 1;
            result.bytes += uploaded.bytes;
            result.uploaded.push(uploaded);
        }
        result.completedAt = new Date().toISOString();
        lastSuccessfulBackup = {
            at: result.completedAt,
            reason,
            files: result.files,
            bytes: result.bytes
        };
        lastBackupError = null;
        return result;
    } catch (error) {
        lastBackupError = { at: new Date().toISOString(), message: error?.message || String(error) };
        throw error;
    } finally {
        if (storage && typeof storage.close === 'function') {
            storage.close().catch(() => {});
        }
    }
}

async function restoreLatestJsonBackups() {
    if (!canUseMega()) return { ok: false, skipped: true, reason: 'MEGA backup is not configured', restored: 0, bytes: 0 };
    const storage = await getStorage();
    if (!storage) return { ok: false, skipped: true, reason: 'MEGA SDK unavailable', restored: 0, bytes: 0 };
    const result = { ok: true, restored: 0, bytes: 0, files: [] };
    try {
        const folder = await getBackupFolder(storage);
        const latest = new Map();
        for (const child of getChildren(folder)) {
            const parsed = parseBackupFileName(child?.name);
            if (!parsed) continue;
            const targetPath = targetPathForBackupKey(parsed.targetKey);
            if (!targetPath) continue;
            const current = latest.get(parsed.targetKey);
            if (!current || parsed.timestamp > current.parsed.timestamp) {
                latest.set(parsed.targetKey, { child, parsed, targetPath });
            }
        }
        for (const item of latest.values()) {
            const buffer = await downloadNodeBuffer(item.child);
            fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
            fs.writeFileSync(item.targetPath, buffer);
            result.restored += 1;
            result.bytes += buffer.length;
            result.files.push({ path: item.targetPath, name: item.child.name, bytes: buffer.length });
        }
        return result;
    } catch (error) {
        lastBackupError = { at: new Date().toISOString(), message: error?.message || String(error) };
        throw error;
    } finally {
        if (storage && typeof storage.close === 'function') {
            storage.close().catch(() => {});
        }
    }
}

function enqueueJsonBackup(filePath, value) {
    if (!canUseMega()) return;
    queue = queue
        .then(() => uploadJsonBackup(filePath, value))
        .catch(error => {
            lastBackupError = { at: new Date().toISOString(), message: error?.message || String(error) };
            console.warn('[MEGA Backup] Upload failed:', error?.message || error);
        });
}

function enqueueFullBackup(reason = 'snapshot') {
    if (!canUseMega()) return;
    queue = queue
        .then(() => backupAllJsonNow(reason))
        .catch(error => {
            lastBackupError = { at: new Date().toISOString(), message: error?.message || String(error) };
            console.warn('[MEGA Backup] Full snapshot failed:', error?.message || error);
        });
}

function getBackupStatus() {
    return {
        enabled: isEnabled(),
        configured: canUseMega(),
        lastSuccessfulBackup,
        lastBackupError
    };
}

module.exports = {
    canUseMega,
    enqueueJsonBackup,
    enqueueFullBackup,
    uploadJsonBackup,
    backupAllJsonNow,
    restoreLatestJsonBackups,
    getBackupStatus,
    listJsonFiles
};
