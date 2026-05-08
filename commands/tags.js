const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { buildV2Notice } = require('../utils/components-v2-messages');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tags')
        .setDescription('List all available support tags'),
    async execute(interaction) {
        const tags = ticketStore.getTagsForGuild(interaction.guildId);
        const base = buildV2Notice(
            'Available Tags',
            tags.length
                ? tags.map(tag => `- **${tag.name}** - ${tag.title || 'Untitled tag'}`).join('\n')
                : 'No tags are currently configured.'
        );
        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
