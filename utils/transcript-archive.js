const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ticketStore = require('./ticket-store');
const { getTranscriptsDir, ensureDir } = require('./storage-paths');

const TRANSCRIPTS_DIR = getTranscriptsDir();
const DAY_MS = 24 * 60 * 60 * 1000;

function getTranscriptRetentionDays() {
    const raw =
        process.env.TRANSCRIPT_RETENTION_DAYS ??
        process.env.TRANSCRIPTS_RETENTION_DAYS ??
        '30';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 30;
    return Math.max(0, Math.min(3650, Math.floor(parsed)));
}

function resolveTranscriptFileName(channelId, transcriptPath) {
    if (transcriptPath) return path.basename(transcriptPath);
    return `${channelId}.html`;
}

function resolveTranscriptPath(channelId, fileName) {
    const safeName = String(fileName || `${channelId}.html`).replace(/[\\/]/g, '');
    return path.join(TRANSCRIPTS_DIR, safeName);
}

function randomToken(bytes = 24) {
    return crypto.randomBytes(Math.max(16, Number(bytes) || 24)).toString('base64url');
}

function sanitizeUserIds(input, limit = 75) {
    const list = Array.isArray(input) ? input : [input];
    const ids = list
        .flatMap(value => (Array.isArray(value) ? value : [value]))
        .map(value => String(value || '').trim())
        .filter(value => /^\d{17,20}$/.test(value));
    return [...new Set(ids)].slice(0, Math.max(0, Number(limit) || 0));
}

function safeStatSize(filePath) {
    try { return fs.statSync(filePath).size; } catch { return null; }
}

function archiveTranscript({ channel, ticket, transcriptPath, reason, closedByUserId, closedAt, participantUserIds = [], storage = null }) {
    const channelId = String(channel?.id || '').trim();
    if (!/^\d{17,20}$/.test(channelId)) return null;

    const activeStorage = storage || ticketStore.getActiveStorage();
    const existing = ticketStore.getTranscriptArchives(activeStorage).find(entry => entry && String(entry.channelId) === channelId) || null;

    const archivedAt = closedAt || new Date().toISOString();
    const fileName = resolveTranscriptFileName(channelId, transcriptPath);
    const filePath = resolveTranscriptPath(channelId, fileName);
    const size = safeStatSize(transcriptPath || filePath);
    const retentionDays = getTranscriptRetentionDays();
    const expiresAt = retentionDays > 0
        ? new Date(Date.parse(archivedAt) + (retentionDays * DAY_MS)).toISOString()
        : null;

    const allowedUserIds = sanitizeUserIds([
        ticket?.createdBy,
        ticket?.claimedBy,
        closedByUserId,
        participantUserIds,
        existing?.allowedUserIds
    ]);

    const publicToken = String(existing?.publicToken || '').trim() || randomToken();
    const notes = ticketStore.getTicketNotes(channelId, activeStorage);
    const escalations = Array.isArray(ticket?.escalations) ? ticket.escalations : [];

    const entry = {
        channelId,
        channelName: channel?.name || null,
        guildId: channel?.guild?.id || null,
        ticketType: ticket?.ticketType || null,
        createdBy: ticket?.createdBy || null,
        claimedBy: ticket?.claimedBy || null,
        createdAt: ticket?.createdAt || null,
        lastActivityAt: ticket?.lastActivityAt || null,
        closedBy: closedByUserId ? String(closedByUserId) : null,
        closeReason: reason ? String(reason).trim().slice(0, 900) : null,
        escalations,
        notes,
        closedAt: archivedAt,
        archivedAt,
        retentionDays,
        expiresAt,
        publicToken,
        allowedUserIds,
        fileName,
        size
    };

    return ticketStore.upsertTranscriptArchive(entry, activeStorage);
}

function deleteTranscriptArchive(channelId, storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const archives = ticketStore.getTranscriptArchives(activeStorage);
    const id = String(channelId || '').trim();
    const match = archives.find(entry => entry && String(entry.channelId) === id) || null;
    const fileName = match?.fileName || `${id}.html`;
    const filePath = resolveTranscriptPath(id, fileName);

    const removedEntry = ticketStore.deleteTranscriptArchive(id, activeStorage);
    let removedFile = false;
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            removedFile = true;
        }
    } catch {}

    return { removedEntry, removedFile };
}

function pruneTranscriptArchives(options = {}) {
    const activeStorage = options.storage || ticketStore.getActiveStorage();
    const retentionDays = options.retentionDays ?? getTranscriptRetentionDays();
    const archives = ticketStore.getTranscriptArchives(activeStorage);

    if (retentionDays <= 0) {
        return { retentionDays, removedEntries: 0, removedFiles: 0, removedOrphans: 0, remaining: archives.length };
    }

    const cutoff = Date.now() - (retentionDays * DAY_MS);
    let removedEntries = 0;
    let removedFiles = 0;

    const kept = [];

    for (const entry of archives) {
        const channelId = String(entry?.channelId || '').trim();
        if (!/^\d{17,20}$/.test(channelId)) continue;

        const timestamp = Date.parse(entry.archivedAt || entry.closedAt || entry.createdAt || '');
        const isExpired = Number.isFinite(timestamp) && timestamp < cutoff;

        const fileName = resolveTranscriptFileName(channelId, entry?.fileName);
        const filePath = resolveTranscriptPath(channelId, fileName);
        const fileExists = fs.existsSync(filePath);

        if (!fileExists || isExpired) {
            removedEntries += 1;
            if (fileExists) {
                try { fs.unlinkSync(filePath); removedFiles += 1; } catch {}
            }
            continue;
        }

        kept.push(entry);
    }

    let removedOrphans = 0;
    try {
        ensureDir(TRANSCRIPTS_DIR);
        const indexed = new Set(kept.map(entry => String(entry?.fileName || '').trim()).filter(Boolean));
        for (const file of fs.readdirSync(TRANSCRIPTS_DIR)) {
            if (!/^\d{17,20}\.html$/i.test(file)) continue;
            if (indexed.has(file)) continue;
            const filePath = path.join(TRANSCRIPTS_DIR, file);
            let mtime = 0;
            try { mtime = fs.statSync(filePath).mtimeMs || 0; } catch { mtime = 0; }
            if (mtime && mtime < cutoff) {
                try { fs.unlinkSync(filePath); removedOrphans += 1; } catch {}
            }
        }
    } catch {}

    if (removedEntries > 0) {
        activeStorage.transcriptArchives = kept;
        ticketStore.saveActiveStorage(activeStorage);
    }

    return { retentionDays, removedEntries, removedFiles, removedOrphans, remaining: kept.length };
}

module.exports = {
    TRANSCRIPTS_DIR,
    getTranscriptRetentionDays,
    archiveTranscript,
    deleteTranscriptArchive,
    pruneTranscriptArchives,
    resolveTranscriptPath
};
