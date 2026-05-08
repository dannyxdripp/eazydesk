const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function toIsoOrNow(value) {
    const ts = Date.parse(String(value || ''));
    if (Number.isNaN(ts)) return new Date().toISOString();
    return new Date(ts).toISOString();
}

function getLastActivityMs(ticket) {
    const last = Date.parse(ticket?.lastActivityAt || ticket?.createdAt || '');
    if (!Number.isNaN(last)) return last;
    return Date.now();
}

function touchTicket(ticket, userId = null, whenIso = null) {
    if (!ticket || typeof ticket !== 'object') return;
    const iso = toIsoOrNow(whenIso);
    ticket.lastActivityAt = iso;
    if (userId) ticket.lastResponderId = String(userId);
    ticket.inactivityNotifiedAt = null;
}

function buildTicketTopic(ticket, nowMs = Date.now()) {
    const openedMs = Date.parse(ticket?.createdAt || '') || nowMs;
    const lastMs = getLastActivityMs(ticket);
    const stale = nowMs - lastMs >= SIX_HOURS_MS;
    const opener = ticket?.createdBy ? `<@${ticket.createdBy}>` : 'unknown';
    const assignee = ticket?.claimedBy ? `<@${ticket.claimedBy}>` : 'Unclaimed';
    const staleLabel = stale ? 'No response for 6+ hours' : 'Active';
    return [
        `Opened: <t:${Math.floor(openedMs / 1000)}:R> by ${opener}`,
        `Claimed by: ${assignee}`,
        `Last activity: <t:${Math.floor(lastMs / 1000)}:R>`,
        `Status: ${staleLabel}`
    ].join(' | ').slice(0, 1000);
}

async function updateTicketChannelMetadata(channel, ticket, nowMs = Date.now()) {
    if (!channel || typeof channel.setTopic !== 'function') return;
    const topic = buildTicketTopic(ticket, nowMs);
    if ((channel.topic || '') === topic) return;
    await channel.setTopic(topic).catch(() => null);
}

module.exports = {
    SIX_HOURS_MS,
    TWELVE_HOURS_MS,
    getLastActivityMs,
    touchTicket,
    buildTicketTopic,
    updateTicketChannelMetadata
};
