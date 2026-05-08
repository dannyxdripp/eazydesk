const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { getPublicBaseUrl } = require('../utils/public-url');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');
const { resolveManagerRoleId } = require('../utils/guild-defaults');

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function canRun(interaction) {
    if (!interaction?.inGuild?.()) return false;
    if (
        interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
    ) {
        return true;
    }

    const managerRoleId = resolveManagerRoleId(interaction.guildId);
    return Boolean(managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Get the website setup link for this server')
        .setDMPermission(false),

    async execute(interaction) {
        if (!canRun(interaction)) {
            const base = buildMessage('Permission Denied', 'You need Manage Server permissions (or the configured manager role) to use this.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const baseUrl = getPublicBaseUrl();
        const setupUrl = `${baseUrl}/setup?guild=${encodeURIComponent(interaction.guildId)}`;
        const base = buildMessage(
            'Setup Link',
            `Setup: ${setupUrl}\n\nThe setup page is protected and walks you through server configuration step by step.`,
            0x5865F2
        );

        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
