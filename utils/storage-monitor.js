const fs = require('fs');
const path = require('path');
const { getRuntimeJsonDir, ensureDir } = require('./storage-paths');
const megaBackup = require('./mega-backup');

const STATE_PATH = path.join(getRuntimeJsonDir(), 'monitoring-state.json');
const startedAt = new Date();

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 4), 'utf8');
    fs.renameSync(tmp, filePath);
}

function getState() {
    const state = readJson(STATE_PATH, {});
    return state && typeof state === 'object' ? state : {};
}

function setState(patch) {
    const next = { ...getState(), ...(patch && typeof patch === 'object' ? patch : {}) };
    writeJsonAtomic(STATE_PATH, next);
    megaBackup.enqueueJsonBackup(STATE_PATH, next);
    return next;
}

function formatDuration(ms) {
    const safe = Math.max(0, Number(ms) || 0);
    const seconds = Math.floor(safe / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h ${minutes}m`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m`;
    return `${seconds}s`;
}

function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
    return `${value} B`;
}

function collectJsonStats() {
    const files = megaBackup.listJsonFiles(getRuntimeJsonDir());
    const stats = {
        files: files.length,
        bytes: 0,
        newestMtimeMs: 0,
        oldestMtimeMs: 0,
        filesModifiedSinceBackup: 0,
        bytesModifiedSinceBackup: 0
    };
    const backup = megaBackup.getBackupStatus().lastSuccessfulBackup;
    const lastBackupMs = Date.parse(backup?.at || '');
    for (const filePath of files) {
        try {
            const stat = fs.statSync(filePath);
            stats.bytes += stat.size;
            stats.newestMtimeMs = Math.max(stats.newestMtimeMs, stat.mtimeMs);
            stats.oldestMtimeMs = stats.oldestMtimeMs ? Math.min(stats.oldestMtimeMs, stat.mtimeMs) : stat.mtimeMs;
            if (!lastBackupMs || stat.mtimeMs > lastBackupMs) {
                stats.filesModifiedSinceBackup += 1;
                stats.bytesModifiedSinceBackup += stat.size;
            }
        } catch {}
    }
    return stats;
}

function getWebhookUrl() {
    return String(
        process.env.MONITORING_WEBHOOK_URL ||
        process.env.DATA_LOSS_WEBHOOK_URL ||
        process.env.BOT_MONITORING_WEBHOOK_URL ||
        ''
    ).trim();
}

async function sendWebhook(payload) {
    const webhookUrl = getWebhookUrl();
    if (!webhookUrl || typeof fetch !== 'function') return false;
    const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return res.ok;
}

