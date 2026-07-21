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
const { buildV2Notice, stripCustomEmoji } = require('../utils/components-v2-messages');
const closeRequestCommand = require('../commands/closerequest');
const { resolveParentCategoryId: resolveDefaultParentCategoryId } = require('../utils/guild-defaults');
const { formatBotPermissionGuide } = require('../utils/permission-messages');
const {
    isUnknownInteractionError,
    safeDeferReply,
    safeReply
} = require('../utils/interaction-responder');

const MANUAL_STATUSES = new Set(['available', 'increased_volume', 'reduced_assistance']);
const INCREASED_THRESHOLD = 10;
const REDUCED_THRESHOLD = 15;
const STATUS_SEVERITY = { available: 0, increased_volume: 1, reduced_assistance: 2 };

const AI_RESOLVED_BUTTON_ID = 'ai_prompt_resolved';
const AI_SUPPORT_BUTTON_ID = 'ai_prompt_support';
const TICKET_REASON_MODAL_PREFIX = 'ticket_reason_modal:';
const TICKET_REASON_INPUT_ID = 'ticket_open_reason';
const TICKET_QUESTION_INPUT_PREFIX = 'ticket_open_question_';
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
const PERMISSION_REPAIR_CACHE_TTL_MS = 60 * 1000;
const permissionRepairCache = new Map();
const AI_NOTICE_TTL_MS = 10 * 60 * 1000;
const aiNoticeCache = new Map();
const AI_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.AI_FETCH_TIMEOUT_MS || 15000));
const AI_MODEL_COOLDOWN_MS = Math.max(60_000, Number(process.env.AI_MODEL_COOLDOWN_MS || 10 * 60 * 1000));
const aiModelFailureCache = new Map();
const AI_SUPPORT_AGENT_NAMES = [
    'Nova',
    'Astra',
    'Echo',
    'Vega',
    'Orion',
    'Lyra',
    'Mira',
    'Sol'
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
            label: 'Reduced Assistance',
            notice: '```ansi\n\u001b[2;31m\u001b[2;42m\u001b[2;46m\u001b[2;47m\u001b[2;40m\u001b[2;33m\u001b[1;33m\u001b[1;31mSupport is currently experiencing high volumes of tickets. Urgent issues only. Describe your issue in detail so we can help you as soon as possible.\u001b[0m\u001b[1;33m\u001b[1;40m\u001b[0m\u001b[2;33m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;40m\u001b[0m\u001b[2;31m\u001b[2;47m\u001b[0m\u001b[2;31m\u001b[2;46m\u001b[0m\u001b[2;31m\u001b[2;42m\u001b[0m\u001b[2;31m\u001b[0m\n```'
        };
    }
    if (status === 'increased_volume') {
        return {
            label: 'Limited Assistance',
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
        answers: reason || 'No answers provided.',
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

function normalizeOpeningQuestions(ticketConfig, guildId, allowAttachments = true) {
    const configured = Array.isArray(ticketConfig?.openQuestions)
        ? ticketConfig.openQuestions
        : (Array.isArray(ticketConfig?.openingQuestions) ? ticketConfig.openingQuestions : []);
    const fallback = [{
        label: 'Please describe why you are opening this ticket',
        placeholder: 'Include what happened, what you tried, and what you need from us.',
        style: 'paragraph',
        required: true
    }];
    const activeStorage = ticketStore.getActiveStorage();
    const access = ticketStore.getEffectiveGuildAiAccess(guildId, activeStorage);
    const paid = Boolean(access?.hasAccess);
    const maxModalInputs = allowAttachments ? 4 : 5;
    const max = paid ? maxModalInputs : 1;
    const source = configured.length ? configured : fallback;

    return source
        .map((question, index) => {
            const raw = typeof question === 'string' ? { label: question } : (question && typeof question === 'object' ? question : {});
            const label = String(raw.label || raw.question || raw.title || fallback[0].label).trim().slice(0, 45);
            if (!label) return null;
            const style = String(raw.style || raw.type || '').toLowerCase() === 'short'
                ? TextInputStyle.Short
                : TextInputStyle.Paragraph;
            const maxLength = Math.max(50, Math.min(1024, Number(raw.maxLength || (style === TextInputStyle.Short ? 240 : 1024))));
            return {
                id: `${TICKET_QUESTION_INPUT_PREFIX}${index}`,
                label,
                placeholder: String(raw.placeholder || '').trim().slice(0, 100),
                required: raw.required === undefined ? true : Boolean(raw.required),
                style,
                maxLength
            };
        })
        .filter(Boolean)
        .slice(0, max);
}

function formatQuestionAnswers(answers) {
    const list = Array.isArray(answers) ? answers : [];
    const lines = list
        .map(item => {
            const label = String(item?.label || 'Question').trim();
            const answer = String(item?.answer || '').trim();
            if (!answer) return null;
            return `**${label}**\n${answer}`;
        })
        .filter(Boolean);
    return lines.join('\n\n');
}

function buildOpenSupportRow(options = {}) {
    const label = String(options?.buttonLabel || 'Select a prompt').trim().slice(0, 80) || 'Select a prompt';
    const ticketType = String(options?.ticketType || '').trim();
    const customId = ticketType ? `open-ticket-type:${ticketType}` : 'p_275287590028972042';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(label)
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

function permissionOverwritePatch(required) {
    const keys = {
        [PermissionsBitField.Flags.ManageChannels]: 'ManageChannels',
        [PermissionsBitField.Flags.ViewChannel]: 'ViewChannel',
        [PermissionsBitField.Flags.SendMessages]: 'SendMessages',
        [PermissionsBitField.Flags.EmbedLinks]: 'EmbedLinks',
        [PermissionsBitField.Flags.ReadMessageHistory]: 'ReadMessageHistory',
        [PermissionsBitField.Flags.AttachFiles]: 'AttachFiles'
    };
    const patch = {};
    for (const permission of required || []) {
        const key = keys[permission];
        if (key) patch[key] = true;
    }
    return patch;
}

function permissionRepairCacheKey(channel, required) {
    return `${channel?.guild?.id || 'guild'}:${channel?.id || 'channel'}:${(required || []).map(String).sort().join(',')}`;
}

async function ensureBotChannelPermissions(channel, options = {}) {
    const guild = channel?.guild || options.guild || null;
    if (!guild || !channel || typeof channel.permissionsFor !== 'function') {
        return { ok: false, repaired: false, message: 'I could not read my permissions for that channel. Please try again in a moment.' };
    }

    if (!guild.members?.me && typeof guild.members?.fetchMe === 'function') {
        await guild.members.fetchMe().catch(() => null);
    }

    const me = guild.members?.me || null;
    if (!me) {
        return { ok: false, repaired: false, message: 'I could not read my server member permissions. Please try again in a moment.' };
    }

    const required = [
        ...new Set([
            ...(Array.isArray(options.required) ? options.required : BOT_TICKET_CHANNEL_PERMISSIONS),
            ...(options.allowAttachments === false ? [] : [PermissionsBitField.Flags.AttachFiles])
        ])
    ];
    let current = channel.permissionsFor(me);
    let missing = getMissingPermissionNames(current, required);
    if (!missing.length) return { ok: true, repaired: false };

    const cacheKey = permissionRepairCacheKey(channel, required);
    const cachedUntil = Number(permissionRepairCache.get(cacheKey) || 0);
    if (cachedUntil > Date.now()) {
        current = channel.permissionsFor(me);
        missing = getMissingPermissionNames(current, required);
        if (!missing.length) return { ok: true, repaired: false, cached: true };
    }

    if (!channel.permissionOverwrites || typeof channel.permissionOverwrites.edit !== 'function') {
        return {
            ok: false,
            repaired: false,
            message: `I am missing **${missing.join(', ')}** in **${channel.name || 'that channel'}**.`
        };
    }

    const canRepair = current?.has?.(PermissionsBitField.Flags.ManageChannels)
        || me.permissions?.has?.(PermissionsBitField.Flags.Administrator)
        || me.permissions?.has?.(PermissionsBitField.Flags.ManageChannels);
    if (!canRepair) {
        return {
            ok: false,
            repaired: false,
            message: `I am missing **${missing.join(', ')}** in **${channel.name || 'that channel'}**, and I cannot repair it because I also need **Manage Channels** there.`
        };
    }

    try {
        await channel.permissionOverwrites.edit(
            me.id,
            permissionOverwritePatch(required),
            { reason: options.reason || 'Repair bot ticket permissions before handling interaction' }
        );
        permissionRepairCache.set(cacheKey, Date.now() + PERMISSION_REPAIR_CACHE_TTL_MS);
        return { ok: true, repaired: true };
    } catch (error) {
        return {
            ok: false,
            repaired: false,
            error,
            message: `I tried to repair my channel permissions but Discord blocked it. Missing: **${missing.join(', ')}**.`
        };
    }
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

async function ensureBotCategoryPermissions(guild, parentInfo, allowAttachments = true) {
    if (!parentInfo?.channel) return { ok: true, repaired: false };
    return ensureBotChannelPermissions(parentInfo.channel, {
        guild,
        allowAttachments,
        required: [
            ...BOT_TICKET_CHANNEL_PERMISSIONS,
            ...(allowAttachments ? [PermissionsBitField.Flags.AttachFiles] : [])
        ],
        reason: 'Repair bot ticket category permissions before ticket creation'
    });
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
    if (custom) return null;
    if (/^:?[a-zA-Z0-9_-]+:?$/.test(emoji)) return null;
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
    return display === 'buttons' ? 'buttons' : 'select';
}

async function sendEphemeral(interaction, payload) {
    return safeReply(interaction, payload).catch(error => {
        if (!isUnknownInteractionError(error)) console.warn('[Interactions] Failed to send ephemeral response:', error?.message || error);
        return null;
    });
}

async function ensureEphemeralAck(interaction) {
    return safeDeferReply(interaction, { flags: MessageFlags.Ephemeral }).catch(error => {
        if (!isUnknownInteractionError(error)) console.warn('[Interactions] Failed to defer interaction:', error?.message || error);
        return false;
    });
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

function normalizeIntentText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/<a?:[a-z0-9_]+:\d{17,20}>/g, ' ')
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isCloseTicketIntent(value) {
    const text = normalizeIntentText(value);
    if (!text) return false;
    if (/\b(don't|dont|do not|not|never)\s+close\b/.test(text)) return false;
    if (/^(close|close ticket|close this ticket|close the ticket|please close|pls close|you can close|can close|ticket can be closed|close it|close now|finish and close|resolved close)$/i.test(text)) return true;
    return /\b(close|shut)\s+(this\s+)?(ticket|case|support)\b/.test(text) ||
        /\b(ticket|case|support)\s+(can\s+be\s+)?(closed|shut)\b/.test(text) ||
        /\bmark\s+(this\s+)?(ticket|case|support)\s+(as\s+)?(closed|resolved)\b/.test(text);
}

function isIssueSolvedIntent(value) {
    const text = normalizeIntentText(value);
    if (!text || isCloseTicketIntent(text)) return false;
    if (/\b(not|isn't|isnt|wasn't|wasnt|still|doesn't|doesnt|didn't|didnt)\s+(fixed|solved|resolved|working|done)\b/.test(text)) return false;
    if (/\b(still|not)\s+(need|needs|needing|require|requires|requiring)\s+(help|support|assistance)\b/.test(text)) return false;
    return /\b(fixed|solved|resolved|works now|working now|all good|that's all|thats all|that worked|that fixed it|issue is gone|problem is gone|no more help needed|don't need help|dont need help)\b/.test(text) ||
        /^(thanks|thank you|ty|cheers|perfect|great|awesome|nice),?\s*(it\s+)?(worked|works|fixed|solved|resolved)\b/.test(text);
}

function randomAiSupportAgentName() {
    const configured = String(process.env.AI_SUPPORT_AGENT_NAMES || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
    const names = configured.length ? configured : AI_SUPPORT_AGENT_NAMES;
    return names[Math.floor(Math.random() * names.length)] || 'Nova';
}

function buildAiSupportIntroMessage(agentName = randomAiSupportAgentName()) {
    const container = new ContainerBuilder()
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## <:userrobot:1487431675570032681> AI Support Agent')
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `Hi there! I'm ${agentName}, and I'll be assisting you today! Please describe your issue and I'll be right with you!\n-# If your problem is solved at any point of the ticket, please say "Close ticket" and I'll sort out all the rest, thanks!`
            )
        );

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

function buildAiClosurePrompt() {
    const closeButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setLabel('Close Ticket')
        .setCustomId(AI_RESOLVED_BUTTON_ID);
    const supportButton = new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Keep Open')
        .setCustomId(AI_SUPPORT_BUTTON_ID);

    const container = new ContainerBuilder()
        .setAccentColor(0x57F287)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## AI Support Agent')
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('It sounds like this issue is solved. If you are finished, say **Close ticket** or press **Close Ticket** and I will close this ticket with the normal transcript.')
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(closeButton, supportButton)
        );

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container]
    };
}

function shouldSendAiSupportIntro(channel, storage = null) {
    const activeStorage = storage || ticketStore.getActiveStorage();
    const guildId = channel?.guild?.id || null;
    const guildAiAccess = ticketStore.getEffectiveGuildAiAccess(guildId, activeStorage);
    if (!guildAiAccess.hasAccess || guildAiAccess.expiredTrial) return false;
    const aiControl = ticketStore.getAiControl(activeStorage);
    if (aiControl.manualDisabled) return false;
    const aiSettings = ticketStore.getGuildAiSettings(guildId, activeStorage);
    return Boolean(aiSettings.enabled && (aiSettings.mode === 'conversation' || aiSettings.conversation));
}

async function sendAiSupportIntro(channel, storage = null) {
    if (!shouldSendAiSupportIntro(channel, storage)) return false;
    await channel.send(buildAiSupportIntroMessage()).catch(() => null);
    return true;
}

function envFlag(name, fallback = false) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return Boolean(fallback);
    return ['1', 'true', 'yes', 'on'].includes(raw);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || AI_FETCH_TIMEOUT_MS)));
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function getGeminiModelCandidates({ vision = false } = {}) {
    const configured = String(process.env.GEMINI_MODEL_CANDIDATES || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    const defaultModel = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim();
    return [...new Set([
        defaultModel,
        ...configured
    ].filter(Boolean))];
}

function getAvailableGeminiModels(options = {}) {
    const now = Date.now();
    return getGeminiModelCandidates(options).filter(model => {
        const blockedUntil = Number(aiModelFailureCache.get(model) || 0);
        return !blockedUntil || blockedUntil <= now;
    });
}

function markGeminiModelFailure(model, response) {
    const status = Number(response?.status || 0);
    if (![401, 403, 404, 429].includes(status)) return;
    const blockedUntil = Date.now() + AI_MODEL_COOLDOWN_MS;
    aiModelFailureCache.set(model, blockedUntil);
}

async function logGeminiFailure(model, response) {
    const status = Number(response?.status || 0);
    let detail = '';
    try {
        const body = await response.clone().json();
        detail = body?.error?.message ? String(body.error.message).slice(0, 220) : '';
    } catch {}
    console.warn('[AI] Gemini request failed:', {
        model,
        status,
        statusText: response?.statusText || '',
        retryAfterSeconds: [401, 403, 404, 429].includes(status) ? Math.round(AI_MODEL_COOLDOWN_MS / 1000) : 0,
        detail
    });
}

function extractInteractionText(interaction) {
    const direct = interaction?.output_text || interaction?.outputText;
    if (direct) return String(direct);
    const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
    const last = steps.at ? steps.at(-1) : steps[steps.length - 1];
    const content = Array.isArray(last?.content) ? last.content : [];
    const text = content.map(part => part?.text || '').filter(Boolean).join('\n');
    return text || null;
}

async function createGeminiInteraction(model, input) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const request = fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
            model,
            store: false,
            input,
            generation_config: {
                temperature: 0.4,
                max_output_tokens: 220,
                thinking_level: 'minimal',
                thinking_summaries: 'none'
            }
        })
    }, AI_FETCH_TIMEOUT_MS).then(async response => {
        if (!response.ok) {
            markGeminiModelFailure(model, response);
            await logGeminiFailure(model, response);
            const error = new Error(`Gemini interaction failed with ${response.status}`);
            error.status = response.status;
            error.aiLogged = true;
            throw error;
        }
        return response.json().catch(() => ({}));
    });
    return Promise.race([
        request,
        new Promise((_, reject) => setTimeout(() => {
            const error = new Error(`Gemini interaction timed out after ${AI_FETCH_TIMEOUT_MS}ms`);
            error.name = 'AbortError';
            reject(error);
        }, AI_FETCH_TIMEOUT_MS))
    ]);
}

