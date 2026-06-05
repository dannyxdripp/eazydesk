const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');

function canManage(interaction) {
    return Boolean(
        interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
    );
}

function typeLabel(value, guildId) {
    const type = ticketStore.findTicketTypeBySelectValue(value, guildId);
    return type?.name || value;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('exclusion')
        .setDescription('Manage the ticket exclusion list')
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Exclude a user from all tickets or one ticket type')
                .addUserOption(option =>
                    option.setName('user').setDescription('User to exclude from opening tickets').setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('ticket_type').setDescription('Ticket type name; leave empty to block all ticket types').setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('reason').setDescription('Optional internal reason').setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a user from the exclusion list')
                .addUserOption(option =>
                    option.setName('user').setDescription('User to allow again').setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('Show the current exclusion list')
        ),

    async execute(interaction) {
        if (!canManage(interaction)) {
            return interaction.reply({ content: 'You need Manage Server permission to manage the exclusion list.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        const activeStorage = ticketStore.getActiveStorage();

        if (subcommand === 'add') {
            const user = interaction.options.getUser('user', true);
            const ticketTypeInput = String(interaction.options.getString('ticket_type') || '').trim();
            const ticketTypes = ticketTypeInput ? [ticketTypeInput] : [];
            const entry = ticketStore.upsertExclusionForGuild(interaction.guildId, {
                userId: user.id,
                ticketTypes,
                reason: interaction.options.getString('reason') || '',
                createdBy: interaction.user.id
            }, activeStorage);
            if (!entry) {
                return interaction.reply({ content: 'I could not save that exclusion. Check the ticket type name and try again.', flags: MessageFlags.Ephemeral });
            }
            const scope = entry.ticketTypes.length
                ? entry.ticketTypes.map(value => typeLabel(value, interaction.guildId)).join(', ')
                : 'all ticket types';
            return interaction.reply({ content: `${user} has been added to the exclusion list for **${scope}**.`, flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'remove') {
            const user = interaction.options.getUser('user', true);
            const removed = ticketStore.removeExclusionForGuild(interaction.guildId, user.id, activeStorage);
            return interaction.reply({
                content: removed ? `${user} has been removed from the exclusion list.` : `${user} was not on the exclusion list.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const list = ticketStore.getExclusionListForGuild(interaction.guildId, activeStorage);
        if (!list.length) {
            return interaction.reply({ content: 'The exclusion list is empty.', flags: MessageFlags.Ephemeral });
        }
        const lines = list.slice(0, 20).map(entry => {
            const scope = entry.ticketTypes.length
                ? entry.ticketTypes.map(value => typeLabel(value, interaction.guildId)).join(', ')
                : 'all ticket types';
            return `- <@${entry.userId}>: ${scope}${entry.reason ? ` - ${entry.reason}` : ''}`;
        });
        return interaction.reply({ content: `**Exclusion List**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }
};
