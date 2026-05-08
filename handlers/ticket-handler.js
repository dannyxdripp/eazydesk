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
    PermissionsBitField,
    ChannelType,
    ComponentType
} = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { touchTicket, updateTicketChannelMetadata } = require('../utils/ticket-metadata');
const { buildV2Notice } = require('../utils/components-v2-messages');
const closeRequestCommand = require('../commands/closerequest');
const { resolveParentCategoryId: resolveDefaultParentCategoryId } = require('../utils/guild-defaults');

const MANUAL_STATUSES = new Set(['available', 'increased_volume', 'reduced_assistance']);
const INCREASED_THRESHOLD = 10;
const REDUCED_THRESHOLD = 15;
const STATUS_SEVERITY = { available: 0, increased_volume: 1, reduced_assistance: 2 };

const AI_RESOLVED_BUTTON_ID = 'ai_prompt_resolved';
const AI_SUPPORT_BUTTON_ID = 'ai_prompt_support';
const TICKET_REASON_MODAL_PREFIX = 'ticket_reason_modal:';
const TICKET_REASON_INPUT_ID = 'ticket_open_reason';
const TICKET_FILE_UPLOAD_INPUT_ID = 'ticket_open_files';

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

function buildOpenSupportRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('p_275287590028972042')
            .setLabel('Select a prompt')
            .setEmoji({ id: '1477691338718974194', name: 'headset', animated: false })
            .setStyle(ButtonStyle.Secondary)
    );
}

function resolveParentCategoryId(guild, ticketConfig) {
    const configured = String(ticketConfig?.categoryId || '').trim();
    const guildDefault = resolveDefaultParentCategoryId(guild?.id);

    const candidates = [configured, guildDefault].filter(Boolean);
    for (const id of candidates) {
        if (!guild?.channels?.cache) return id;
        const ch = guild.channels.cache.get(id);
        if (!ch) return id;
        if (ch.type === ChannelType.GuildCategory) return id;
    }
    return configured || guildDefault || null;
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

async function getGeminiSuggestion(reasonText, matchedTags) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        const prompt = [
            'You are a formal support assistant for a Discord server.',
            'Provide a concise suggested response based on the user reason and matching tags.',
            `Reason: ${reasonText}`,
            `Matching tags: ${matchedTags.map(tag => tag.name).join(', ') || 'none'}`
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

function isBasicRobloxIssue(reasonText) {
    const text = String(reasonText || '').toLowerCase();
    if (!text.includes('roblox')) return false;
    // Basic heuristic: if they mention Roblox at all, allow AI assist even without a tag match.
    return true;
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

    const safeReason = String(reasonText || '').trim();
    const matchedTags = collectTagMatches(safeReason, channel?.guild?.id || null);

    if (!matchedTags.length && !isBasicRobloxIssue(safeReason)) return;

    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const primaryTag = matchedTags[0] || null;

    let suggestion = '';
    if (hasGemini) {
        suggestion = String(await getGeminiSuggestion(safeReason, matchedTags) || '').trim();
    } else if (primaryTag?.description) {
        suggestion = String(primaryTag.description).trim();
    }

    // Do not post AI noise unless there's a tag to anchor the response, or the model returned a real suggestion.
    if (!matchedTags.length && !suggestion) return;

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

    async createTicket(interaction, ticketType, parentCategoryId, options = {}) {
        try {
            if (!interaction.guild) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Context', 'This action can only be used in a server.', 0xED4245));
            }

            const activeStorage = ticketStore.cleanupMissingTicketChannels(interaction.guild);
            const ticketConfig = ticketStore.findTicketType(ticketType, interaction.guildId);
            const matchingTeam = ticketStore.findSupportTeamForTicketType(ticketType, interaction.guildId);
            const teamRoleIds = ticketStore.getSupportTeamRoleIds(matchingTeam);
            const allowAttachments = ticketConfig?.allowAttachments !== false;

            const suffix = Date.now().toString(36).slice(-4);
            const channelName = `ticket-${interaction.user.username}-${suffix}`
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .slice(0, 95);

            const permissionOverwrites = [
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
            ];

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
                parent: parentCategoryId || null,
                permissionOverwrites
            });

            const statusInfo = options.statusInfo || getEffectiveAvailability(activeStorage, ticketType, interaction.guildId);
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

            const actionRow = buildOpenSupportRow();
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
            const storedPanelName = String(guildConfig?.panels?.[targetChannel.id]?.name || '').trim();
            const panelConfig = guildConfig?.panelConfig && typeof guildConfig.panelConfig === 'object' ? guildConfig.panelConfig : {};
            const panelName = String(options?.panelName || storedPanelName || panelConfig.title || 'Support Desk').trim();
            const panelDescription = String(
                options?.panelDescription ||
                panelConfig.description ||
                `> At Codex Customs, we are committed to providing high quality support to all customers, regardless of their needs therefore we have a support system for customers to contact our dedicated team when in need.\n\n> If you're needing to contact support, please click the "select a prompt" button below & select which option best fits your needs to get in touch with us. Please remain patient throughout the whole process; a response from us may take up to 24 hours.`
            ).trim();
            const panelAdvisory = String(
                options?.panelAdvisory ||
                panelConfig.advisory ||
                `**Advisories:**\n> All tickets are monitored and logged for training and security purposes.\n> By opening a ticket, you are agreeing to our https://discord.com/channels/1327842668734185492/1327846022159929474`
            ).trim();
            const header = `# <:questions:1477710100889079909> ${panelName}`;

            const components = [
                new ContainerBuilder()
                    .setAccentColor(0x5865F2)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`${header}\n\n${panelDescription}`)
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
                    )
                    .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(panelAdvisory)
            )
            ];

            await targetChannel.send({
                flags: MessageFlags.IsComponentsV2,
                components: [...components, actionRow]
            });
            const notice = String(options?.notice || 'Ticket panel has been set up.').trim() || 'Ticket panel has been set up.';
            await sendEphemeral(interaction, buildInfoMessage('Panel Created', notice, 0x57F287));
        } catch (error) {
            console.error('Error creating ticket panel:', error);
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

        const parentCategoryId = resolveParentCategoryId(interaction.guild, ticketConfig);
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
            const selectedType = interaction.values[0];
            const ticketConfig = ticketStore.findTicketTypeBySelectValue(selectedType, interaction.guildId);
            if (!ticketConfig) {
                return sendEphemeral(interaction, buildInfoMessage('Invalid Ticket Type', 'The selected ticket type is not valid.', 0xED4245));
            }

            const requireReason = ticketConfig.requireReason !== false;
            if (!requireReason) {
                return this.processTicketTypeSelection(interaction, selectedType, null);
            }

            return this.showTicketReasonModal(interaction, selectedType, ticketConfig);
        } catch (error) {
            console.error('Error handling ticket selection:', error);
            return sendEphemeral(interaction, buildInfoMessage('Error', 'There was an error processing your ticket request.', 0xED4245));
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
            const parentCategoryId = resolveParentCategoryId(interaction.guild, ticketConfig);
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