function getGeminiErrorStatus(error) {
    return Number(error?.status || error?.code || error?.response?.status || 0);
}

function markGeminiModelFailureFromError(model, error) {
    const status = getGeminiErrorStatus(error);
    if (![401, 403, 404, 429].includes(status)) return;
    aiModelFailureCache.set(model, Date.now() + AI_MODEL_COOLDOWN_MS);
}

async function notifyAiConversationUnavailable(message, reason) {
    const channelId = String(message?.channel?.id || 'unknown');
    const key = `${channelId}:${reason}`;
    const now = Date.now();
    const last = Number(aiNoticeCache.get(key) || 0);
    console.warn('[AI] Conversation unavailable:', {
        reason,
        guildId: message?.guild?.id || null,
        channelId,
        userId: message?.author?.id || null
    });
    if ((now - last) < AI_NOTICE_TTL_MS) return false;
    aiNoticeCache.set(key, now);
    await message.channel?.send?.({
        content: 'AI conversation is temporarily unavailable, but your message has been saved in the ticket. A staff member can continue from here.',
        allowedMentions: { parse: [] }
    }).catch(() => null);
    return true;
}

function robloxDevForumSearchUrl(query) {
    const q = encodeURIComponent(String(query || '').trim().slice(0, 160));
    return q ? `https://devforum.roblox.com/search?q=${q}` : 'https://devforum.roblox.com/';
}

