const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    MessageFlags,
    TextInputBuilder,
    TextInputStyle,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ContainerBuilder,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ChannelType,
    ComponentType
} = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { touchTicket, updateTicketChannelMetadata } = require('../utils/ticket-metadata');
const { buildV2Notice } = require('../utils/components-v2-messages');
const closeRequestCommand = require('../commands/closerequest');
const { resolveParentCategoryId: resolveDefaultParentCategoryId } = require('../utils/guild-defaults');
const { formatBotPermissionGuide } = require('../utils/permission-messages');

const MANUAL_STATUSES = new Set(['available', 'increased_volume', 'reduced_assistance']);
const INCREASED_THRESHOLD = 10;
const REDUCED_THRESHOLD = 15;
const STATUS_SEVERITY = { available: 0, increased_volume: 1, reduced_assistance: 2 };

const AI_RESOLVED_BUTTON_ID = 'ai_prompt_resolved';
const AI_SUPPORT_BUTTON_ID = 'ai_prompt_support';
const TICKET_REASON_MODAL_PREFIX = 'ticket_reason_modal:';
const TICKET_REASON_INPUT_ID = 'ticket_open_reason';
const TICKET_FILE_UPLOAD_INPUT_ID = 'ticket_open_files';
const CHANNEL_CREATE_PERMISSIONS = [
    PermissionsBitField.Flags.ManageChannels
];

const BOT_TICKET_GUILD_PERMISSIONS = [
    PermissionsBitField.Flags.ManageChannels
];

const BOT_TICKET_CHANNEL_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.ManageChannels
];

function getAutomaticAvailabilityStatus(count) {
    if (count > REDUCED_THRESHOLD) return 'reduced_assistance';
    if (count > INCREASED_THRESHOLD) return 'increased_volume';
    return 'available';
}

function getEffectiveAvailability(storage, ticketTypeName, guildId = null) {
    const key = ticketStore.normalizeType(ticketTypeName);
    const count = ticketStore.getActiveTicketCountForType(ticketTypeName, storage, guildId);
    const gid = guildId ? String(guildId) : null;
    const manualStatus = gid && !ticketStore.isTestGuild?.(gid)
        ? ticketStore.getGuildConfig?.(gid, storage)?.availabilityOverrides?.[key]
        : storage.availabilityOverrides?.[key];
    const automaticStatus = getAutomaticAvailabilityStatus(count);

    if (!MANUAL_STATUSES.has(manualStatus)) {
        return { status: automaticStatus, count, source: 'automatic', manualStatus: null, automaticStatus };
    }

    const useAutomatic = STATUS_SEVERITY[automaticStatus] > STATUS_SEVERITY[manualStatus];
    return {
        status: useAutomatic ? automaticStatus : manualStatus,
        count,
        source: useAutomatic ? 'automatic' : 'manual',
        manualStatus,
        automaticStatus
    };
}

function getAvailabilityMeta(status) {
    if (status === 'reduced_assistance') {
        return {
            label: '<:reducedassistance:1477769722794610709> Reduced Assistance',
            notice: '```ansi\n\u001b[2;31m\u001b[2;42m\u001b[2;46m\u001b[2;47m\u001b[2;40m\u001b[2;33m\u001b[1;33m\u001b[1;31mSupport is currently experiencing high volumes of tickets. Urgent issues only. Describe your issue in detail so we can help you as soon as possible.\u001b[0m\u001b[1;33m\u001b[1;40m\u001b[0m\u001b[2;33m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;47m\u001b[0m\u001b[2;31m\u001b[2;46m\u001b[0m\u001b[2;31m\u001b[2;42m\u001b[0m\u001b[2;31m\u001b[0m\n```'
        };
    }
    if (status === 'increased_volume') {
        return {
            label: '<:limitedassistance:1477766529645805638> Limited Assistance',
            notice: '```ansi\n\u001b[2;31m\u001b[2;42m\u001b[2;46m\u001b[2;47m\u001b[2;40m\u001b[2;33m\u001b[1;33m\u001b[1;31m\u001b[1;41m\u001b[1;37mDue to an increased volume of tickets, support is limited. Describe your issue in detail so that we can support you best.\u001b[0m\u001b[1;31m\u001b[1;41m\u001b[0m\u001b[1;31m\u001b[1;40m\u001b[0m\u001b[1;33m\u001b[1;40m\u001b[0m\u001b[2;33m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;47m\u001b[0m\u001b[2;31m\u001b[2;46m\u001b[0m\u001b[2;31m\u001b[2;42m\u001b[0m\u001b[2;31m\u001b[0m\n```'
        };
    }
    return { label: 'Available', notice: 'Support is operating normally.' };
}

function buildInfoMessage(title, description, color = 0x5865F2, extra = {}) {
    return buildV2Notice(title, description, color, extra);
}

function renderTemplate(text, values) {
    let output = String(text || '');
    for (const [key, value] of Object.entries(values || {})) {
        output = output.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''));
    }
    return output;
}

function slugChannelPart(value, fallback = 'ticket') {
    const slug = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    return slug || fallback;
}

function nextTicketNumber(storage, guildId) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    if (!activeStorage.ticketCounters || typeof activeStorage.ticketCounters !== 'object') {
        activeStorage.ticketCounters = {};
    }
    const key = String(guildId || 'global');
    const current = Number(activeStorage.ticketCounters[key] || 0);
    const next = Number.isFinite(current) ? current + 1 : 1;
    activeStorage.ticketCounters[key] = next;
    return next;
}

