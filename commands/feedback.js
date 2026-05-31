const {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { buildV2Notice } = require('../utils/components-v2-messages');
const { resolveAppealsChannelId } = require('../utils/guild-defaults');

const MODAL_ID = 'feedback:modal';
const RATING_ID = 'feedback:rating';
const COMMENT_ID = 'feedback:comment';

const RESPONSES = {
    invalidChannelTitle: 'Invalid Channel',
    invalidChannelDescription: 'This command can only be used in an active ticket channel.',
    deniedTitle: 'Permission Denied',
    deniedDescription: 'Only the ticket opener can submit feedback for this ticket.',
    noStaffTitle: 'No Staff Member',
    noStaffDescription: 'This ticket has not been claimed yet, so there is nobody to rate.',
    invalidRatingTitle: 'Invalid Rating',
    invalidRatingDescription: 'Please enter a number from 1 to 5.',
    notConfiguredTitle: 'Feedback Channel Not Configured',
    notConfiguredDescription: 'An admin needs to configure this server\'s feedback channel in the dashboard.',
    channelErrorTitle: 'Feedback Channel Error',
    channelErrorDescription: 'Feedback channel ({channelId}) is not configured or inaccessible.',
    newFeedbackTitle: 'New Feedback',
    thanksTitle: 'Feedback Sent',
    thanksDescription: 'Thank you for your feedback. The staff team can now review it.'
};

function getFeedbackChannelId(guildId) {
    return resolveAppealsChannelId(guildId);
}

function getTicketForInteraction(interaction) {
    const channelId = interaction.channel?.id;
    if (!channelId) return null;
    return ticketStore.getTicketByChannelId(channelId, ticketStore.getActiveStorage());
}

function buildTicketError(interaction, ticket) {
    if (!ticket) {
        return buildV2Notice(RESPONSES.invalidChannelTitle, RESPONSES.invalidChannelDescription, 0xED4245);
    }

    if (ticket.createdBy && ticket.createdBy !== interaction.user.id) {
        return buildV2Notice(RESPONSES.deniedTitle, RESPONSES.deniedDescription, 0xED4245);
    }

    if (!ticket.claimedBy) {
        return buildV2Notice(RESPONSES.noStaffTitle, RESPONSES.noStaffDescription, 0xFEE75C);
    }

    return null;
}

module.exports = {
    MODAL_ID,
    data: new SlashCommandBuilder()
        .setName('feedback')
        .setDescription('Leave feedback for the staff member who handled your ticket'),

    async execute(interaction) {
        const ticket = getTicketForInteraction(interaction);
        const error = buildTicketError(interaction, ticket);
        if (error) {
            return interaction.reply({ ...error, flags: MessageFlags.Ephemeral | error.flags });
        }

        const modal = new ModalBuilder()
            .setCustomId(MODAL_ID)
            .setTitle('Support Feedback')
            .addComponents(
                {
                    type: 1,
                    components: [
                        new TextInputBuilder()
                            .setCustomId(RATING_ID)
                            .setLabel('Rating (1-5)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('5')
                            .setRequired(true)
                            .setMaxLength(1)
                    ]
                },
                {
                    type: 1,
                    components: [
                        new TextInputBuilder()
                            .setCustomId(COMMENT_ID)
                            .setLabel('What went well or could improve?')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder('Optional details for the staff team...')
                            .setRequired(false)
                            .setMaxLength(1000)
                    ]
                }
            );

        return interaction.showModal(modal);
    },

    async handleModalSubmit(interaction) {
        const ticketChannel = interaction.channel;
        const ticket = getTicketForInteraction(interaction);
        const error = buildTicketError(interaction, ticket);
        if (error) {
            return interaction.reply({ ...error, flags: MessageFlags.Ephemeral | error.flags });
        }

        const ratingRaw = String(interaction.fields.getTextInputValue(RATING_ID) || '').trim();
        const rating = Number.parseInt(ratingRaw, 10);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            const base = buildV2Notice(RESPONSES.invalidRatingTitle, RESPONSES.invalidRatingDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const comment = String(interaction.fields.getTextInputValue(COMMENT_ID) || '').trim();

        const feedbackChannelId = getFeedbackChannelId(interaction.guildId);
        if (!feedbackChannelId) {
            const base = buildV2Notice(RESPONSES.notConfiguredTitle, RESPONSES.notConfiguredDescription, 0xFEE75C);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const feedbackChannel = await interaction.client.channels.fetch(feedbackChannelId).catch(() => null);
        if (!feedbackChannel || !feedbackChannel.isTextBased()) {
            const base = buildV2Notice(
                RESPONSES.channelErrorTitle,
                RESPONSES.channelErrorDescription.replace('{channelId}', feedbackChannelId),
                0xED4245
            );
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        await feedbackChannel.send(buildV2Notice(
            RESPONSES.newFeedbackTitle,
            [
                `Ticket: <#${ticketChannel.id}>`,
                `Ticket type: **${ticket.ticketType || 'Unknown'}**`,
                `Requester: <@${ticket.createdBy || interaction.user.id}>`,
                `Staff: <@${ticket.claimedBy}>`,
                `Score: **${rating}/5**`,
                comment ? `\n**Comments:**\n${comment}` : null
            ].filter(Boolean).join('\n'),
            0x5865F2
        ));

        const base = buildV2Notice(RESPONSES.thanksTitle, RESPONSES.thanksDescription, 0x5865F2);
        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