async function searchRobloxDevForum(reasonText) {
    const query = compactText(reasonText, 180).replace(/\broblox\b/ig, '').trim() || compactText(reasonText, 180);
    if (!query) return [];
    try {
        const response = await fetchWithTimeout(`https://devforum.roblox.com/search.json?q=${encodeURIComponent(query)}`, {
            headers: { Accept: 'application/json' }
        }, 8000);
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
        const models = getAvailableGeminiModels();
        if (!models.length) return null;
        const forumLinks = Array.isArray(options.forumLinks) ? options.forumLinks : [];
        const contextMessages = Array.isArray(options.contextMessages) ? options.contextMessages : [];
        const imageSummaries = Array.isArray(options.imageSummaries) ? options.imageSummaries : [];
        const prompt = [
            'You are a Discord support agent for this ticket system. Stay strictly grounded in the user message, recent conversation, saved tags, image summaries, and supplied links.',
            'If the issue is unclear or you do not have enough information, ask exactly one focused follow-up question instead of guessing. Do not invent policies, account actions, prices, refunds, moderation outcomes, or technical facts.',
            'Keep the reply under 120 words. Use plain normal support text. Do not include markdown tables.',
            options.conversation
                ? 'Conversation mode: reply directly to the user as the support agent. Be helpful, specific, and ask one next question if needed. If the user says the issue is solved or your answer fully resolves it, ask them to reply "Close ticket" so the ticket can be closed with a transcript.'
                : matchedTags.length
                    ? 'Suggested-response mode: provide one concise first support response based only on the matched tags and supplied evidence.'
                    : 'Suggested-response mode: provide a cautious first support response only if the user issue is specific. If it is not specific, ask one clarifying question.',
            `Reason: ${reasonText}`,
            `Matching tags: ${matchedTags.map(tag => tag.name).join(', ') || 'none'}`,
            forumLinks.length ? `Roblox Developer Forum results:\n${forumLinks.map(item => `- ${item.title}: ${item.url}`).join('\n')}` : '',
            imageSummaries.length ? `Image upload summaries:\n${imageSummaries.map(item => `- ${item.summary}`).join('\n')}` : '',
            contextMessages.length ? `Recent conversation:\n${contextMessages.map(item => `${item.role}: ${item.content}`).join('\n')}` : ''
        ].join('\n');

        const model = models[0];
        try {
            const interaction = await createGeminiInteraction(model, prompt);
            const text = extractInteractionText(interaction);
            if (text) return text;
        } catch (error) {
            markGeminiModelFailureFromError(model, error);
            if (!error?.aiLogged) {
                console.warn('[AI] Gemini interaction failed:', {
                    model,
                    status: getGeminiErrorStatus(error) || null,
                    retryAfterSeconds: getGeminiErrorStatus(error) ? Math.round(AI_MODEL_COOLDOWN_MS / 1000) : 0,
                    detail: String(error?.message || error).slice(0, 220)
                });
            }
        }
        return null;
    } catch (error) {
        console.warn('[AI] Gemini request error:', error?.name === 'AbortError' ? 'timeout' : (error?.message || error));
        return null;
    }
}

