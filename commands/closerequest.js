const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    MessageFlags,
    AttachmentBuilder
} = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const transcriptionHandler = require('../handlers/transcription-handler');
const { archiveTranscript } = require('../utils/transcript-archive');
const { buildTranscriptSummaryV2 } = require('../utils/transcript-summary');
const { getPublicBaseUrl } = require('../utils/public-url');
const { resolveEmbedPayload, resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');
const { resolveTranscriptsChannelId } = require('../utils/guild-defaults');

const CLOSE_NOW_ID = 'closerequest_close_now';
const CANCEL_ID = 'closerequest_cancel';

function buildEmbed(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function formatDelay(minutes) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours} hour(s)` : `${minutes} minute(s)`;
}

function buildCloseRequestButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(CLOSE_NOW_ID)
            .setLabel('Accept & Close')
            .setEmoji({ id: '1487433169157357688', name: 'checkbox', animated: false })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(CANCEL_ID)
            .setLabel('Deny & Keep Open')
            .setEmoji({ id: '1487433209871339602', name: 'crossbox', animated: false })
            .setStyle(ButtonStyle.Secondary)
    );
}

function scheduleCloseRequestTimer(ticketChannel, timerMinutes) {
    setTimeout(async () => {
        try {
            const request = ticketStore.getCloseRequest(ticketChannel.id);
            if (!request || request.status !== 'pending') return;
            if (!ticketStore.getTicketByChannelId(ticketChannel.id)) return;
            await closeTicketWithTranscript(
                ticketChannel,
                `Auto-closed after ${formatDelay(request.timer)}.\nReason: ${request.reason}`,
                request.requestedBy || null
            );
        } catch (error) {
            console.error('Error in close request timer:', error);
        }
    }, timerMinutes * 60 * 1000);
}

async function trySendUserTranscript(user, payload, file) {
    if (!user || typeof user.send !== 'function') return false;
    try {
        await user.send({ ...payload, files: file ? [file] : [] });
        return true;
    } catch {
        try {
            await user.send({ ...payload });
            return true;
        } catch {
            return false;
        }
    }
}

async function closeTicketWithTranscript(ticketChannel, reason, closedByUserId = null) {
    const activeStorage = ticketStore.getActiveStorage();
    const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);
    const closedAt = new Date().toISOString();
    const closedEmbed = resolveEmbedPayload(ticketStore, 'ticketClosed', {
        closedBy: closedByUserId ? `<@${closedByUserId}>` : 'System',
        reason
    });
    await ticketChannel.send(buildEmbed(closedEmbed.title, closedEmbed.description, closedEmbed.color));

    try {
        const transcriptData = await transcriptionHandler.createTranscript(ticketChannel, { includeParticipants: true });
        const transcriptPath = transcriptData?.transcriptPath || transcriptData;
        const participantUserIds = Array.isArray(transcriptData?.participantUserIds) ? transcriptData.participantUserIds : [];

        let archiveEntry = null;
        try {
            archiveEntry = archiveTranscript({
                channel: ticketChannel,
                ticket,
                transcriptPath,
                reason,
                closedByUserId,
                closedAt,
                participantUserIds,
                storage: activeStorage
            });
        } catch (error) {
            console.error('Error archiving transcript:', error);
        }

        const baseUrl = getPublicBaseUrl();
        const publicToken = String(archiveEntry?.publicToken || '').trim();
        const transcriptUrl = publicToken ? `${baseUrl}/t/${publicToken}` : '';
        const headerUrl = String(process.env.TRANSCRIPT_HEADER_URL || process.env.SUPPORT_SERVER_URL || '').trim();
        const headerLabel = String(process.env.TRANSCRIPT_HEADER_LABEL || ticketChannel.guild?.name || 'Support Server').trim();

        const fileName = `${ticketChannel.id}.html`;
        const file = new AttachmentBuilder(transcriptPath, { name: fileName });
        const payload = buildTranscriptSummaryV2({
            ticketId: ticketChannel.id,
            guildName: ticketChannel.guild?.name || 'Support Transcript',
            brandEmoji: process.env.TRANSCRIPT_BRAND_EMOJI || '',
            openedBy: ticket?.createdBy || null,
            openedAt: ticket?.createdAt || null,
            claimedBy: ticket?.claimedBy || null,
            claimedAt: ticket?.claimedAt || null,
            closedBy: closedByUserId || null,
            closedAt,
            closeReason: reason,
            transcriptUrl,
            headerUrl,
            headerLabel
        });
        const userPayload = {
            ...payload,
            components: Array.isArray(payload?.components)
                ? payload.components.filter(component => {
                    const text = String(component?.text || component?.data?.text || '').toLowerCase();
                    return !text.includes('/controller');
                })
                : payload.components
        };

        // 1) Send to transcripts channel (staff archive)
        const transcriptsChannelId = resolveTranscriptsChannelId(ticketChannel.guild?.id, activeStorage) || null;
        const transcriptsChannel = transcriptsChannelId
            ? await ticketChannel.guild.channels.fetch(transcriptsChannelId).catch(() => null)
            : null;
        if (transcriptsChannel && typeof transcriptsChannel.send === 'function') {
            await transcriptsChannel.send({ ...payload, files: [file] }).catch(() => null);
        }

        // 2) DM the ticket opener (user copy) when possible
        if (ticket?.createdBy) {
            const opener = await ticketChannel.client.users.fetch(String(ticket.createdBy)).catch(() => null);
            if (opener) {
                await trySendUserTranscript(opener, userPayload, file);
            }
        }
    } catch (error) {
        await ticketChannel.send(buildEmbed('Transcript Error', 'Could not generate or send transcript for this ticket.', 0xED4245));
    }

    if (closedByUserId) {
        ticketStore.recordStaffStatsEvent('closed', closedByUserId, ticketChannel.id, ticket?.createdBy || null);
    }

    ticketStore.removeCloseRequest(ticketChannel.id);
    ticketStore.removeTicketByChannelId(ticketChannel.id);
    await ticketChannel.delete();
}

module.exports = {
    CLOSE_NOW_ID,
    CANCEL_ID,
    buildCloseRequestButtons,
    scheduleCloseRequestTimer,
    closeTicketWithTranscript,
    data: new SlashCommandBuilder()
        .setName('closerequest')
        .setDescription('Request to close a ticket with a reason and timer')
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for requesting ticket closure')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('timer')
                .setDescription('Select the delay before the ticket closes')
                .setRequired(true)
                .addChoices(
                    { name: '1 Hour', value: 60 },
                    { name: '6 Hours', value: 360 },
                    { name: '12 Hours', value: 720 },
                    { name: '24 Hours', value: 1440 }
                )
        ),

    async execute(interaction) {
        const reason = interaction.options.getString('reason');
        const timer = interaction.options.getInteger('timer');
        const ticketChannel = interaction.channel;

        if (!ticketStore.getTicketByChannelId(ticketChannel.id)) {
            const base = buildEmbed('Invalid Channel', 'This command can only be used in ticket channels.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        ticketStore.setCloseRequest(ticketChannel.id, {
            reason,
            timer,
            requestedBy: interaction.user.id,
            requestedAt: new Date().toISOString(),
            status: 'pending'
        });
        ticketStore.recordCloseRequestReasonForGuild(reason, interaction.user.id, interaction.guildId);

        {
            const safeReason = String(reason || 'No reason provided.').trim().slice(0, 900).replace(/`/g, "'");
            const timerLabel = formatDelay(timer);
            const lines = [
                `<:closereq:1487472578908913794> **Close Request**`,
                `> ${interaction.user} has requested to close this ticket.`,
                `> Reason: \`${safeReason}\``,
                `> Auto-close in **${timerLabel}** unless denied.`,
                `-# Accept or Deny using the options below.`
            ];

            const container = new ContainerBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
                .addActionRowComponents(buildCloseRequestButtons());

            await interaction.reply({ flags: MessageFlags.IsComponentsV2, components: [container] });
        }

        scheduleCloseRequestTimer(ticketChannel, timer);
    },

    async handleButton(interaction) {
        const ticketChannel = interaction.channel;
        const request = ticketStore.getCloseRequest(ticketChannel.id);
        const ticket = ticketStore.getTicketByChannelId(ticketChannel.id);

        if (!request) {
            const base = buildEmbed('No Active Request', 'There is no active close request for this ticket.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        if (ticket?.createdBy && ticket.createdBy !== interaction.user.id) {
            const base = buildEmbed('Permission Denied', 'Only the ticket opener can action this close request.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        if (interaction.customId === CANCEL_ID) {
            ticketStore.removeCloseRequest(ticketChannel.id);
            const base = buildEmbed('Close Request Cancelled', 'The pending close request has been cancelled.', 0x57F287);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        if (interaction.customId === CLOSE_NOW_ID) {
            {
                const base = buildEmbed('Closing Ticket', 'Closing now and generating transcript...', 0xFEE75C);
                await interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
            }
            await closeTicketWithTranscript(
                ticketChannel,
                `Closed immediately from close request.\nReason: ${request.reason}`,
                interaction.user.id
            );
        }
    }
};
