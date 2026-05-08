const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate, buildV2Notice } = require('../utils/components-v2-messages');
const { resolveEscalationRoleId } = require('../utils/guild-defaults');

const RESPONSES = {
    invalidChannelTitle: 'Invalid Channel',
    invalidChannelDescription: 'This command can only be used in ticket channels.',
    deniedTitle: 'Permission Denied',
    deniedDescription: 'Only configured ticket staff or managers can escalate tickets.',
    invalidEscalationTitle: 'Invalid Escalation',
    invalidEscalationDescription: 'Invalid escalation level.',
    escalatedTitle: 'Ticket Escalated',
    updatedTitle: 'Escalation Updated',
    updatedDescription: 'Ticket escalated to {level} successfully.'
};

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function hasEscalationPermission(interaction, ticket) {
    const guildConfig = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(interaction.guildId) : {};
    const managerRoleId = String(guildConfig?.managerRoleId || '').trim();
    const supportRoleIds = ticketStore.getSupportTeamRoleIds(ticketStore.findSupportTeamForTicketType(ticket?.ticketType, interaction.guildId));
    if (managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId)) return true;
    if (supportRoleIds.some(roleId => interaction.member?.roles?.cache?.has(roleId))) return true;
    return Boolean(
        interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
    );
}

function getEscalationRoleId(guildId, level) {
    return resolveEscalationRoleId(guildId, level);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('escalate')
        .setDescription('Escalate a ticket to a specific priority level')
        .addStringOption(option =>
            option.setName('level')
                .setDescription('Priority level to escalate to')
                .setRequired(true)
                .addChoices(
                    { name: 'Medium Priority', value: 'medium' },
                    { name: 'High Priority', value: 'high' },
                    { name: 'Immediate Response', value: 'immediate' }
                )
        ),
    async execute(interaction) {
        const ticketChannel = interaction.channel;
        const level = interaction.options.getString('level');

        const activeStorage = ticketStore.getActiveStorage();
        const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);

        if (!ticket) {
            const base = buildMessage(RESPONSES.invalidChannelTitle, RESPONSES.invalidChannelDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        if (!hasEscalationPermission(interaction, ticket)) {
            const base = buildMessage(RESPONSES.deniedTitle, RESPONSES.deniedDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        let color, description;

        switch (level) {
            case 'medium':
                color = 0xFFFF00; // Yellow
                description = 'This ticket has been escalated to Medium Priority.';
                break;
            case 'high':
                color = 0xFF0000; // Red
                description = 'This ticket has been escalated to High Priority.';
                break;
            case 'immediate':
                color = 0xFFFFFF; // White
                description = 'This ticket has been escalated to Immediate Response. Immediate action required!';
                break;
            default:
                {
                    const base = buildMessage(RESPONSES.invalidEscalationTitle, RESPONSES.invalidEscalationDescription, 0xED4245);
                    return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
                }
        }

        let escalationPing = null;
        if (level === 'high') {
            const roleId = getEscalationRoleId(interaction.guildId, 'high');
            if (roleId) escalationPing = `<@&${roleId}>`;
        }
        if (level === 'immediate') {
            const roleId = getEscalationRoleId(interaction.guildId, 'immediate');
            if (roleId) escalationPing = `<@&${roleId}>`;
        }

        await ticketChannel.send(buildV2Notice(
            RESPONSES.escalatedTitle,
            escalationPing ? `${escalationPing}\n\n${description}` : description,
            color
        ));

        // Update active storage to reflect the escalation
        ticket.escalations.push({ level, escalatedBy: interaction.user.id, timestamp: new Date().toISOString() });
        ticketStore.saveActiveStorage(activeStorage);

        {
            const base = buildMessage(RESPONSES.updatedTitle, RESPONSES.updatedDescription.replace('{level}', level.replace(/\b\w/g, l => l.toUpperCase())), 0x57F287);
            await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }
    },
};
