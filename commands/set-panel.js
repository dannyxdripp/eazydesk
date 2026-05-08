const { SlashCommandBuilder } = require('@discordjs/builders');
const ticketHandler = require('../handlers/ticket-handler');
const ticketStore = require('../utils/ticket-store');
const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

const RESPONSES = {
    invalidChannel: 'Invalid channel selected.',
    cannotSend: 'I cannot send messages in that channel.',
    unknownTicketType: 'Unknown ticket type: "{ticketType}".',
    panelSet: 'Ticket panel has been set up.',
    panelCleared: 'Ticket panel has been set up. Channel restriction cleared.',
    panelRestricted: 'Ticket panel has been set up. This channel now only opens **{ticketType}** tickets.'
};

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
            return interaction.reply({ content: RESPONSES.invalidChannel, flags: MessageFlags.Ephemeral }).catch(() => null);
        }

        const me = interaction.guild?.members?.me;
        if (me) {
            const perms = targetChannel.permissionsFor(me);
            if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
                return interaction.reply({ content: RESPONSES.cannotSend, flags: MessageFlags.Ephemeral }).catch(() => null);
            }
        }

        const clearRestriction = interaction.options.getBoolean('clear_restriction') === true;
        const ticketTypeInput = interaction.options.getString('ticket_type');
        const panelName = String(interaction.options.getString('panel_name') || '').trim();

        let notice = RESPONSES.panelSet;
        if (clearRestriction) {
            ticketStore.setRestrictedTicketTypeForChannel(targetChannel.id, null, null, interaction.guildId);
            notice = RESPONSES.panelCleared;
        } else if (ticketTypeInput) {
            const restrictedSelectValue = ticketStore.setRestrictedTicketTypeForChannel(targetChannel.id, ticketTypeInput, null, interaction.guildId);
            if (!restrictedSelectValue) {
                return interaction.reply({ content: RESPONSES.unknownTicketType.replace('{ticketType}', ticketTypeInput), flags: MessageFlags.Ephemeral }).catch(() => null);
            }
            const allowedConfig = ticketStore.findTicketTypeBySelectValue(restrictedSelectValue, interaction.guildId);
            notice = RESPONSES.panelRestricted.replace('{ticketType}', allowedConfig?.name || restrictedSelectValue);
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
