const { SlashCommandBuilder } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { touchTicket, updateTicketChannelMetadata } = require('../utils/ticket-metadata');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate, buildV2Notice } = require('../utils/components-v2-messages');
const { resolveManagerRoleId } = require('../utils/guild-defaults');

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function runDeferredTask(task, delayMs = 350) {
    setTimeout(() => {
        Promise.resolve()
            .then(task)
            .catch(error => {
                console.error('[claim] Deferred task failed:', error);
            });
    }, Math.max(0, Number(delayMs || 0)));
}

async function syncClaimerOverwrite(ticketChannel, ticket, guildId, userId, enabled) {
    if (!ticketChannel?.permissionOverwrites || !userId) return;

    if (!enabled) {
        if (ticket?.createdBy !== userId) {
            await ticketChannel.permissionOverwrites.delete(userId).catch(() => null);
        }
        return;
    }

    const ticketType = ticketStore.findTicketType(ticket?.ticketType, guildId);
    const allowAttachments = ticketType?.allowAttachments !== false;
    await ticketChannel.permissionOverwrites.create(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        ...(allowAttachments ? { AttachFiles: true } : {})
    }).catch(() => null);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim or unclaim a ticket')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Select claim or unclaim')
                .setRequired(true)
                .addChoices(
                    { name: 'Claim', value: 'claim' },
                    { name: 'Unclaim', value: 'unclaim' }
                )
        ),
    async execute(interaction) {
        try {
            await interaction.deferReply();
            const action = interaction.options.getString('action');
            const ticketChannel = interaction.channel;
            const activeStorage = ticketStore.getActiveStorage();
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);

            if (!ticket) {
                return interaction.editReply(buildMessage('Invalid Channel', 'This command can only be used in ticket channels.', 0xED4245));
            }

            if (action === 'claim' && ticket.claimedBy) {
                return interaction.editReply(buildMessage('Already Claimed', `This ticket is already claimed by <@${ticket.claimedBy}>.`, 0xFEE75C));
            }

            if (action !== 'claim' && !ticket.claimedBy) {
                return interaction.editReply(buildMessage('Not Claimed', 'This ticket is not currently claimed.', 0xFEE75C));
            }

            if (action !== 'claim') {
                const managerRoleId = resolveManagerRoleId(interaction.guildId);
                const canUnclaim = ticket.claimedBy === interaction.user.id || (managerRoleId && interaction.member.roles.cache.has(managerRoleId));
                if (!canUnclaim) {
                    return interaction.editReply(buildMessage('Permission Denied', 'Only the current assignee or a manager can unclaim this ticket.', 0xED4245));
                }
            }

            if (action === 'claim') {
                const guildConfig = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(interaction.guildId) : {};
                const rolePermanence = guildConfig?.rolePermanence !== false;
                ticket.claimedBy = interaction.user.id;
                ticket.claimedAt = new Date().toISOString();
                touchTicket(ticket, interaction.user.id);
                ticketStore.saveActiveStorage(activeStorage);
                ticketStore.recordStaffStatsEvent('claimed', interaction.user.id, ticketChannel.id, ticket.createdBy || null, null, activeStorage);

                await interaction.editReply(buildV2Notice('', `Ticket claimed by <@${interaction.user.id}>`, 0x5865F2));

                runDeferredTask(async () => {
                    await syncClaimerOverwrite(ticketChannel, ticket, interaction.guildId, interaction.user.id, rolePermanence);
                    await updateTicketChannelMetadata(ticketChannel, ticket);
                });
                return null;
            }

            const previousAssignee = ticket.claimedBy;
            delete ticket.claimedBy;
            ticket.claimedAt = null;
            touchTicket(ticket, interaction.user.id);
            ticketStore.saveActiveStorage(activeStorage);

            await interaction.editReply(buildV2Notice('', `Ticket unclaimed (previous assignee: <@${previousAssignee}>)`, 0x5865F2));

            runDeferredTask(async () => {
                await syncClaimerOverwrite(ticketChannel, ticket, interaction.guildId, previousAssignee, false);
                await updateTicketChannelMetadata(ticketChannel, ticket);
            });
            return null;
        } catch (error) {
            console.error('Error running claim command:', error);
            if (error?.code === 10062) return null;
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(buildMessage('Command Error', 'Failed to process claim action. Please try again.', 0xED4245)).catch(() => null);
            }
            return interaction.reply(buildMessage('Command Error', 'Failed to process claim action. Please try again.', 0xED4245)).catch(() => null);
        }
    }
};
