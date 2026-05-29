const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_JSON_DIR = path.join(PROJECT_ROOT, 'src', 'json');
const FALLBACK_STORAGE_ROOT = PROJECT_ROOT;

let resolvedStorageRoot = null;
let warnedStorageFallback = false;

function trim(value) {
    return String(value || '').trim();
}

function canUseStorageRoot(dirPath) {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
        const probe = path.join(dirPath, `.write-test-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (error) {
        if (!warnedStorageFallback) {
            warnedStorageFallback = true;
            console.warn(`[Storage] Cannot write to configured storage root "${dirPath}" (${error.code || error.message}). Falling back to bundled storage. Data may be ephemeral until the persistent disk is fixed.`);
        }
        return false;
    }
}

function getStorageRoot() {
    if (resolvedStorageRoot) return resolvedStorageRoot;
    const configured = trim(process.env.STORAGE_ROOT || process.env.RENDER_DISK_MOUNT_PATH || process.env.DATA_DIR);
    if (configured) {
        const candidate = path.resolve(configured);
        resolvedStorageRoot = canUseStorageRoot(candidate) ? candidate : FALLBACK_STORAGE_ROOT;
        return resolvedStorageRoot;
    }
    resolvedStorageRoot = FALLBACK_STORAGE_ROOT;
    return resolvedStorageRoot;
}

function isUsingExternalStorage() {
    return path.resolve(getStorageRoot()) !== PROJECT_ROOT;
}

function getRuntimeJsonDir() {
    return isUsingExternalStorage()
        ? path.join(getStorageRoot(), 'json')
        : BUNDLED_JSON_DIR;
}

function getRuntimeGuildConfigDir() {
    return path.join(getRuntimeJsonDir(), 'guilds');
}

function getTranscriptsDir() {
    return isUsingExternalStorage()
        ? path.join(getStorageRoot(), 'transcripts')
        : path.join(PROJECT_ROOT, 'transcripts');
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function ensureJsonFile(targetPath, sourcePath, fallbackValue) {
    if (fs.existsSync(targetPath)) return targetPath;

    ensureDir(path.dirname(targetPath));

    if (sourcePath && fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, targetPath);
        return targetPath;
    }

    fs.writeFileSync(targetPath, JSON.stringify(fallbackValue, null, 4));
    return targetPath;
}

module.exports = {
    PROJECT_ROOT,
    BUNDLED_JSON_DIR,
    getStorageRoot,
    getRuntimeJsonDir,
    getRuntimeGuildConfigDir,
    getTranscriptsDir,
    ensureDir,
    ensureJsonFile
};
