const { SlashCommandBuilder } = require('@discordjs/builders');
const ticketHandler = require('../handlers/ticket-handler');
const ticketStore = require('../utils/ticket-store');
const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-panel')
        .setDescription('Set up the ticket support panel.')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Channel to send the ticket panel in')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('ticket_type')
                .setDescription('Restrict this channel to only open one ticket type (name or select value)')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('clear_restriction')
                .setDescription('Clear any existing ticket type restriction for this channel')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('panel_name')
                .setDescription('Custom panel title for this channel (ex: Billing Support)')
                .setRequired(false)
        ),
    async execute(interaction) {
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            return interaction.reply({ content: 'Invalid channel selected.', flags: MessageFlags.Ephemeral }).catch(() => null);
        }

        const me = interaction.guild?.members?.me;
        if (me) {
            const perms = targetChannel.permissionsFor(me);
            if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
                return interaction.reply({ content: 'I cannot send messages in that channel.', flags: MessageFlags.Ephemeral }).catch(() => null);
            }
        }

        const clearRestriction = interaction.options.getBoolean('clear_restriction') === true;
        const ticketTypeInput = interaction.options.getString('ticket_type');
        const panelName = String(interaction.options.getString('panel_name') || '').trim();

        let notice = 'Ticket panel has been set up.';
        if (clearRestriction) {
            ticketStore.setRestrictedTicketTypeForChannel(targetChannel.id, null, null, interaction.guildId);
            notice = 'Ticket panel has been set up. Channel restriction cleared.';
        } else if (ticketTypeInput) {
            const restrictedSelectValue = ticketStore.setRestrictedTicketTypeForChannel(targetChannel.id, ticketTypeInput, null, interaction.guildId);
            if (!restrictedSelectValue) {
                return interaction.reply({ content: `Unknown ticket type: "${ticketTypeInput}".`, flags: MessageFlags.Ephemeral }).catch(() => null);
            }
            const allowedConfig = ticketStore.findTicketTypeBySelectValue(restrictedSelectValue, interaction.guildId);
            notice = `Ticket panel has been set up. This channel now only opens **${allowedConfig?.name || restrictedSelectValue}** tickets.`;
        }

        if (panelName) {
            const activeStorage = ticketStore.getActiveStorage();
            const guildConfig = ticketStore.getGuildConfig(interaction.guildId, activeStorage);
            const panels = guildConfig.panels && typeof guildConfig.panels === 'object' ? guildConfig.panels : {};
            panels[targetChannel.id] = { ...(panels[targetChannel.id] || {}), name: panelName };
            ticketStore.setGuildConfig(interaction.guildId, { panels }, activeStorage);
        }

        return ticketHandler.createTicketPanel(interaction, { channel: targetChannel, notice, panelName: panelName || undefined });
    }
};
