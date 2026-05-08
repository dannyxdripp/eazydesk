const {
    ContainerBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    MessageFlags
} = require('discord.js');

function isV2Supported() {
    return typeof ContainerBuilder === 'function' && typeof TextDisplayBuilder === 'function';
}

function parseSeparatorToken(line) {
    const trimmed = String(line || '').trim();
    const match = trimmed.match(/^\[\[(divider|sep|separator|space|spacer)(?::(small|large))?\]\]$/i);
    if (!match) return null;

    const kind = String(match[1] || '').toLowerCase();
    const spacingRaw = String(match[2] || 'small').toLowerCase();
    const divider = !(kind === 'space' || kind === 'spacer');
    const spacing = spacingRaw === 'large'
        ? (SeparatorSpacingSize?.Large ?? 2)
        : (SeparatorSpacingSize?.Small ?? 1);

    return { divider, spacing };
}

function splitMarkdownWithSeparators(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const parts = [];
    let buffer = [];

    const flush = () => {
        const content = buffer.join('\n').trim();
        buffer = [];
        if (content) parts.push({ type: 'text', content });
    };

    for (const line of lines) {
        const token = parseSeparatorToken(line);
        if (!token) {
            buffer.push(line);
            continue;
        }

        flush();
        parts.push({ type: 'separator', ...token });
    }

    flush();
    return parts;
}

function inferKind(title, color) {
    const text = String(title || '').toLowerCase();

    if (
        text.includes('error') ||
        text.includes('failed') ||
        text.includes('fail') ||
        text.includes('invalid') ||
        text.includes('denied') ||
        text.includes('missing') ||
        text.includes('not found') ||
        text.includes('permission') ||
        text.includes('rate-limited') ||
        text.includes('configuration error')
    ) return 'error';

    if (
        text.includes('success') ||
        text.includes('created') ||
        text.includes('enabled') ||
        text.includes('submitted') ||
        text.includes('updated') ||
        text.includes('complete') ||
        text.includes('sent') ||
        text.includes('renamed') ||
        text.includes('escalated') ||
        text.includes('claimed')
    ) return 'success';

    if (Number(color) === 0x57F287) return 'success';
    if (Number(color) === 0xED4245) return 'error';
    if (Number(color) === 0xFEE75C) return 'warning';

    if (text.includes('warning') || text.includes('slow down') || text.includes('closing') || text.includes('queued')) return 'warning';
    return 'info';
}

function kindEmoji(kind) {
    if (kind === 'success') return '<:checkbox:1487433169157357688>';
    if (kind === 'error') return '<:crossbox:1487433209871339602>';
    return '';
}

function kindAccent(kind) {
    if (kind === 'success') return 0x57F287;
    if (kind === 'error') return 0xED4245;
    if (kind === 'warning') return 0xFEE75C;
    return 0x5865F2;
}

function buildV2Notice(title, description = '', color = 0x5865F2, extra = {}) {
    if (!isV2Supported()) {
        throw new Error('Components V2 builders are not available in this discord.js build.');
    }

    const kind = inferKind(title, color);
    const safeTitle = String(title || '').trim();
    const safeDescription = String(description || '').trim();

    const shouldAccent = kind === 'success' || kind === 'error';
    let accentColor = Number.isFinite(Number(color)) ? Number(color) : kindAccent(kind);
    if (accentColor === 0x5865F2 && shouldAccent) accentColor = kindAccent(kind);
    const emoji = kindEmoji(kind);
    const header = safeTitle ? `## ${emoji ? `${emoji} ` : ''}${safeTitle}` : '';
    const bodyText = (!safeTitle && emoji && safeDescription)
        ? `${emoji} ${safeDescription}`
        : safeDescription;
    const markdown = [header, bodyText].filter(Boolean).join('\n\n');

    const container = new ContainerBuilder();
    const parts = splitMarkdownWithSeparators(markdown);
    const planned = [];

    for (const part of parts.length ? parts : [{ type: 'text', content: markdown }]) {
        if (!part) continue;
        if (planned.length < 10) {
            planned.push(part);
            continue;
        }
        if (part.type === 'text' && planned.length) {
            const last = planned[planned.length - 1];
            if (last && last.type === 'text') last.content = `${last.content}\n${part.content}`;
        }
    }

    for (const part of planned) {
        if (part.type === 'separator') {
            if (typeof SeparatorBuilder !== 'function' || typeof container.addSeparatorComponents !== 'function') continue;
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(Boolean(part.divider)).setSpacing(part.spacing)
            );
            continue;
        }
        const content = String(part.content || '').trim();
        if (!content) continue;
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }

    if (shouldAccent) container.setAccentColor(accentColor);

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        ...extra
    };
}

function buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color = 0x5865F2, vars = {}, extra = {}) {
    const next = resolveEmbedByTitle(ticketStore, title, description, color, vars);
    return buildV2Notice(next.title, next.description, next.color, extra);
}

module.exports = {
    buildV2Notice,
    buildV2FromTemplate,
    inferKind,
    isV2Supported,
    kindEmoji,
    kindAccent
};
