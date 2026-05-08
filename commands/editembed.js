const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const OWNER_ID = process.env.BOT_OWNER_ID || process.env.OWNER_ID || '';

function buildEmbed(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function parseMessageLink(messageLink) {
    const match = String(messageLink || '').trim().match(/\/channels\/(\d+|@me)\/(\d+)\/(\d+)/);
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId };
}

function tryJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function tryBase64JsonParse(value) {
    try {
        const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
        return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

function extractJsonCandidatesFromUrl(link) {
    const out = [];
    try {
        const url = new URL(link);
        const keys = ['data', 'json', 'payload', 'message', 'messages'];

        for (const key of keys) {
            const value = url.searchParams.get(key);
            if (value) out.push(value);
        }

        const hash = url.hash ? url.hash.slice(1) : '';
        if (hash) {
            out.push(hash);
            const hashParams = new URLSearchParams(hash);
            for (const key of keys) {
                const value = hashParams.get(key);
                if (value) out.push(value);
            }
        }
    } catch {
        // ignore malformed links here and fail later
    }
    return out;
}

function pickPayloadObject(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed.embeds) || typeof parsed.content === 'string' || Array.isArray(parsed.components)) {
        return parsed;
    }

    if (parsed.data && typeof parsed.data === 'object') return pickPayloadObject(parsed.data);
    if (parsed.message && typeof parsed.message === 'object') return pickPayloadObject(parsed.message);

    if (Array.isArray(parsed.messages) && parsed.messages.length) {
        return pickPayloadObject(parsed.messages[0]);
    }

    if (Array.isArray(parsed.backups) && parsed.backups.length) {
        return pickPayloadObject(parsed.backups[0]);
    }

    return null;
}

function sanitizePayload(payloadObject) {
    if (!payloadObject) return null;
    const payload = {};

    if (typeof payloadObject.content === 'string') payload.content = payloadObject.content;
    if (Array.isArray(payloadObject.embeds)) payload.embeds = payloadObject.embeds.slice(0, 10);
    if (Array.isArray(payloadObject.components)) payload.components = payloadObject.components.slice(0, 5);

    if (!payload.content && !payload.embeds && !payload.components) return null;
    return payload;
}

async function resolveShareIdPayload(shareId) {
    const normalized = String(shareId || '').trim();
    if (!normalized) return null;

    const endpoints = [
        `https://discohook.app/api/share/${normalized}`,
        `https://discohook.app/api/share?share=${encodeURIComponent(normalized)}`,
        `https://share.discohook.app/${normalized}`,
        `https://share.discohook.app/${normalized}.json`,
        `https://discohook.org/api/share/${normalized}`
    ];

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint);
            if (!response.ok) continue;

            const text = await response.text();
            const asJson = tryJsonParse(text);
            const direct = sanitizePayload(pickPayloadObject(asJson));
            if (direct) return direct;

            const wrapped = sanitizePayload(
                pickPayloadObject({
                    data: asJson,
                    message: asJson,
                    messages: Array.isArray(asJson) ? asJson : undefined
                })
            );
            if (wrapped) return wrapped;
        } catch {
            // Try next endpoint.
        }
    }

    return null;
}

async function parseDiscohookToMessagePayload(shareLink) {
    try {
        const url = new URL(shareLink);
        const shareId = url.searchParams.get('share');
        if (shareId) {
            const sharedPayload = await resolveShareIdPayload(shareId);
            if (sharedPayload) return sharedPayload;
        }
    } catch {
        // Ignore malformed URL and continue with generic parsing.
    }

    const candidates = [...extractJsonCandidatesFromUrl(shareLink)];

    try {
        const response = await fetch(shareLink);
        if (response.ok) {
            candidates.push(...extractJsonCandidatesFromUrl(response.url));
            const body = await response.text();

            // Catch common serialized payload snippets on share pages.
            const jsonLikeMatches = body.match(/\{[\s\S]{20,200000}\}/g) || [];
            candidates.push(...jsonLikeMatches.slice(0, 20));
        }
    } catch {
        // Fallback to URL-only parsing candidates.
    }

    for (const candidate of candidates) {
        const decoded = [];
        decoded.push(String(candidate));

        try {
            decoded.push(decodeURIComponent(String(candidate)));
        } catch {
            // ignore decode errors
        }

        for (const value of decoded) {
            const parsedDirect = tryJsonParse(value);
            const directPayload = sanitizePayload(pickPayloadObject(parsedDirect));
            if (directPayload) return directPayload;

            const parsedBase64 = tryBase64JsonParse(value);
            const b64Payload = sanitizePayload(pickPayloadObject(parsedBase64));
            if (b64Payload) return b64Payload;
        }
    }

    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('editembed')
        .setDescription('Owner only: edit a message embed using a Discohook share link')
        .addStringOption(option =>
            option
                .setName('message_link')
                .setDescription('Discord message link to edit')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('discohook_link')
                .setDescription('Discohook share link')
                .setRequired(true)
        ),

    async execute(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            const base = buildEmbed('Permission Denied', 'This command is owner-only.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const messageLink = interaction.options.getString('message_link', true);
        const discohookLink = interaction.options.getString('discohook_link', true);
        const parsedLink = parseMessageLink(messageLink);

        if (!parsedLink) {
            const base = buildEmbed('Invalid Message Link', 'Provide a valid Discord message link.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const payload = await parseDiscohookToMessagePayload(discohookLink);
        if (!payload) {
            return interaction.editReply(buildEmbed(
                'Invalid Discohook Share Link',
                'Could not extract a valid message payload (content/embeds/components) from that link.',
                0xED4245
            ));
        }

        try {
            const channel = await interaction.client.channels.fetch(parsedLink.channelId);
            if (!channel || !channel.isTextBased()) {
                return interaction.editReply(buildEmbed('Channel Not Found', 'Could not access the target channel.', 0xED4245));
            }

            const message = await channel.messages.fetch(parsedLink.messageId);
            await message.edit(payload);

            return interaction.editReply(buildEmbed('Embed Updated', `Updated message \`${parsedLink.messageId}\` from Discohook payload.`, 0x57F287));
        } catch (error) {
            console.error('Error editing embed from Discohook:', error);
            return interaction.editReply(buildEmbed('Edit Failed', 'Failed to edit that message. Check link access and bot permissions.', 0xED4245));
        }
    }
};