async function summarizeImageAttachment(attachment) {
    const apiKey = process.env.GEMINI_API_KEY;
    const contentType = String(attachment?.contentType || '').toLowerCase();
    const url = String(attachment?.url || '').trim();
    if (!envFlag('AI_IMAGE_SUMMARY_ENABLED', false) || !envFlag('AI_IMAGE_SUMMARY_LEGACY_GENERATE_CONTENT', false)) return null;
    if (!apiKey || !url || !contentType.startsWith('image/')) return null;
    try {
        const response = await fetchWithTimeout(url, {}, 8000);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        for (const model of getAvailableGeminiModels({ vision: true })) {
            const aiResponse = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
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
            if (!aiResponse.ok) {
                markGeminiModelFailure(model, aiResponse);
                await logGeminiFailure(model, aiResponse);
                continue;
            }
            const data = await aiResponse.json().catch(() => ({}));
            const summary = compactText(data?.candidates?.[0]?.content?.parts?.[0]?.text, 500);
            if (summary) return { summary, url };
        }
        return null;
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

function canAttemptAiFirstReply(aiSettings, matchedTags, reasonText, hasGemini) {
    const safeReason = String(reasonText || '').trim();
    if (aiSettings.mode === 'conversation' || aiSettings.conversation) return false;
    if (matchedTags.length) return true;
    if (hasGemini && aiSettings.autoLearn && safeReason.length >= 12) return true;
    if (aiSettings.autoResolution && isBasicRobloxIssue(safeReason)) return true;
    return false;
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
    if (aiSettings.mode === 'conversation' || aiSettings.conversation) return;

    const safeReason = String(reasonText || '').trim();
    const matchedTags = collectTagMatches(safeReason, channel?.guild?.id || null);

    if (!aiSettings.autoLearn && !aiSettings.autoResolution) return;

    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    if (!canAttemptAiFirstReply(aiSettings, matchedTags, safeReason, hasGemini)) return;

    const primaryTag = matchedTags[0] || null;
    const forumLinks = aiSettings.autoResolution && envFlag('AI_EXTERNAL_LOOKUPS_ENABLED', false) && isBasicRobloxIssue(safeReason)
        ? await searchRobloxDevForum(safeReason)
        : [];

    let suggestion = '';
    if (hasGemini && (aiSettings.autoLearn || matchedTags.length || forumLinks.length)) {
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
            new TextDisplayBuilder().setContent('## AI Suggested Response')
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
    if (!guildAiAccess.hasAccess) return false;
    const aiControl = ticketStore.getAiControl(storage);
    if (aiControl.manualDisabled) return false;
    const aiSettings = ticketStore.getGuildAiSettings(message?.guild?.id || ticket?.guildId || null, storage);
    if (!aiSettings.enabled || !(aiSettings.mode === 'conversation' || aiSettings.conversation)) return false;
    if (ticket?.createdBy && String(ticket.createdBy) !== String(message.author?.id || '')) return false;
    if (!process.env.GEMINI_API_KEY) {
        return notifyAiConversationUnavailable(message, 'missing_gemini_api_key');
    }

    const content = compactText(message.content, 1800);
    const imageAttachments = [...(message.attachments?.values?.() || [])]
        .filter(att => String(att?.contentType || '').toLowerCase().startsWith('image/'))
        .slice(0, 3);
    if (!content && !imageAttachments.length) return false;

    if (isCloseTicketIntent(content)) {
        await closeRequestCommand.closeTicketWithTranscript(
            message.channel,
            'Closed by requester using AI support close command.',
            message.author.id
        );
        return true;
    }

    if (isIssueSolvedIntent(content)) {
        await message.channel?.send?.(buildAiClosurePrompt()).catch(() => null);
        return true;
    }

    const imageSummaries = [];
    for (const attachment of imageAttachments) {
        const summary = await summarizeImageAttachment(attachment);
        if (summary) imageSummaries.push(summary);
    }

    const imageOnlyNotice = imageAttachments.length && !imageSummaries.length
        ? `[User uploaded ${imageAttachments.length === 1 ? 'an image' : `${imageAttachments.length} images`}. Ask them to describe the relevant details if needed.]`
        : '';
    const userContent = [
        content,
        imageSummaries.length
            ? `[Image summary: ${imageSummaries.map(item => item.summary).join(' | ')}]`
            : imageOnlyNotice
    ].filter(Boolean).join('\n');

    const entry = ticketStore.appendAiConversation(message.channel.id, {
        messages: userContent ? [{ role: 'user', content: userContent, createdAt: new Date().toISOString() }] : [],
        imageSummaries
    }, storage);
    const contextMessages = Array.isArray(entry?.messages) ? entry.messages.slice(-10) : [];
    await message.channel?.sendTyping?.().catch(() => null);
    const responseText = compactText(await getGeminiSuggestion(userContent || 'The user uploaded an image.', [], {
        conversation: true,
        contextMessages,
        imageSummaries: Array.isArray(entry?.imageSummaries) ? entry.imageSummaries.slice(-5) : []
    }), 1800);

    if (!responseText) {
        return notifyAiConversationUnavailable(message, 'empty_model_response');
    }
    ticketStore.appendAiConversation(message.channel.id, {
        messages: [{ role: 'assistant', content: responseText, createdAt: new Date().toISOString() }]
    }, storage);

    await message.reply({ content: responseText, allowedMentions: { repliedUser: false } }).catch(() => null);
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
    isCloseTicketIntent,
    isIssueSolvedIntent,
    buildAiSupportIntroMessage,

    async createTicket(interaction, ticketType, parentCategoryId, options = {}) {
        const permissionContext = {
            guild: interaction?.guild || null,
            parentInfo: null,
            ticketChannel: null,
            allowAttachments: true
        };
        try {
            await ensureEphemeralAck(interaction);
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
                const repair = await ensureBotCategoryPermissions(interaction.guild, parentInfo, allowAttachments);
                if (!repair.ok) {
                    console.warn('[Permissions] Could not repair configured ticket category; creating ticket without parent category.', {
                        guildId: interaction.guildId,
                        categoryId: parentInfo.channel.id,
                        categoryName: parentInfo.channel.name,
                        message: repair.message,
                        errorCode: repair.error?.code,
                        errorStatus: repair.error?.status
                    });
                    parentInfo = { id: null, channel: null, missing: false };
                    permissionContext.parentInfo = parentInfo;
                }
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

            const channelRepair = await ensureBotChannelPermissions(ticketChannel, {
                allowAttachments,
                reason: 'Ensure bot can manage newly created ticket channel'
            });
            if (!channelRepair.ok) {
                console.warn('[Permissions] Newly created ticket channel is missing bot permissions:', {
                    guildId: interaction.guildId,
                    channelId: ticketChannel.id,
                    message: channelRepair.message,
                    errorCode: channelRepair.error?.code,
                    errorStatus: channelRepair.error?.status
                });
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', channelRepair.message, 0xED4245));
            }

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
                openQuestionAnswers: Array.isArray(options.questionAnswers) ? options.questionAnswers : [],
                openAttachments: Array.isArray(options.attachments) ? options.attachments : [],
                pendingReason: false
            };
            touchTicket(nextTicket, interaction.user.id, createdAt);
            activeStorage.tickets.push(nextTicket);
            ticketStore.saveActiveStorage(activeStorage);
            await updateTicketChannelMetadata(ticketChannel, nextTicket);
            await sendAiSupportIntro(ticketChannel, activeStorage).catch(error => {
                console.warn('[AI] Intro message failed:', error?.message || error);
            });

            const createdContainer = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Ticket Created**\n> Your ticket has been created. View it here: ${ticketChannel}`
                )
            );
            await sendEphemeral(interaction, { flags: MessageFlags.IsComponentsV2, components: [createdContainer] });

            if (options.reason) {
                sendAiPromptedResponse(ticketChannel, options.reason).catch(error => {
                    console.warn('[AI] Prompted ticket response failed:', error?.message || error);
                });
            }
            return null;
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
            // A close button can trigger transcript generation and channel deletion.
            // Acknowledge immediately, then do the slower work.
            await ensureEphemeralAck(interaction);

            const ticketChannel = interaction.channel;
            const permissionRepair = await ensureBotChannelPermissions(ticketChannel, {
                allowAttachments: true,
                reason: 'Ensure bot can close ticket channel'
            });
            if (!permissionRepair.ok) {
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', permissionRepair.message, 0xED4245));
            }
            const activeStorage = ticketStore.getActiveStorage();
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);
            if (!ticket) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Channel', 'This action is only available in an active ticket channel.', 0xED4245));
            }

            if (ticket.createdBy && ticket.createdBy !== interaction.user.id) {
                return sendEphemeral(interaction, buildInfoMessage('Permission Denied', 'Only the ticket opener can close this ticket.', 0xED4245));
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
            const panelRepair = await ensureBotChannelPermissions(targetChannel, {
                allowAttachments: false,
                required: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.EmbedLinks,
                    PermissionsBitField.Flags.ReadMessageHistory
                ],
                reason: 'Ensure bot can publish ticket panel'
            });
            if (!panelRepair.ok) {
                console.warn('[Permissions] Ticket panel creation could not repair channel permissions:', {
                    guildId: interaction.guildId,
                    channelId: targetChannel?.id,
                    message: panelRepair.message,
                    errorCode: panelRepair.error?.code,
                    errorStatus: panelRepair.error?.status
                });
                return sendEphemeral(interaction, buildInfoMessage('Missing Permissions', panelRepair.message, 0xED4245));
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
            const header = `# ${stripCustomEmoji(panelName)}`;

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
            if (isUnknownInteractionError(error)) return null;
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error processing your ticket request.', 0xED4245));
        }
    },

    async showTicketReasonModal(interaction, selectedType, resolvedTicketConfig = null) {
        if (interaction?.deferred || interaction?.replied) {
            return sendEphemeral(interaction, buildInfoMessage('Ticket Request', 'This ticket request was already acknowledged. Please press the ticket button again.', 0xFEE75C));
        }

        const ticketConfig = resolvedTicketConfig || ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
        if (!ticketConfig) {
            return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
        }

        const modal = new ModalBuilder()
            .setCustomId(`${TICKET_REASON_MODAL_PREFIX}${selectedType}`)
            .setTitle(`Open ${ticketConfig.name}`);

        const allowAttachments = ticketConfig.allowAttachments !== false;
        const questions = normalizeOpeningQuestions(ticketConfig, interaction.guildId, allowAttachments);
        for (const question of questions) {
            const input = new TextInputBuilder()
                .setCustomId(question.id)
                .setLabel(question.label)
                .setStyle(question.style)
                .setRequired(question.required)
                .setMaxLength(question.maxLength);
            if (question.placeholder) input.setPlaceholder(question.placeholder);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
        }

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
            return interaction.showModal(modalData).catch(error => {
                if (isUnknownInteractionError(error)) {
                    console.warn('[Tickets] Ticket modal interaction expired before Discord accepted it.', {
                        guildId: interaction.guildId || null,
                        channelId: interaction.channelId || null,
                        userId: interaction.user?.id || null,
                        selectedType
                    });
                    return null;
                }
                throw error;
            });
        }

        return interaction.showModal(modal).catch(error => {
            if (isUnknownInteractionError(error)) {
                console.warn('[Tickets] Ticket modal interaction expired before Discord accepted it.', {
                    guildId: interaction.guildId || null,
                    channelId: interaction.channelId || null,
                    userId: interaction.user?.id || null,
                    selectedType
                });
                return null;
            }
            throw error;
        });
    },

    async handleTicketReasonSubmit(interaction) {
        try {
            if (!interaction.customId.startsWith(TICKET_REASON_MODAL_PREFIX)) return;
            const selectedType = interaction.customId.replace(TICKET_REASON_MODAL_PREFIX, '');
            const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
            const allowAttachments = ticketConfig?.allowAttachments !== false;
            const questions = normalizeOpeningQuestions(ticketConfig, interaction.guildId, allowAttachments);
            const answers = questions.map(question => {
                let answer = '';
                try {
                    answer = interaction.fields.getTextInputValue(question.id);
                } catch {
                    if (question.id !== TICKET_REASON_INPUT_ID) {
                        try { answer = interaction.fields.getTextInputValue(TICKET_REASON_INPUT_ID); } catch {}
                    }
                }
                return { label: question.label, answer: String(answer || '').trim() };
            }).filter(item => item.answer);
            const reason = formatQuestionAnswers(answers) || 'No reason provided.';

            let attachments = [];
            try {
                const upload = interaction.fields.getField(TICKET_FILE_UPLOAD_INPUT_ID, ComponentType.FileUpload);
                if (upload?.attachments?.size) {
                    attachments = [...upload.attachments.values()].map(att => att?.url).filter(Boolean);
                }
            } catch {
                // Field missing (ticket type may have attachments disabled) or unsupported on older clients.
            }

            return this.processTicketTypeSelection(interaction, selectedType, reason, { attachments, questionAnswers: answers });
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
            if (isUnknownInteractionError(error)) return null;
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
