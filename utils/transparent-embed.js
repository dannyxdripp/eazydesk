const { EmbedBuilder } = require('discord.js');

function buildTransparentEmbed(title, description) {
    const embed = new EmbedBuilder().setTitle(String(title || '')).setDescription(String(description || ''));
    // Intentionally do not set `color` so the embed renders without the side accent.
    return embed;
}

function buildTransparentEmbedFromTemplate(ticketStore, resolveEmbedByTitle, title, description, color = 0x5865F2) {
    const next = resolveEmbedByTitle(ticketStore, title, description, color);
    return buildTransparentEmbed(next.title, next.description);
}

module.exports = { buildTransparentEmbed, buildTransparentEmbedFromTemplate };

