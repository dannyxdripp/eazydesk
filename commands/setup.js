const { SlashCommandBuilder } = require('discord.js');
const setupConversation = require('../utils/setup-conversation');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Start a quick reply-based ticket setup')
        .setDMPermission(false),

    async execute(interaction) {
        return setupConversation.start(interaction);
    }
};