function resolveTicketChannelName(ticketConfig, ticketType, user, storage, guildId, options = {}) {
    const ticketNumber = nextTicketNumber(storage, guildId);
    const suffix = Date.now().toString(36).slice(-4);
    const priority = options.urgentConfirmed
        ? 'urgent'
        : options.statusInfo?.status === 'reduced_assistance'
            ? 'reduced'
            : options.statusInfo?.status === 'increased_volume'
                ? 'limited'
                : 'normal';
    const template = String(ticketConfig?.format || 'ticket-{number}').trim() || 'ticket-{number}';
    const values = {
        number: ticketNumber,
        ticketNumber,
        id: ticketNumber,
        user: user.id || '',
        userId: user.id || '',
        username: user.username || 'user',
        displayName: user.globalName || user.displayName || user.username || 'user',
        type: ticketType,
        ticketType,
        priority,
        suffix
    };

    return renderTemplate(template.replace(/^#/, ''), values)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 95) || `ticket-${ticketNumber}`;
}

function resolveOpenTicketEmbed(ticketConfig, ticketType, user, reason, ticketChannel = null, attachments = []) {
    const template = ticketConfig?.openEmbed || {};
    const titleTemplate = template.title || 'Ticket: {ticketType}';
    const descriptionTemplate = template.description ||
        'Requester: {requester}\nReason: {reason}\n\nA support representative will respond shortly.';
    const now = new Date();
    const unix = Math.floor(now.getTime() / 1000);

    const attachmentUrls = Array.isArray(attachments) ? attachments.map(u => String(u || '').trim()).filter(Boolean) : [];
    const attachmentsText = attachmentUrls.length ? attachmentUrls.map(url => `- ${url}`).join('\n') : 'None';

    const vars = {
        ticketType,
        requester: String(user),
        username: user.username || '',
        userId: user.id || '',
        reason: reason || 'No reason provided.',
        attachments: attachmentsText,
        attachmentsCount: attachmentUrls.length,
        timestamp: `<t:${unix}:F>`,
        timestampIso: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        time: now.toISOString().slice(11, 19),
        channel: ticketChannel ? `<#${ticketChannel.id}>` : '',
        channelId: ticketChannel?.id || ''
    };

    return {
        title: renderTemplate(titleTemplate, vars),
        description: (() => {
            const rendered = renderTemplate(descriptionTemplate, vars);
            if (!attachmentUrls.length) return rendered;
            if (descriptionTemplate.includes('{attachments}')) return rendered;
            return `${rendered}\n\nAttachments:\n${attachmentsText}`;
        })()
    };
}

function buildOpenSupportRow(options = {}) {
    const label = String(options?.buttonLabel || 'Select a prompt').trim().slice(0, 80) || 'Select a prompt';
    const ticketType = String(options?.ticketType || '').trim();
    const customId = ticketType ? `open-ticket-type:${ticketType}` : 'p_275287590028972042';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(label)
            .setEmoji({ id: '1477691338718974194', name: 'headset', animated: false })
            .setStyle(ButtonStyle.Secondary)
    );
}

function parseHexColor(raw, fallback = 0x5865F2) {
    const value = String(raw || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return fallback;
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveParentCategoryId(guild, ticketConfig) {
    const configured = String(ticketConfig?.categoryId || '').trim();
    const guildDefault = resolveDefaultParentCategoryId(guild?.id);

    const candidates = [configured, guildDefault].filter(Boolean);
    for (const id of candidates) {
        if (!guild?.channels?.cache) return id;
        let ch = guild.channels.cache.get(id);
        if (!ch && typeof guild.channels.fetch === 'function') {
            ch = await guild.channels.fetch(id).catch(() => null);
        }
        if (!ch) continue;
        if (ch.type === ChannelType.GuildCategory) return id;
    }
    return null;
}

function getMissingPermissionNames(permissions, required) {
    const labels = {
        [PermissionsBitField.Flags.ManageChannels]: 'Manage Channels',
        [PermissionsBitField.Flags.ManageRoles]: 'Manage Roles',
        [PermissionsBitField.Flags.ViewChannel]: 'View Channels',
        [PermissionsBitField.Flags.SendMessages]: 'Send Messages',
        [PermissionsBitField.Flags.EmbedLinks]: 'Embed Links',
        [PermissionsBitField.Flags.ReadMessageHistory]: 'Read Message History',
        [PermissionsBitField.Flags.AttachFiles]: 'Attach Files',
        [PermissionsBitField.Flags.UseApplicationCommands]: 'Use Application Commands',
        [PermissionsBitField.Flags.SendMessagesInThreads]: 'Send Messages in Threads',
        [PermissionsBitField.Flags.CreatePublicThreads]: 'Create Public Threads',
        [PermissionsBitField.Flags.ManageMessages]: 'Manage Messages',
        [PermissionsBitField.Flags.CreateInstantInvite]: 'Create Instant Invite'
    };
    return required
        .filter(permission => !permissions?.has?.(permission))
        .map(permission => labels[permission] || String(permission));
}

function getRequiredTicketPermissions(/* allowAttachments = true */) {
    return [
        ...BOT_TICKET_GUILD_PERMISSIONS
    ];
}

function formatMissingPermissionsMessage(context, missing) {
    const list = Array.from(new Set(missing || [])).filter(Boolean);
    if (!list.length) return '';
    return `${context}: **${list.join(', ')}**.`;
}

function describeDiscordPermissionError(error, guild, parentInfo, ticketChannel = null, allowAttachments = true) {
    const me = guild?.members?.me;
    const lines = ['Discord blocked this because I am missing permissions.'];
    if (error?.code === 50001) lines[0] = 'Discord says I do not have access to that channel or category.';
    if (error?.code === 50013) lines[0] = 'Discord says I do not have permission to complete that action.';

    if (me) {
        const serverMissing = getMissingPermissionNames(me.permissions, getRequiredTicketPermissions(allowAttachments));
        if (serverMissing.length) lines.push(formatMissingPermissionsMessage('Server permissions missing', serverMissing));
        const target = ticketChannel || parentInfo?.channel || null;
        if (target && typeof target.permissionsFor === 'function') {
            const channelMissing = getMissingPermissionNames(target.permissionsFor(me), [
                ...BOT_TICKET_CHANNEL_PERMISSIONS,
                ...(allowAttachments ? [PermissionsBitField.Flags.AttachFiles] : [])
            ]);
            if (channelMissing.length) lines.push(formatMissingPermissionsMessage(`Channel/category permissions missing in ${target.name ? `**${target.name}**` : 'the selected channel'}`, channelMissing));
        }
    }

    if (parentInfo?.channel) {
        lines.push(`Check the configured ticket category: **${parentInfo.channel.name}**.`);
    }
    lines.push(formatBotPermissionGuide());
    return lines.filter(Boolean).join('\n');
}

function validateSendPanelPermissions(channel, guild) {
    const me = guild?.members?.me || channel?.guild?.members?.me;
    if (!me || !channel || typeof channel.permissionsFor !== 'function') {
        return { ok: false, message: 'I could not read my permissions for that channel. Please try again in a moment.' };
    }
    const missing = getMissingPermissionNames(channel.permissionsFor(me), [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.ReadMessageHistory
    ]);
    return missing.length
        ? { ok: false, message: `I cannot post the ticket panel in **${channel.name || 'that channel'}** because I am missing: **${missing.join(', ')}**.` }
        : { ok: true };
}

async function resolveTicketParentCategory(guild, parentCategoryId) {
    const id = String(parentCategoryId || '').trim();
    if (!id || !guild?.channels?.cache) return { id: null, channel: null, missing: false };
    let channel = guild.channels.cache.get(id);
    if (!channel && typeof guild.channels.fetch === 'function') {
        channel = await guild.channels.fetch(id).catch(() => null);
    }
    if (!channel || channel.type !== ChannelType.GuildCategory) {
        return { id: null, channel: null, missing: true, originalId: id };
    }
    return { id, channel, missing: false };
}

function validateCreateTicketPermissions(guild, parentInfo) {
    const me = guild?.members?.me;
    if (!me) {
        return { ok: false, message: 'I could not read my server member permissions. Please try again in a moment.' };
    }

    const guildMissing = getMissingPermissionNames(me.permissions, getRequiredTicketPermissions());
    if (guildMissing.length) {
        return {
            ok: false,
            message: `I need **${guildMissing.join(', ')}** in this server to create tickets.`
        };
    }

    return { ok: true };
}

async function ensureBotCategoryPermissions(/* guild, parentInfo, allowAttachments = true */) {
    return { ok: true, repaired: false };
}

function getRestrictedTicketTypeForChannel(interaction) {
    const channelId = interaction?.channelId || interaction?.channel?.id;
    if (!channelId) return null;
    const restricted = ticketStore.getRestrictedTicketTypeForChannel(channelId, null, interaction?.guildId || null);
    if (!restricted) return null;
    const ticketConfig = ticketStore.findTicketTypeBySelectValue(restricted, interaction?.guildId || null);
    if (!ticketConfig) return null;
    return restricted;
}

function parseComponentEmoji(rawEmoji) {
    const emoji = String(rawEmoji || '').trim();
    if (!emoji) return null;
    const custom = emoji.match(/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (custom) {
        return {
            animated: custom[1] === 'a',
            name: custom[2],
            id: custom[3]
        };
    }
    return { name: emoji };
}

function buildTicketTypeButtonRows(guildId) {
    const ticketTypes = ticketStore.getTicketTypesForGuild(guildId).slice(0, 25);
    const rows = [];
    let currentRow = new ActionRowBuilder();

    for (let i = 0; i < ticketTypes.length; i += 1) {
        const ticketType = ticketTypes[i];
        const teamData = ticketStore.findSupportTeamForTicketType(ticketType.name, guildId);
        const buttonEmoji = parseComponentEmoji(teamData?.emoji || ticketType.emoji);
        const button = new ButtonBuilder()
            .setCustomId(`open-ticket-type:${ticketStore.toTicketSelectValue(ticketType.name)}`)
            .setLabel(ticketType.name.slice(0, 80))
            .setStyle(ButtonStyle.Primary);
        if (buttonEmoji) button.setEmoji(buttonEmoji);
        currentRow.addComponents(button);

        if (currentRow.components.length === 3 || i === ticketTypes.length - 1) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
        }
    }
    return rows;
}

function buildTicketTypeSelectRows(guildId, panelChannelId = null) {
    const ticketTypes = ticketStore.getTicketTypesForGuild(guildId).slice(0, 25);
    if (!ticketTypes.length) return [];
    const suffix = panelChannelId ? `:${String(panelChannelId).slice(0, 32)}` : '';
    const select = new StringSelectMenuBuilder()
        .setCustomId(`select-ticket-type${suffix}`)
        .setPlaceholder('Choose the support topic')
        .addOptions(ticketTypes.map(ticketType => {
            const teamData = ticketStore.findSupportTeamForTicketType(ticketType.name, guildId);
            const option = {
                label: String(ticketType.name || 'Ticket').slice(0, 100),
                value: ticketStore.toTicketSelectValue(ticketType.name),
                description: String(ticketType.description || teamData?.description || 'Open a support ticket').slice(0, 100)
            };
            const emoji = parseComponentEmoji(teamData?.emoji || ticketType.emoji);
            if (emoji) option.emoji = emoji;
            return option;
        }));
    return [new ActionRowBuilder().addComponents(select)];
}

function resolvePanelDisplayStyle(panel) {
    const display = String(panel?.displayStyle || panel?.selectorStyle || '').trim().toLowerCase();
    return display === 'select' ? 'select' : 'buttons';
}

async function sendEphemeral(interaction, payload) {
    const baseFlags = Number(payload?.flags || 0);
    const response = { ...payload, flags: baseFlags | MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
        // `Ephemeral` can't be edited, but `IsComponentsV2` can.
        const editableFlags = response.flags & ~MessageFlags.Ephemeral;
        const { flags, ...editable } = response;
        if (editableFlags) editable.flags = editableFlags;
        return interaction.editReply(editable).catch(() => null);
    }
    return interaction.reply(response).catch(() => null);
}

async function ensureEphemeralAck(interaction) {
    if (!interaction || interaction.deferred || interaction.replied) return;
    if (typeof interaction.deferReply !== 'function') return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
}

function collectTagMatches(reasonText, guildId) {
    const reason = ticketStore.normalizeType(reasonText);
    const reasonTokens = new Set(reason.split(/[^a-z0-9]+/).filter(token => token.length >= 3));

    const scored = ticketStore.getTagsForGuild(guildId).map(tag => {
        const rawTokens = [
            tag.name,
            tag.title,
            ...(Array.isArray(tag.keywords) ? tag.keywords : [])
        ].filter(Boolean);

        const tagTokens = new Set();
        for (const raw of rawTokens) {
            const normalized = ticketStore.normalizeType(raw);
            if (normalized) tagTokens.add(normalized);
            for (const part of normalized.split(/[^a-z0-9]+/)) {
                if (part.length >= 3) tagTokens.add(part);
            }
        }

        let score = 0;
        for (const token of tagTokens) {
            if (reason.includes(token)) score += token.length >= 6 ? 3 : 2;
            if (reasonTokens.has(token)) score += 2;
        }

        return { tag, score };
    });

    return scored
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(entry => entry.tag);
}

function compactText(value, max = 1800) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function robloxDevForumSearchUrl(query) {
    const q = encodeURIComponent(String(query || '').trim().slice(0, 160));
    return q ? `https://devforum.roblox.com/search?q=${q}` : 'https://devforum.roblox.com/';
}

async function searchRobloxDevForum(reasonText) {
    const query = compactText(reasonText, 180).replace(/\broblox\b/ig, '').trim() || compactText(reasonText, 180);
    if (!query) return [];
    try {
        const response = await fetch(`https://devforum.roblox.com/search.json?q=${encodeURIComponent(query)}`, {
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) return [];
        const data = await response.json().catch(() => ({}));
        const topics = Array.isArray(data?.topics) ? data.topics : [];
        return topics.slice(0, 3).map(topic => ({
            title: compactText(topic?.title, 120),
            url: topic?.slug && topic?.id ? `https://devforum.roblox.com/t/${topic.slug}/${topic.id}` : ''
        })).filter(item => item.title && item.url);
    } catch {
        return [];
    }
}

async function getGeminiSuggestion(reasonText, matchedTags, options = {}) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        const forumLinks = Array.isArray(options.forumLinks) ? options.forumLinks : [];
        const contextMessages = Array.isArray(options.contextMessages) ? options.contextMessages : [];
        const imageSummaries = Array.isArray(options.imageSummaries) ? options.imageSummaries : [];
        const prompt = [
            'You are a formal support assistant for a Discord server.',
            options.conversation
                ? 'Continue the support conversation. Ask one useful follow-up question when details are missing. Keep the reply concise and practical.'
                : 'Provide a concise suggested response based on the user reason, matching tags, and relevant Roblox Developer Forum results.',
            `Reason: ${reasonText}`,
            `Matching tags: ${matchedTags.map(tag => tag.name).join(', ') || 'none'}`,
            forumLinks.length ? `Roblox Developer Forum results:\n${forumLinks.map(item => `- ${item.title}: ${item.url}`).join('\n')}` : '',
            imageSummaries.length ? `Image upload summaries:\n${imageSummaries.map(item => `- ${item.summary}`).join('\n')}` : '',
            contextMessages.length ? `Recent conversation:\n${contextMessages.map(item => `${item.role}: ${item.content}`).join('\n')}` : ''
        ].join('\n');

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 220 }
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch {
        return null;
    }
}

async function summarizeImageAttachment(attachment) {
    const apiKey = process.env.GEMINI_API_KEY;
    const contentType = String(attachment?.contentType || '').toLowerCase();
    const url = String(attachment?.url || '').trim();
    if (!apiKey || !url || !contentType.startsWith('image/')) return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: 'Summarize this support-ticket image in one short sentence. Do not store or refer to the image itself.' },
                        { inlineData: { mimeType: contentType, data: base64 } }
                    ]
                }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 80 }
            })
        });
        if (!aiResponse.ok) return null;
        const data = await aiResponse.json().catch(() => ({}));
        const summary = compactText(data?.candidates?.[0]?.content?.parts?.[0]?.text, 500);
        return summary ? { summary, url } : null;
    } catch {
        return null;
    }
}

