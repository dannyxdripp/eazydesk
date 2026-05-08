const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { buildV2Notice } = require('../utils/components-v2-messages');

const RESPONSES = {
    listTitle: 'Available Tags',
    emptyDescription: 'No tags are currently configured.'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tags')
        .setDescription('List all available support tags'),
    async execute(interaction) {
        const tags = ticketStore.getTagsForGuild(interaction.guildId);
        const base = buildV2Notice(
            RESPONSES.listTitle,
            tags.length
                ? tags.map(tag => `- **${tag.name}** - ${tag.title || 'Untitled tag'}`).join('\n')
                : RESPONSES.emptyDescription
        );
        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
