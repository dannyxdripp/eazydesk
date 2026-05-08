const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const closeRequestCommand = require('./closerequest');
const { buildV2Notice } = require('../utils/components-v2-messages');
const { resolveManagerRoleId } = require('../utils/guild-defaults');

const RESPONSES = {
    invalidContextTitle: 'Invalid Context',
    invalidContextDescription: 'This command can only be used in a server.',
    deniedTitle: 'Permission Denied',
    deniedDescription: 'You do not have permission to use this command.',
    confirmTitle: 'Confirmation Required',
    confirmDescription: 'Re-run with `confirm: true` to proceed.',
    completeTitle: 'Mass Close Complete'
};

function normalize(value) {
    return ticketStore.normalizeType(String(value || ''));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('massclose')
        .setDescription('Mass close active tickets (manager only)')
        .addBooleanOption(option =>
            option
                .setName('confirm')
                .setDescription('Set true to confirm')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('ticket_type')
                .setDescription('Only close tickets of this type (optional)')
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option
                .setName('limit')
                .setDescription('Max tickets to close (default 25)')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason shown in close message')
                .setRequired(false)
        ),

    async execute(interaction) {
        if (!interaction.inGuild?.() || !interaction.guild) {
            const base = buildV2Notice(RESPONSES.invalidContextTitle, RESPONSES.invalidContextDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const managerRoleId = resolveManagerRoleId(interaction.guildId);
        if (!managerRoleId || !interaction.member?.roles?.cache?.has(managerRoleId)) {
            const base = buildV2Notice(RESPONSES.deniedTitle, RESPONSES.deniedDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const confirm = Boolean(interaction.options.getBoolean('confirm', true));
        if (!confirm) {
            const base = buildV2Notice(RESPONSES.confirmTitle, RESPONSES.confirmDescription, 0xFEE75C);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const filterTypeRaw = interaction.options.getString('ticket_type') || '';
        const filterType = normalize(filterTypeRaw);
        const limit = Math.min(100, Math.max(1, Number(interaction.options.getInteger('limit') || 25)));
        const reason = String(interaction.options.getString('reason') || 'Mass-closed by staff.').trim();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const activeStorage = ticketStore.getActiveStorage();
        const allTickets = Array.isArray(activeStorage.tickets) ? activeStorage.tickets : [];
        const invokingChannelId = interaction.channel?.id || interaction.channelId || null;
        const toClose = allTickets
            .filter(t => t && t.channelId && (!invokingChannelId || String(t.channelId) !== String(invokingChannelId)) && (!filterType || normalize(t.ticketType) === filterType))
            .slice(0, limit);

        let closed = 0;
        const failed = [];

        for (const ticket of toClose) {
            const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                failed.push({ channelId: ticket.channelId, error: 'Channel missing or not text based' });
                continue;
            }

            try {
                await closeRequestCommand.closeTicketWithTranscript(
                    channel,
                    `Mass-closed by ${interaction.user}.\nReason: ${reason}`,
                    interaction.user.id
                );
                closed += 1;
            } catch (error) {
                failed.push({ channelId: ticket.channelId, error: String(error?.message || error) });
            }
        }

        const summary = [
            `Closed: **${closed}**`,
            failed.length ? `Failed: **${failed.length}**` : null,
            filterType ? `Filter: **${filterTypeRaw}**` : null,
            invokingChannelId && allTickets.some(t => String(t.channelId) === String(invokingChannelId))
                ? `Note: skipped current channel (<#${invokingChannelId}>) to avoid breaking the command response.`
                : null
        ].filter(Boolean).join('\n');

        const base = buildV2Notice(RESPONSES.completeTitle, summary, failed.length ? 0xFEE75C : 0x57F287);
        return interaction.editReply(base);
    }
};