function isBasicRobloxIssue(reasonText) {
    const text = String(reasonText || '').toLowerCase();
    if (!text.includes('roblox')) return false;
    // Basic heuristic: if they mention Roblox at all, allow AI assist even without a tag match.
    return true;
}

async function notifyGuildOwnerTrialExpired(guild, aiAccess, storage) {
    if (!guild?.id || !aiAccess?.expiredTrial || aiAccess?.notifiedTrialExpiredAt) return;
    try {
        const owner = await guild.fetchOwner().catch(() => null);
        if (!owner?.user) return;
        const lines = [
            `AI support for **${guild.name}** has been paused because the free AI trial has ended.`,
            '',
            'Pro AI is required to keep automatic AI replies enabled for this server.'
        ];
        await owner.user.send({ content: lines.join('\n') }).catch(() => null);
        ticketStore.setGuildAiAccess(guild.id, {
            notifiedTrialExpiredAt: new Date().toISOString(),
            enabled: false
        }, storage);
    } catch {}
}

async function sendAiPromptedResponse(channel, reasonText) {
    const activeStorage = ticketStore.getActiveStorage();
    const aiControl = ticketStore.getAiControl(activeStorage);
    if (aiControl.manualDisabled) return;

    if (aiControl.rateLimitedUntil) {
        const until = new Date(aiControl.rateLimitedUntil).getTime();
        if (!Number.isNaN(until) && Date.now() < until) return;
        ticketStore.setAiControl({ ...aiControl, rateLimitedUntil: null }, activeStorage);
    }

    const guildAiAccess = ticketStore.getEffectiveGuildAiAccess(channel?.guild?.id || null, activeStorage);
    if (guildAiAccess.expiredTrial) {
        await notifyGuildOwnerTrialExpired(channel?.guild, guildAiAccess, activeStorage);
        return;
    }
    if (!guildAiAccess.hasAccess) return;
    const aiSettings = ticketStore.getGuildAiSettings(channel?.guild?.id || null, activeStorage);
    if (!aiSettings.enabled) return;

    const safeReason = String(reasonText || '').trim();
    const matchedTags = collectTagMatches(safeReason, channel?.guild?.id || null);

    if (!aiSettings.autoLearn && !aiSettings.autoResolution) return;
    if (!matchedTags.length && (!aiSettings.autoResolution || !isBasicRobloxIssue(safeReason))) return;

    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const primaryTag = matchedTags[0] || null;
    const forumLinks = aiSettings.autoResolution && isBasicRobloxIssue(safeReason)
        ? await searchRobloxDevForum(safeReason)
        : [];

    let suggestion = '';
    if (hasGemini) {
        suggestion = String(await getGeminiSuggestion(safeReason, aiSettings.autoLearn ? matchedTags : [], { forumLinks }) || '').trim();
    } else if (aiSettings.autoLearn && primaryTag?.description) {
        suggestion = String(primaryTag.description).trim();
    }

    if (!suggestion && forumLinks.length) {
        suggestion = [
            'I found a few Roblox Developer Forum threads that may be related:',
            ...forumLinks.map(item => `- [${item.title}](${item.url})`),
            '',
            `Search link: ${robloxDevForumSearchUrl(safeReason)}`
        ].join('\n');
    }

    // Do not post AI noise unless there's a tag, forum result, or model returned a real suggestion.
    if (!matchedTags.length && !forumLinks.length && !suggestion) return;

    const responseText = suggestion || String(primaryTag?.description || '').trim();
    if (!responseText) return;

    const responseTitle = String(primaryTag?.title || 'Suggested Response').trim() || 'Suggested Response';
    const quote = (text) => String(text || '')
        .split('\n')
        .map(line => `> ${line}`.trimEnd())
        .join('\n')
        .trim();

    const related = matchedTags.slice(1, 4).map(tag => tag.name).filter(Boolean);
    const body = [
        `**${responseTitle}**`,
        quote(responseText),
        related.length ? `\nRelated tags: ${related.join(', ')}` : ''
    ].filter(Boolean).join('\n');

    const isSolution = !primaryTag || String(primaryTag.kind || '').toLowerCase() === 'solution';
    const buttons = [];
    if (isSolution) {
        buttons.push(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Success)
                .setLabel('My issue has been resolved.')
                .setCustomId(AI_RESOLVED_BUTTON_ID)
        );
    }
    buttons.push(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setLabel('I still require support.')
            .setCustomId(AI_SUPPORT_BUTTON_ID)
    );

    const container = new ContainerBuilder()
        .setAccentColor(0x667EF9)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## <:userrobot:1487431675570032681> AI Suggested Response')
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(body)
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(buttons)
        );

    await channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] }).catch(() => null);
}

