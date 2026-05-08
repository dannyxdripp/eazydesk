const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_JSON_DIR = path.join(PROJECT_ROOT, 'src', 'json');

function trim(value) {
    return String(value || '').trim();
}

function getStorageRoot() {
    const configured = trim(process.env.STORAGE_ROOT || process.env.RENDER_DISK_MOUNT_PATH || process.env.DATA_DIR);
    return configured ? path.resolve(configured) : PROJECT_ROOT;
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
