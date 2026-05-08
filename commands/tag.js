const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const TAG_CREATE_CONFIRM_ID = 'tag_create_confirm';
const TAG_CREATE_CANCEL_ID = 'tag_create_cancel';

const RESPONSES = {
    notFoundTitle: 'Tag Not Found',
    notFoundDescription: 'No matching tag was found.',
    sentTitle: 'Tag Sent',
    sentDescription: 'Tag **{tag}** has been posted.',
    unavailableTitle: 'Not Available',
    unavailableDescription: 'Tag management buttons are no longer used. Use slash commands instead.'
};

function buildEmbed(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function buildRecommendedTags(query, guildId) {
    const normalizedQuery = ticketStore.normalizeType(query || '');
    const tags = ticketStore.getTagsForGuild(guildId);

    return tags
        .map(tag => {
            const name = String(tag.name || '');
            const normalizedName = ticketStore.normalizeType(name);
            const usage = ticketStore.getTagUsageCount(name);
            const startsWith = normalizedQuery ? normalizedName.startsWith(normalizedQuery) : true;
            const includes = normalizedQuery ? normalizedName.includes(normalizedQuery) : true;
            const score = startsWith ? 3 : includes ? 1 : 0;
            return { tag, score, usage };
        })
        .filter(entry => !normalizedQuery || entry.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.usage !== a.usage) return b.usage - a.usage;
            return String(a.tag.name).localeCompare(String(b.tag.name));
        })
        .slice(0, 25);
}

module.exports = {
    TAG_CREATE_CONFIRM_ID,
    TAG_CREATE_CANCEL_ID,
    data: new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Send a saved support tag')
        .addStringOption(option =>
            option
                .setName('tag')
                .setDescription('Tag to send')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'tag') return;

        const choices = buildRecommendedTags(focused.value || '', interaction.guildId).map(entry => ({
            name: String(entry.tag.name).slice(0, 100),
            value: entry.tag.name
        }));

        await interaction.respond(choices);
    },

    async execute(interaction) {
        const selectedName = interaction.options.getString('tag');
        let tag = ticketStore.findTagByName(selectedName, interaction.guildId);

        if (!tag) {
            const recommendations = buildRecommendedTags(selectedName, interaction.guildId);
            if (recommendations.length) tag = recommendations[0].tag;
        }

        if (!tag) {
            const base = buildEmbed(RESPONSES.notFoundTitle, RESPONSES.notFoundDescription, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        await interaction.channel.send(buildEmbed(tag.title || tag.name, tag.description || 'No description provided.'));

        ticketStore.recordTagUsageForGuild(tag.name, interaction.guildId);
        {
            const base = buildEmbed(RESPONSES.sentTitle, RESPONSES.sentDescription.replace('{tag}', tag.name), 0x57F287);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }
    },

    async handleButton(interaction) {
        const base = buildEmbed(RESPONSES.unavailableTitle, RESPONSES.unavailableDescription, 0xFEE75C);
        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