async function handleAiConversationMessage(message, ticket, activeStorage = null) {
    const storage = activeStorage || ticketStore.getActiveStorage();
    const guildAiAccess = ticketStore.getEffectiveGuildAiAccess(message?.guild?.id || ticket?.guildId || null, storage);
    if (!guildAiAccess.hasAccess || !['custom', 'custom_trial'].includes(String(guildAiAccess.plan || ''))) return false;
    const aiControl = ticketStore.getAiControl(storage);
    if (aiControl.manualDisabled) return false;
    const aiSettings = ticketStore.getGuildAiSettings(message?.guild?.id || ticket?.guildId || null, storage);
    if (!aiSettings.enabled || !aiSettings.conversation) return false;
    if (ticket?.createdBy && String(ticket.createdBy) !== String(message.author?.id || '')) return false;

    const content = compactText(message.content, 1800);
    const imageAttachments = [...(message.attachments?.values?.() || [])]
        .filter(att => String(att?.contentType || '').toLowerCase().startsWith('image/'))
        .slice(0, 3);
    if (!content && !imageAttachments.length) return false;

    const imageSummaries = [];
    for (const attachment of imageAttachments) {
        const summary = await summarizeImageAttachment(attachment);
        if (summary) imageSummaries.push(summary);
    }

    const entry = ticketStore.appendAiConversation(message.channel.id, {
        messages: content ? [{ role: 'user', content, createdAt: new Date().toISOString() }] : [],
        imageSummaries
    }, storage);
    const contextMessages = Array.isArray(entry?.messages) ? entry.messages.slice(-10) : [];
    const responseText = compactText(await getGeminiSuggestion(content || 'The user uploaded an image.', [], {
        conversation: true,
        contextMessages,
        imageSummaries: Array.isArray(entry?.imageSummaries) ? entry.imageSummaries.slice(-5) : []
    }), 1800);

    if (!responseText) return false;
    ticketStore.appendAiConversation(message.channel.id, {
        messages: [{ role: 'assistant', content: responseText, createdAt: new Date().toISOString() }]
    }, storage);

    const container = new ContainerBuilder()
        .setAccentColor(0x667EF9)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('## <:userrobot:1487431675570032681> AI Assistant'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(responseText));
    await message.channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] }).catch(() => null);
    return true;
}

