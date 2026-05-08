const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const closeRequestCommand = require('./closerequest');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const RESPONSES = {
    invalidChannelTitle: 'Invalid Channel',
    invalidChannelDescription: 'This command can only be used in ticket channels.',
    closingTitle: 'Closing Ticket',
    closingDescription: 'Reason: {reason}\nGenerating transcript...',
    failedTitle: 'Close Failed',
    failedDescription: 'Could not close this ticket. Check logs for details.'
};

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Close a ticket with a reason')
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for closing the ticket')
                .setRequired(true)
        ),
    async execute(interaction) {
        const reason = interaction.options.getString('reason');
        const ticketChannel = interaction.channel;
        const activeStorage = ticketStore.getActiveStorage();
        const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);

        if (!ticket) {
            const base = buildMessage(RESPONSES.invalidChannelTitle, RESPONSES.invalidChannelDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        {
            const base = buildMessage(RESPONSES.closingTitle, RESPONSES.closingDescription.replace('{reason}', reason), 0xFEE75C);
            await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        try {
            await closeRequestCommand.closeTicketWithTranscript(ticketChannel, reason, interaction.user.id);
        } catch (error) {
            const base = buildMessage(RESPONSES.failedTitle, RESPONSES.failedDescription, 0xED4245);
            await interaction.editReply({ ...base, flags: MessageFlags.Ephemeral | base.flags }).catch(() => null);
        }
    }
};