function buildShutdownPayload(reason, error = null) {
    const state = getState();
    const backup = megaBackup.getBackupStatus();
    const stats = collectJsonStats();
    const now = new Date();
    const lastBackupMs = Date.parse(backup.lastSuccessfulBackup?.at || '');
    const lossWindowMs = lastBackupMs ? Math.max(0, now.getTime() - lastBackupMs) : Math.max(0, now.getTime() - startedAt.getTime());
    const estimatedBytes = stats.bytesModifiedSinceBackup;
    const lastDataLossMs = Date.parse(state.lastDataLossAt || '');
    const title = reason === 'startup' ? 'Bot Started' : reason === 'hourly-backup' ? 'Hourly Backup Snapshot' : 'Bot Shutdown / Crash Report';
    const description = error ? String(error.stack || error.message || error).slice(0, 1400) : 'No error object was provided.';

    return {
        username: 'Tickets Bot Monitor',
        embeds: [{
            title,
            color: estimatedBytes > 0 ? 0xFEE75C : 0x57F287,
            description,
            fields: [
                { name: 'Reason', value: String(reason || 'unknown'), inline: true },
                { name: 'Time', value: now.toISOString(), inline: true },
                { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
                { name: 'MEGA backup', value: backup.configured ? 'Configured' : 'Not configured', inline: true },
                { name: 'Last backup', value: backup.lastSuccessfulBackup?.at || 'Never in this process', inline: true },
                { name: 'Risk window', value: formatDuration(lossWindowMs), inline: true },
                { name: 'Estimated data loss', value: `${formatBytes(estimatedBytes)} across ${stats.filesModifiedSinceBackup} JSON file(s)`, inline: false },
                { name: 'Runtime data size', value: `${formatBytes(stats.bytes)} across ${stats.files} JSON file(s)`, inline: true },
                { name: 'Last recorded data loss', value: state.lastDataLossAt ? `${state.lastDataLossAt} (${formatDuration(now.getTime() - lastDataLossMs)} ago)` : 'None recorded', inline: false },
                { name: 'Last backup error', value: backup.lastBackupError?.message ? String(backup.lastBackupError.message).slice(0, 900) : 'None', inline: false }
            ],
            timestamp: now.toISOString()
        }]
    };
}

async function reportBotEvent(reason, error = null) {
    const payload = buildShutdownPayload(reason, error);
    const sent = await sendWebhook(payload).catch(() => false);
    const estimated = payload.embeds?.[0]?.fields?.find(field => field.name === 'Estimated data loss')?.value || '';
    const hasRisk = !estimated.startsWith('0 B');
    setState({
        lastReportAt: new Date().toISOString(),
        lastReportReason: reason,
        lastWebhookSent: sent,
        ...(hasRisk && reason !== 'startup' && reason !== 'hourly-backup' ? { lastDataLossAt: new Date().toISOString() } : {})
    });
    return sent;
}

async function reportCustomBotEvent(event, details = {}, error = null) {
    const now = new Date();
    const title = event === 'online'
        ? 'Custom Bot Online'
        : event === 'stopped'
            ? 'Custom Bot Stopped'
            : event === 'waiting_for_bind'
                ? 'Custom Bot Waiting For Bind'
                : 'Custom Bot Error';
    const description = error
        ? String(error.stack || error.message || error).slice(0, 1400)
        : String(details.description || 'Custom branded bot lifecycle update.').slice(0, 1400);
    const fields = [
        { name: 'Event', value: String(event || 'unknown'), inline: true },
        { name: 'Guild ID', value: String(details.guildId || 'unknown'), inline: true },
        { name: 'Bot', value: String(details.botName || details.userTag || 'unknown').slice(0, 256), inline: true },
        { name: 'App ID', value: String(details.appId || 'not set').slice(0, 256), inline: true },
        { name: 'Time', value: now.toISOString(), inline: true }
    ];
    if (details.reason) {
        fields.push({ name: 'Reason', value: String(details.reason).slice(0, 900), inline: false });
    }
    const payload = {
        username: 'Tickets Bot Monitor',
        embeds: [{
            title,
            color: event === 'online' ? 0x57F287 : (event === 'stopped' || event === 'waiting_for_bind') ? 0xFEE75C : 0xED4245,
            description,
            fields,
            timestamp: now.toISOString()
        }]
    };
    const sent = await sendWebhook(payload).catch(() => false);
    setState({
        lastCustomBotReportAt: now.toISOString(),
        lastCustomBotEvent: event,
        lastCustomBotGuildId: details.guildId || null,
        lastCustomBotWebhookSent: sent
    });
    return sent;
}

async function runMegaSnapshot(reason = 'snapshot') {
    const result = await megaBackup.backupAllJsonNow(reason);
    setState({
        lastBackupAttemptAt: new Date().toISOString(),
        lastBackupReason: reason,
        lastBackupOk: Boolean(result?.ok),
        lastBackupFiles: Number(result?.files || 0),
        lastBackupBytes: Number(result?.bytes || 0)
    });
    return result;
}

async function restoreFromMegaIfConfigured() {
    const result = await megaBackup.restoreLatestJsonBackups();
    setState({
        lastRestoreAttemptAt: new Date().toISOString(),
        lastRestoreOk: Boolean(result?.ok),
        lastRestoreSkipped: Boolean(result?.skipped),
        lastRestoreFiles: Number(result?.restored || 0),
        lastRestoreBytes: Number(result?.bytes || 0),
        lastRestoreReason: result?.reason || null
    });
    return result;
}

function startHourlyMegaBackups(options = {}) {
    const intervalMs = Math.max(60 * 1000, Number(options.intervalMs || process.env.MEGA_BACKUP_INTERVAL_MS || 60 * 60 * 1000));
    const run = () => runMegaSnapshot('hourly').catch(error => {
        setState({
            lastBackupAttemptAt: new Date().toISOString(),
            lastBackupReason: 'hourly',
            lastBackupOk: false,
            lastBackupError: error?.message || String(error)
        });
        console.warn('[Storage Monitor] Hourly MEGA backup failed:', error?.message || error);
    });
    setTimeout(run, Math.min(2 * 60 * 1000, intervalMs));
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

function installProcessMonitoring() {
    let closing = false;
    const close = async (reason, error = null, exitCode = 0) => {
        if (closing) return;
        closing = true;
        if (error) {
            console.error(`[Storage Monitor] ${reason}:`, error);
        }
        try {
            await runMegaSnapshot(`shutdown-${reason}`).catch(() => null);
            await reportBotEvent(reason, error).catch(() => null);
        } finally {
            process.exit(exitCode);
        }
    };

    process.on('SIGTERM', () => close('SIGTERM', null, 0));
    process.on('SIGINT', () => close('SIGINT', null, 0));
    process.on('uncaughtException', error => close('uncaughtException', error, 1));
    process.on('unhandledRejection', reason => close('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)), 1));
}

module.exports = {
    collectJsonStats,
    formatBytes,
    formatDuration,
    installProcessMonitoring,
    reportBotEvent,
    reportCustomBotEvent,
    restoreFromMegaIfConfigured,
    runMegaSnapshot,
    startHourlyMegaBackups
};
