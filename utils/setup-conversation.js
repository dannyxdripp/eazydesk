const { PermissionsBitField, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ticketStore = require('./ticket-store');
const { getPublicBaseUrl } = require('./public-url');
const ticketHandler = require('../handlers/ticket-handler');

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

const STEPS = [
    { key: 'categoryId', prompt: 'Reply with the ticket category ID or mention, or type `skip` to use the server default.' },
    { key: 'transcriptsChannelId', prompt: 'Reply with the transcript channel ID or mention, or type `skip`.' },
    { key: 'managerRoleId', prompt: 'Reply with the manager role ID or mention, or type `skip`.' },
    { key: 'panelChannelId', prompt: 'Reply with the channel where I should post the ticket panel, or type `skip`.' },
    { key: 'ticketTypeName', prompt: 'Reply with the first ticket type name, for example `General Support`.' },
    { key: 'supportRoleIds', prompt: 'Reply with support role IDs or mentions separated by spaces, or type `skip`.' }
];

function sessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function canRun(member, guildConfig = {}) {
    if (!member) return false;
    const perms = member.permissions;
    if (perms?.has?.(PermissionsBitField.Flags.ManageGuild) || perms?.has?.(PermissionsBitField.Flags.Administrator)) return true;
    const managerRoleId = String(guildConfig.managerRoleId || '').trim();
    return Boolean(managerRoleId && member.roles?.cache?.has?.(managerRoleId));
}

function canOverrideCompletedSetup(interaction) {
    const ownerId = String(process.env.BOT_OWNER_ID || process.env.OWNER_USER_ID || process.env.OWNER_ID || '').trim();
    return Boolean(
        interaction?.guild?.ownerId === interaction?.user?.id ||
        (ownerId && ownerId === interaction?.user?.id)
    );
}

function extractSnowflakes(content) {
    return [...String(content || '').matchAll(/\d{17,20}/g)].map(match => match[0]);
}

function readSingleId(content) {
    const text = String(content || '').trim();
    if (!text || /^skip$/i.test(text) || /^none$/i.test(text)) return null;
    return extractSnowflakes(text)[0] || null;
}

async function sendPrompt(channel, session) {
    const step = STEPS[session.step];
    if (!step) return;
    await channel.send({
        content: [
            `**Setup ${session.step + 1}/${STEPS.length}**`,
            step.prompt,
            '',
            'Type `cancel` to stop setup.'
        ].join('\n')
    }).catch(() => null);
}

function buildDashboardRow(guildId) {
    const baseUrl = getPublicBaseUrl();
    if (!/^https?:\/\//i.test(String(baseUrl || '').trim())) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Open Dashboard')
            .setURL(`${baseUrl}/dashboard?guild=${encodeURIComponent(guildId)}`),
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Web Setup')
            .setURL(`${baseUrl}/setup?guild=${encodeURIComponent(guildId)}&page=1`)
    );
}

function buildDashboardComponents(guildId) {
    const row = buildDashboardRow(guildId);
    return row ? [row] : [];
}

async function start(interaction) {
    const guildId = interaction.guildId;
    const activeStorage = ticketStore.getActiveStorage();
    const guildConfig = ticketStore.bootstrapGuildConfig(guildId, { storage: activeStorage }) || ticketStore.getGuildConfig(guildId, activeStorage);
    if (!canRun(interaction.member, guildConfig)) {
        return interaction.reply({ content: 'You need Manage Server permission, Administrator, or the configured manager role to run setup.', flags: MessageFlags.Ephemeral });
    }
    if (guildConfig?.setup?.completed && !canOverrideCompletedSetup(interaction)) {
        return interaction.reply({ content: 'Setup is already complete for this server. Ask the server owner to unlock setup from the dashboard if it needs to be rerun.', flags: MessageFlags.Ephemeral });
    }

    const key = sessionKey(guildId, interaction.user.id);
    sessions.set(key, {
        guildId,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        step: 0,
        answers: {},
        startedAt: Date.now(),
        updatedAt: Date.now()
    });

    await interaction.reply({
        content: 'Setup started. I will ask for one thing at a time in this channel. Reply to each prompt with an ID, mention, or `skip`.',
        flags: MessageFlags.Ephemeral,
        components: buildDashboardComponents(guildId)
    });
    await sendPrompt(interaction.channel, sessions.get(key));
}

async function finish(message, session) {
    const activeStorage = ticketStore.getActiveStorage();
    const current = ticketStore.getGuildConfig(session.guildId, activeStorage);
    const ticketTypeName = String(session.answers.ticketTypeName || 'General Support').trim().slice(0, 80) || 'General Support';
    const supportRoleIds = Array.isArray(session.answers.supportRoleIds) ? session.answers.supportRoleIds : [];
    const ticketTypes = ticketStore.getTicketTypesForGuild(session.guildId, activeStorage);
    const existingType = ticketTypes.find(type => ticketStore.normalizeType(type.name) === ticketStore.normalizeType(ticketTypeName));
    const nextTicketTypes = existingType
        ? ticketTypes
        : [...ticketTypes, {
            name: ticketTypeName,
            emoji: '',
            categoryId: session.answers.categoryId || current.categoryId || null,
            requireReason: true,
            allowAttachments: true
        }];
    ticketStore.saveTicketTypesForGuild(session.guildId, nextTicketTypes, activeStorage);

    const supportTeams = ticketStore.getSupportTeamsForGuild(session.guildId, activeStorage);
    const existingTeam = supportTeams.find(team => ticketStore.normalizeType(team.name) === ticketStore.normalizeType(ticketTypeName));
    if (!existingTeam && supportRoleIds.length) {
        ticketStore.saveSupportTeamsForGuild(session.guildId, [...supportTeams, {
            name: ticketTypeName,
            emoji: '',
            roleIds: supportRoleIds
        }], activeStorage);
    }

    const panels = current.panels && typeof current.panels === 'object' ? current.panels : {};
    if (session.answers.panelChannelId) {
        panels[session.answers.panelChannelId] = {
            name: 'Support Desk',
            title: 'Support Desk',
            mode: 'multi',
            displayStyle: 'buttons',
            buttonLabel: 'Open a ticket',
            description: 'Need help? Use the button below to open a ticket.',
            advisory: 'Please include enough detail for staff to help you quickly.'
        };
    }

    ticketStore.setGuildConfig(session.guildId, {
        parentCategoryId: session.answers.categoryId || current.parentCategoryId || null,
        transcriptsChannelId: session.answers.transcriptsChannelId || current.transcriptsChannelId || null,
        managerRoleId: session.answers.managerRoleId || current.managerRoleId || null,
        panels,
        setup: { completed: true, step: 4, completedAt: new Date().toISOString(), source: 'discord-message-flow' }
    }, activeStorage);

    let panelPosted = false;
    if (session.answers.panelChannelId) {
        const targetChannel = await message.guild.channels.fetch(session.answers.panelChannelId).catch(() => null);
        if (targetChannel && typeof targetChannel.send === 'function') {
            const fakeInteraction = {
                guildId: session.guildId,
                channelId: message.channel.id,
                guild: message.guild,
                channel: message.channel,
                user: message.author,
                replied: false,
                deferred: false,
                reply: async () => null,
                editReply: async () => null
            };
            await ticketHandler.createTicketPanel(fakeInteraction, {
                channel: targetChannel,
                notice: 'Setup is complete and the ticket panel has been posted.'
            }).catch(() => null);
            panelPosted = true;
        }
    }

    sessions.delete(sessionKey(session.guildId, session.userId));
    await message.channel.send({
        content: panelPosted
            ? 'Setup is complete and the ticket panel has been posted. You can fine-tune ticket types, panels, and exclusions from the dashboard.'
            : 'Setup is complete. You can fine-tune ticket types, panels, and exclusions from the dashboard.',
        components: buildDashboardComponents(session.guildId)
    }).catch(() => null);
}

async function handleMessage(message) {
    if (!message?.guild || message.author?.bot) return false;
    const key = sessionKey(message.guild.id, message.author.id);
    const session = sessions.get(key);
    if (!session) return false;
    if (session.channelId !== message.channel.id) return false;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
        sessions.delete(key);
        await message.reply('Setup expired. Run `/setup` again when you are ready.').catch(() => null);
        return true;
    }

    const content = String(message.content || '').trim();
    if (/^cancel$/i.test(content)) {
        sessions.delete(key);
        await message.reply('Setup cancelled.').catch(() => null);
        return true;
    }

    const step = STEPS[session.step];
    if (!step) return false;

    if (step.key === 'ticketTypeName') {
        session.answers.ticketTypeName = content.slice(0, 80) || 'General Support';
    } else if (step.key === 'supportRoleIds') {
        session.answers.supportRoleIds = /^skip$/i.test(content) ? [] : [...new Set(extractSnowflakes(content))];
    } else {
        session.answers[step.key] = readSingleId(content);
    }

    session.step += 1;
    session.updatedAt = Date.now();
    if (session.step >= STEPS.length) {
        await finish(message, session);
        return true;
    }

    await sendPrompt(message.channel, session);
    return true;
}

module.exports = {
    start,
    handleMessage
};
