const { MessageFlags } = require('discord.js');

function toUnixSeconds(value) {
    const ts = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return null;
    return Math.floor(ts / 1000);
}

function discordTime(value) {
    const seconds = toUnixSeconds(value);
    return seconds ? `<t:${seconds}:F>` : '';
}

function mentionUser(userId, fallback = 'System') {
    const id = String(userId || '').trim();
    return /^\d{17,20}$/.test(id) ? `<@${id}>` : fallback;
}

function safeText(value, fallback = '') {
    const str = String(value || '').trim();
    return str ? str : fallback;
}

function buildTranscriptSummaryV2(options = {}) {
    const ticketId = safeText(options.ticketId, 'Unknown');
    const guildName = safeText(options.guildName, 'Support System');
    const brandEmoji = safeText(options.brandEmoji, '');

    const openedBy = mentionUser(options.openedBy, '(unknown)');
    const openedAt = discordTime(options.openedAt) || '(unknown time)';

    const closedBy = mentionUser(options.closedBy, 'System');
    const closedAt = discordTime(options.closedAt) || '(unknown time)';

    const claimedByRaw = options.claimedBy ? mentionUser(options.claimedBy, '(unknown)') : '(unclaimed)';
    const claimedAtRaw = options.claimedAt ? discordTime(options.claimedAt) : '';
    const claimedLine = claimedByRaw === '(unclaimed)'
        ? '(unclaimed)'
        : `${claimedByRaw}${claimedAtRaw ? ` at ${claimedAtRaw}` : ''}`;

    const reason = safeText(options.closeReason, 'No reason provided.');
    const transcriptUrl = safeText(options.transcriptUrl, '');

    const headerUrl = safeText(options.headerUrl, '');
    const headerLabel = safeText(options.headerLabel, guildName);

    const headerText = `# ${guildName}${brandEmoji ? ` ${brandEmoji}` : ''}`;

    const details = [
        '**Ticket ID**',
        '#####',
        '',
        '**Opened By**',
        `${openedBy} at ${openedAt}`,
        '',
        '**Closed By**',
        `${closedBy} at ${closedAt}`,
        '',
        '**Claimed By**',
        claimedLine,
        '',
        '**Close Reason**',
        reason
    ].join('\n');

    const section = {
        type: 9,
        components: [{ type: 10, content: headerText }]
    };

    if (headerUrl) {
        section.accessory = {
            type: 2,
            style: 5,
            label: headerLabel.slice(0, 80),
            disabled: false,
            url: headerUrl
        };
    }

    const buttonRow = transcriptUrl
        ? {
            type: 1,
            components: [
                {
                    type: 2,
                    style: 5,
                    label: 'View Your Transcript',
                    disabled: false,
                    url: transcriptUrl
                }
            ]
        }
        : null;

    const container = {
        type: 17,
        accent_color: typeof options.accentColor === 'number' ? options.accentColor : 0x2563eb,
        spoiler: false,
        components: [
            section,
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: details },
            { type: 14, divider: true, spacing: 1 },
            buttonRow
        ].filter(Boolean)
    };

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

module.exports = {
    buildTranscriptSummaryV2,
    discordTime,
    mentionUser
};