module.exports = {
    AI_RESOLVED_BUTTON_ID,
    AI_SUPPORT_BUTTON_ID,
    TICKET_REASON_MODAL_PREFIX,
    getEffectiveAvailability,
    normalizeType: ticketStore.normalizeType,
    toTicketSelectValue: ticketStore.toTicketSelectValue,
    loadActiveStorage: ticketStore.getActiveStorage,
    saveActiveStorage: ticketStore.saveActiveStorage,
    loadTicketTypes: ticketStore.getTicketTypes,
    handleAiConversationMessage,

    async createTicket(interaction, ticketType, parentCategoryId, options = {}) {
        const permissionContext = {
            guild: interaction?.guild || null,
            parentInfo: null,
            ticketChannel: null,
            allowAttachments: true
        };
        try {
            if (!interaction.guild) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Context', 'This action can only be used in a server.', 0xED4245));
            }

            const activeStorage = ticketStore.cleanupMissingTicketChannels(interaction.guild);
            const ticketConfig = ticketStore.findTicketType(ticketType, interaction.guildId);
            const matchingTeam = ticketStore.findSupportTeamForTicketType(ticketType, interaction.guildId);
            const teamRoleIds = ticketStore.getSupportTeamRoleIds(matchingTeam)
                .filter(roleId => interaction.guild.roles.cache.has(roleId));
            const allowAttachments = ticketConfig?.allowAttachments !== false;
            permissionContext.allowAttachments = allowAttachments;

            const statusInfo = options.statusInfo || getEffectiveAvailability(activeStorage, ticketType, interaction.guildId);
            const exclusion = ticketStore.getTicketExclusionForUser(interaction.guildId, interaction.user.id, ticketType, activeStorage);
            if (exclusion) {
                const typeText = Array.isArray(exclusion.ticketTypes) && exclusion.ticketTypes.length
                    ? 'this ticket type'
                    : 'tickets';
                const reason = exclusion.reason ? `\n\nReason: ${exclusion.reason}` : '';
                return sendEphemeral(interaction, buildInfoMessage('Exclusion List', `You are currently excluded from opening ${typeText} in this server.${reason}`, 0xED4245));
            }
            const channelName = resolveTicketChannelName(ticketConfig, ticketType, interaction.user, activeStorage, interaction.guildId, {
                ...options,
                statusInfo
            });

            if (!interaction.guild.members.me) {
                await interaction.guild.members.fetchMe().catch(() => null);
            }
            const botMember = interaction.guild.members.me;
            const blockedTeamRoles = botMember
                ? teamRoleIds
                    .map(roleId => interaction.guild.roles.cache.get(roleId))
                    .filter(role => role && role.position >= botMember.roles.highest.position)
                : [];
            if (blockedTeamRoles.length) {
                return sendEphemeral(
                    interaction,
                    buildInfoMessage(
                        'Role Hierarchy Issue',
                        `Move my bot role above these support roles, then try again: **${blockedTeamRoles.map(role => role.name).join(', ')}**.`,
                        0xED4245
                    )
                );
            }
            let parentInfo = await resolveTicketParentCategory(interaction.guild, parentCategoryId);
            permissionContext.parentInfo = parentInfo;
            const permissionCheck = validateCreateTicketPermissions(interaction.guild);
            if (!permissionCheck.ok) {
                console.warn('[Permissions] Ticket creation blocked by missing guild permission:', permissionCheck.message, { guildId: interaction.guildId });
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', permissionCheck.message, 0xED4245));
            }

            if (parentInfo.channel) {
                const categoryPermissions = parentInfo.channel.permissionsFor(botMember);
                if (categoryPermissions && !categoryPermissions.has(PermissionsBitField.Flags.ManageChannels)) {
                    console.warn('[Permissions] Bot lacks ManageChannels in configured category; falling back to create ticket without parent category.', {
                        guildId: interaction.guildId,
                        categoryId: parentInfo.channel.id,
                        categoryName: parentInfo.channel.name
                    });
                    parentInfo = { id: null, channel: null, missing: false };
                    permissionContext.parentInfo = parentInfo;
                }
            }

            if (parentInfo.missing && parentInfo.originalId) {
                console.warn(`[Tickets] Configured ticket category ${parentInfo.originalId} was not found in guild ${interaction.guildId}; creating ticket without a parent category.`);
            }

            const botMemberId = interaction.guild.members.me?.id || interaction.client.user?.id;
            const permissionOverwrites = [];

            if (botMemberId) {
                permissionOverwrites.push({
                    id: botMemberId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.EmbedLinks,
                        PermissionsBitField.Flags.AttachFiles,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.ManageChannels
                    ]
                });
            }

            permissionOverwrites.push(
                { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.AttachFiles] },
                {
                    id: interaction.user.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        ...(allowAttachments ? [PermissionsBitField.Flags.AttachFiles] : [])
                    ]
                }
            );

            for (const roleId of teamRoleIds) {
                permissionOverwrites.push({
                    id: roleId,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.SendMessages,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        ...(allowAttachments ? [PermissionsBitField.Flags.AttachFiles] : [])
                    ]
                });
            }

            const ticketChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: parentInfo.id || null,
                permissionOverwrites
            });
            permissionContext.ticketChannel = ticketChannel;

            const mentionText = teamRoleIds.length ? teamRoleIds.map(roleId => `<@&${roleId}>`).join(' ') : '';
            if (mentionText) {
                await ticketChannel.send({ content: mentionText });
            }

            const openEmbed = resolveOpenTicketEmbed(
                ticketConfig,
                ticketType,
                interaction.user,
                options.reason,
                ticketChannel,
                options.attachments || []
            );
            const mainPanel = buildV2Notice(openEmbed.title, openEmbed.description, 0x5865F2);
            const components = [...mainPanel.components];
            if (statusInfo.status === 'increased_volume' || statusInfo.status === 'reduced_assistance') {
                const meta = getAvailabilityMeta(statusInfo.status);
                components.push(...buildV2Notice(`Availability Notice: ${meta.label}`, meta.notice, 0xFEE75C).components);
            }

            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
            );

            await ticketChannel.send({ flags: MessageFlags.IsComponentsV2, components: [...components, closeRow] });

            if (allowAttachments) {
                const attachmentsContainer = new ContainerBuilder().addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('> You can upload any additional supporting images/files in this ticket (screenshots, videos, receipts, etc).')
                );
                await ticketChannel.send({ flags: MessageFlags.IsComponentsV2, components: [attachmentsContainer] }).catch(() => null);
            }

            const createdAt = new Date().toISOString();
            const nextTicket = {
                guildId: interaction.guildId,
                channelId: ticketChannel.id,
                ticketType,
                createdBy: interaction.user.id,
                transferred: false,
                escalations: [],
                urgentConfirmed: Boolean(options.urgentConfirmed),
                createdAt,
                lastActivityAt: createdAt,
                openReason: options.reason || null,
                openAttachments: Array.isArray(options.attachments) ? options.attachments : [],
                pendingReason: false
            };
            touchTicket(nextTicket, interaction.user.id, createdAt);
            activeStorage.tickets.push(nextTicket);
            ticketStore.saveActiveStorage(activeStorage);
            await updateTicketChannelMetadata(ticketChannel, nextTicket);

            if (options.reason) await sendAiPromptedResponse(ticketChannel, options.reason);

            const createdContainer = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `<:ticket:1487471770406486076> **Ticket Created**\n> Your ticket has been created. View it here: ${ticketChannel}`
                )
            );
            return sendEphemeral(interaction, { flags: MessageFlags.IsComponentsV2, components: [createdContainer] });
        } catch (error) {
            console.error('Error creating ticket:', error);
            if (error?.code === 50013 || error?.status === 403 || error?.code === 50001) {
                console.warn('[Permissions] Ticket creation permission failure:', {
                    guildId: interaction.guildId,
                    channelId: permissionContext.ticketChannel?.id,
                    parentCategoryId: permissionContext.parentInfo?.id,
                    errorCode: error?.code,
                    status: error?.status,
                    message: error?.message
                });
                return sendEphemeral(interaction, {
                    ...buildInfoMessage(
                        'Missing Permissions',
                        describeDiscordPermissionError(
                            error,
                            permissionContext.guild,
                            permissionContext.parentInfo,
                            permissionContext.ticketChannel,
                            permissionContext.allowAttachments
                        ),
                        0xED4245
                    )
                });
            }
            return sendEphemeral(interaction, {
                ...buildInfoMessage('Error', 'There was an error creating your ticket.', 0xED4245)
            });
        }
    },

    async handleCloseRequest(interaction, reason) {
        try {
            const ticketChannel = interaction.channel;
            const activeStorage = ticketStore.getActiveStorage();
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);
            if (!ticket) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Channel', 'This action is only available in an active ticket channel.', 0xED4245));
            }

            if (ticket.createdBy && ticket.createdBy !== interaction.user.id) {
                return sendEphemeral(interaction, buildInfoMessage('Permission Denied', 'Only the ticket opener can close this ticket.', 0xED4245));
            }

            // Button interactions should not create noisy ephemeral confirmations.
            if (typeof interaction.deferUpdate === 'function') {
                await interaction.deferUpdate().catch(() => null);
            } else {
                await ensureEphemeralAck(interaction);
            }

            const safeReason = String(reason || 'Closed by requester.').trim().slice(0, 900);
            await closeRequestCommand.closeTicketWithTranscript(ticketChannel, safeReason, interaction.user.id);
        } catch (error) {
            console.error('Error handling close request:', error);
            await sendEphemeral(interaction, {
                ...buildInfoMessage('Error', 'There was an error while preparing ticket closure.', 0xED4245)
            });
        }
    },

    async createTicketPanel(interaction, options = {}) {
        try {
            const targetChannel = options?.channel || interaction.channel;
            if (!targetChannel || typeof targetChannel.send !== 'function') {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Channel', 'Unable to send the ticket panel to that channel.', 0xED4245));
            }
            if (!interaction.guild?.members?.me) {
                await interaction.guild?.members?.fetchMe?.().catch(() => null);
            }
            const panelPermissionCheck = validateSendPanelPermissions(targetChannel, interaction.guild);
            if (!panelPermissionCheck.ok) {
                console.warn('[Permissions] Ticket panel creation blocked by missing channel permissions:', {
                    guildId: interaction.guildId,
                    channelId: targetChannel?.id,
                    message: panelPermissionCheck.message
                });
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', panelPermissionCheck.message, 0xED4245));
            }

            const supportsV2Panel =
                typeof ContainerBuilder === 'function' &&
                typeof TextDisplayBuilder === 'function' &&
                typeof SeparatorBuilder === 'function' &&
                SeparatorSpacingSize;

            if (!supportsV2Panel) {
                return sendEphemeral(interaction, buildInfoMessage('Error', 'This bot build does not support Components V2 builders yet.', 0xED4245));
            }

            const activeStorage = ticketStore.getActiveStorage();
            const guildConfig = interaction.guildId ? ticketStore.getGuildConfig(interaction.guildId, activeStorage) : {};
            const storedPanel = guildConfig?.panels?.[targetChannel.id] && typeof guildConfig.panels[targetChannel.id] === 'object'
                ? guildConfig.panels[targetChannel.id]
                : {};
            const storedPanelName = String(storedPanel.name || storedPanel.title || '').trim();
            const panelConfig = guildConfig?.panelConfig && typeof guildConfig.panelConfig === 'object' ? guildConfig.panelConfig : {};
            const storedTicketType = String(storedPanel.ticketType || '').trim();
            const directTicketType = storedPanel.mode === 'single' && storedTicketType
                ? ticketStore.resolveTicketTypeSelectValue(storedTicketType, interaction.guildId, activeStorage)
                : '';
            const displayStyle = storedPanel.mode === 'single' ? 'buttons' : resolvePanelDisplayStyle(storedPanel);
            const branding = guildConfig?.branding && typeof guildConfig.branding === 'object' ? guildConfig.branding : {};
            const accentColor = parseHexColor(storedPanel.accentColor || branding.accentColor, 0x5865F2);
            const actionRow = buildOpenSupportRow({
                buttonLabel: options?.buttonLabel || storedPanel.buttonLabel || panelConfig.buttonLabel || 'Select a prompt',
                ticketType: directTicketType
            });
            const panelName = String(options?.panelName || storedPanelName || panelConfig.title || 'Support Desk').trim();
            const panelDescription = String(
                options?.panelDescription ||
                storedPanel.description ||
                panelConfig.description ||
                'Open a ticket when you need help from the team. Choose the topic that best matches your request, add the details we should know, and we will keep the conversation organized from there.'
            ).trim();
            const panelAdvisory = String(
                options?.panelAdvisory ||
                storedPanel.advisory ||
                panelConfig.advisory ||
                '**Before opening a ticket**\n> Share the goal, what you already tried, and any screenshots or files that can help.\n> Ticket history may be saved for moderation, training, and quality review.'
            ).trim();
            const header = `# <:questions:1477710100889079909> ${panelName}`;

            const panelContainer = new ContainerBuilder()
                .setAccentColor(accentColor)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`${header}\n\n${panelDescription}`)
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(panelAdvisory)
                );

            if (displayStyle === 'select') {
                const selectRows = buildTicketTypeSelectRows(interaction.guildId, targetChannel.id);
                if (!selectRows.length) {
                    return sendEphemeral(
                        interaction,
                        buildInfoMessage(
                            'No Ticket Types',
                            'No ticket types are configured yet. Add ticket types in the dashboard or `/setup`, then publish the panel again.',
                            0xFEE75C
                        )
                    );
                }
                for (const row of selectRows) {
                    panelContainer.addActionRowComponents(row);
                }
            } else {
                panelContainer.addActionRowComponents(actionRow);
            }

            await targetChannel.send({
                flags: MessageFlags.IsComponentsV2,
                components: [panelContainer]
            });
            const notice = String(options?.notice || 'Ticket panel has been set up.').trim() || 'Ticket panel has been set up.';
            await sendEphemeral(interaction, buildInfoMessage('Panel Created', notice, 0x57F287));
        } catch (error) {
            console.error('Error creating ticket panel:', error);
            if (error?.code === 50013 || error?.status === 403 || error?.code === 50001) {
                const channel = options?.channel || interaction.channel;
                const check = validateSendPanelPermissions(channel, interaction.guild);
                const message = check.ok
                    ? 'Discord blocked me from posting the panel. Check that I can **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** in that channel.'
                    : check.message;
                console.warn('[Permissions] Ticket panel creation permission failure:', {
                    guildId: interaction.guildId,
                    channelId: channel?.id,
                    errorCode: error?.code,
                    status: error?.status,
                    message: error?.message
                });
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', message, 0xED4245));
            }
            await sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error setting up the ticket panel.', 0xED4245));
        }
    },

    async processTicketTypeSelection(interaction, selectedType, reason = null, extra = {}) {
        // Channel creation and permission setup can exceed Discord's 3s interaction window.
        // Defer ASAP so we don't crash with "Unknown interaction" on slow guilds.
        await ensureEphemeralAck(interaction);

        const restricted = getRestrictedTicketTypeForChannel(interaction);
        if (restricted && restricted !== selectedType) {
            const allowedConfig = ticketStore.findTicketTypeBySelectValue(restricted, interaction.guildId);
            const allowedName = allowedConfig?.name || restricted;
            return sendEphemeral(
                interaction,
                buildInfoMessage('Wrong Channel', `Tickets in this channel can only be opened as **${allowedName}**.`, 0xFEE75C)
            );
        }

        const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
        if (!ticketConfig) {
            return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
        }

        const activeStorage = ticketStore.cleanupMissingTicketChannels(interaction.guild);
        const statusInfo = getEffectiveAvailability(activeStorage, ticketConfig.name, interaction.guildId);

        if (statusInfo.status === 'reduced_assistance') {
            ticketStore.setPendingUrgentReason(interaction.user.id, {
                selectedType,
                reason: reason || 'Marked as urgent by requester.',
                createdAt: new Date().toISOString()
            });

            const urgentRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`urgent-ticket:${selectedType}`).setLabel('This Request Is Urgent').setStyle(ButtonStyle.Danger)
            );

            const base = buildV2Notice(
                `Ticket: ${ticketConfig.name}`,
                'Support for this ticket type is currently in **Reduced Assistance** mode.\n\nIf your request is urgent, please confirm below.',
                0xFEE75C
            );
            return sendEphemeral(interaction, { ...base, components: [...base.components, urgentRow] });
        }

        const parentCategoryId = await resolveParentCategoryId(interaction.guild, ticketConfig);
        const attachments = Array.isArray(extra?.attachments) ? extra.attachments : [];
        return this.createTicket(interaction, ticketConfig.name, parentCategoryId, { statusInfo, reason, attachments });
    },

    async handleOpenSupportFlow(interaction) {
        try {
            const restricted = getRestrictedTicketTypeForChannel(interaction);
            if (restricted) {
                const ticketConfig = ticketStore.findTicketTypeBySelectValue(restricted, interaction.guildId);
                if (!ticketConfig) {
                    return sendEphemeral(interaction, buildInfoMessage('Configuration Error', 'This channel has a ticket type restriction set, but the ticket type no longer exists.', 0xED4245));
                }

                const requireReason = ticketConfig.requireReason !== false;
                if (!requireReason) {
                    return this.processTicketTypeSelection(interaction, restricted, null);
                }

                return this.showTicketReasonModal(interaction, restricted, ticketConfig);
            }

            const rows = buildTicketTypeButtonRows(interaction.guildId);
            if (!rows.length) {
                return sendEphemeral(interaction, buildInfoMessage('No Ticket Types', 'No ticket types are configured yet.', 0xFEE75C));
            }
            const base = buildV2Notice('Select Ticket Type', 'Please select the appropriate ticket type to continue.', 0x5865F2);
            return sendEphemeral(interaction, { ...base, components: [...base.components, ...rows] });
        } catch (error) {
            console.error('Error showing ticket type buttons:', error);
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error showing ticket options.', 0xED4245));
        }
    },

    async handleTicketTypeButton(interaction) {
        try {
            const [, selectedType] = interaction.customId.split(':');
            const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
            if (!ticketConfig) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
            }

            const requireReason = ticketConfig.requireReason !== false;
            if (!requireReason) {
                return this.processTicketTypeSelection(interaction, selectedType, null);
            }

            await this.showTicketReasonModal(interaction, selectedType, ticketConfig);
        } catch (error) {
            console.error('Error handling ticket type button:', error);
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error processing your ticket request.', 0xED4245));
        }
    },

    async showTicketReasonModal(interaction, selectedType, resolvedTicketConfig = null) {
        const ticketConfig = resolvedTicketConfig || ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
        if (!ticketConfig) {
            return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
        }

        const modal = new ModalBuilder()
            .setCustomId(`${TICKET_REASON_MODAL_PREFIX}${selectedType}`)
            .setTitle(`Open ${ticketConfig.name}`);

        const reasonInput = new TextInputBuilder()
            .setCustomId(TICKET_REASON_INPUT_ID)
            .setLabel('Please provide your reason for this ticket')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1024);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        const allowAttachments = ticketConfig.allowAttachments !== false;
        if (allowAttachments) {
            // Discord now supports file uploads inside modals via ComponentType.Label + ComponentType.FileUpload.
            // discord.js doesn't currently expose a builder for these, so we pass raw modal component data.
            const modalData = modal.toJSON();
            modalData.components.push({
                type: ComponentType.Label,
                label: 'File Upload (Optional)',
                description: 'Upload screenshots or other files that help us resolve your request.',
                component: {
                    type: ComponentType.FileUpload,
                    custom_id: TICKET_FILE_UPLOAD_INPUT_ID,
                    min_values: 0,
                    max_values: 10,
                    required: false
                }
            });
            return interaction.showModal(modalData);
        }

        return interaction.showModal(modal);
    },

    async handleTicketReasonSubmit(interaction) {
        try {
            if (!interaction.customId.startsWith(TICKET_REASON_MODAL_PREFIX)) return;
            const selectedType = interaction.customId.replace(TICKET_REASON_MODAL_PREFIX, '');
            const reason = interaction.fields.getTextInputValue(TICKET_REASON_INPUT_ID);

            let attachments = [];
            try {
                const upload = interaction.fields.getField(TICKET_FILE_UPLOAD_INPUT_ID, ComponentType.FileUpload);
                if (upload?.attachments?.size) {
                    attachments = [...upload.attachments.values()].map(att => att?.url).filter(Boolean);
                }
            } catch {
                // Field missing (ticket type may have attachments disabled) or unsupported on older clients.
            }

            return this.processTicketTypeSelection(interaction, selectedType, reason, { attachments });
        } catch (error) {
            console.error('Error handling ticket reason modal:', error);
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error processing your ticket reason.', 0xED4245));
        }
    },

    async handleTicketSelection(interaction) {
        try {
            const selectedType = String(interaction.values?.[0] || '').trim();
            if (!selectedType) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Selection', 'Please choose a ticket type from the menu.', 0xED4245));
            }

            const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
            if (!ticketConfig) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid. Republish the panel after updating ticket types.', 0xED4245));
            }

            const requireReason = ticketConfig.requireReason !== false;
            if (!requireReason) {
                return this.processTicketTypeSelection(interaction, selectedType, null);
            }

            await this.showTicketReasonModal(interaction, selectedType, ticketConfig);
        } catch (error) {
            console.error('Error handling ticket selection:', error);
            if (error?.code === 10062) return null;
            const message = error?.code === 50013 || error?.status === 403
                ? describeDiscordPermissionError(error, interaction.guild, null, interaction.channel)
                : 'There was an error processing your ticket request.';
            return sendEphemeral(interaction, buildInfoMessage('Error', message, 0xED4245));
        }
    },

    async handleUrgentTicketConfirmation(interaction) {
        try {
            const [, selectedType] = interaction.customId.split(':');
            const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
            if (!ticketConfig) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
            }

            const activeStorage = ticketStore.cleanupMissingTicketChannels(interaction.guild);
            const statusInfo = getEffectiveAvailability(activeStorage, ticketConfig.name, interaction.guildId);
            const pendingUrgent = ticketStore.popPendingUrgentReason(interaction.user.id, activeStorage);
            const reason = pendingUrgent && pendingUrgent.selectedType === selectedType
                ? pendingUrgent.reason
                : 'Marked as urgent by requester.';
            const parentCategoryId = await resolveParentCategoryId(interaction.guild, ticketConfig);
            return this.createTicket(interaction, ticketConfig.name, parentCategoryId, {
                statusInfo,
                urgentConfirmed: true,
                reason
            });
        } catch (error) {
            console.error('Error handling urgent ticket confirmation:', error);
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error processing your urgent ticket request.', 0xED4245));
        }
    }
};
