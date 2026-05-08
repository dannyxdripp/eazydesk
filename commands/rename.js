const { SlashCommandBuilder } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const RESPONSES = {
    invalidChannelTitle: 'Invalid Channel',
    invalidChannelDescription: 'This command can only be used in ticket channels.',
    invalidNameTitle: 'Invalid Name',
    invalidNameDescription: 'Use letters, numbers, and hyphens for ticket names.',
    noChangeTitle: 'No Change',
    noChangeDescription: 'After formatting, this becomes `{name}`, which matches the current name.',
    queuedTitle: 'Rename Queued',
    queuedDescription: 'Changed by {user}\nRenaming channel to `{name}`...',
    renamedTitle: 'Ticket Renamed',
    renamedDescription: 'Changed by {user}\nNew name: `{name}`',
    failedTitle: 'Rename Failed',
    errorTitle: 'Command Error'
};

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function runDeferredTask(task, delayMs = 250) {
    setTimeout(() => {
        Promise.resolve()
            .then(task)
            .catch(error => {
                console.error('[rename] Deferred task failed:', error);
            });
    }, Math.max(0, Number(delayMs || 0)));
}

function normalizeChannelName(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 95);
}

function describeRenameError(error) {
    const code = Number(error?.code || 0);
    const netCode = String(error?.code || '').toUpperCase();
    if (netCode === 'ENOTFOUND') return 'Network DNS lookup failed (discord.com). Check server internet/DNS and try again.';
    if (netCode === 'ETIMEDOUT' || netCode === 'ECONNRESET' || netCode === 'EAI_AGAIN') {
        return 'Temporary network error while contacting Discord. Please retry in a few seconds.';
    }
    if (code === 50013) return 'Missing permissions. Ensure the bot can Manage Channels.';
    if (code === 50035) return 'Invalid channel name. Try fewer/simpler characters.';
    if (code === 50001) return 'Missing access to this channel.';
    if (code === 429 || Number(error?.status || 0) === 429) {
        const retryAfter = Number(error?.rawError?.retry_after || error?.retry_after || 0);
        if (retryAfter > 0) {
            const seconds = Math.ceil(retryAfter);
            const minutes = Math.ceil(seconds / 60);
            return `Rate limited by Discord channel-edit limits. Retry in about ${seconds}s (~${minutes}m).`;
        }
        return 'Rate limited by Discord channel-edit limits. Please retry in a few minutes.';
    }
    return 'Failed to rename ticket. Please try again.';
}

async function renameChannelWithRetry(channel, nextName) {
    try {
        return await channel.setName(nextName);
    } catch (error) {
        const netCode = String(error?.code || '').toUpperCase();
        if (netCode !== 'ENOTFOUND' && netCode !== 'ETIMEDOUT' && netCode !== 'ECONNRESET' && netCode !== 'EAI_AGAIN') {
            throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));
        return channel.setName(nextName);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename a ticket channel')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('New ticket channel name')
                .setRequired(true)
        ),
    async execute(interaction) {
        try {
            await interaction.deferReply();
            const ticketChannel = interaction.channel;
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id);

            if (!ticket) {
                return interaction.editReply(buildMessage(RESPONSES.invalidChannelTitle, RESPONSES.invalidChannelDescription, 0xED4245));
            }

            const requestedName = interaction.options.getString('name', true);
            const nextName = normalizeChannelName(requestedName);
            if (!nextName) {
                return interaction.editReply(buildMessage(RESPONSES.invalidNameTitle, RESPONSES.invalidNameDescription, 0xED4245));
            }

            if ((ticketChannel.name || '').toLowerCase() === nextName.toLowerCase()) {
                return interaction.editReply(buildMessage(RESPONSES.noChangeTitle, RESPONSES.noChangeDescription.replace('{name}', nextName), 0xFEE75C));
            }

            await interaction.editReply(buildMessage(RESPONSES.queuedTitle, RESPONSES.queuedDescription.replace('{user}', String(interaction.user)).replace('{name}', nextName), 0x5865F2));

            runDeferredTask(async () => {
                try {
                    await renameChannelWithRetry(ticketChannel, nextName);
                    await interaction.editReply(buildMessage(RESPONSES.renamedTitle, RESPONSES.renamedDescription.replace('{user}', String(interaction.user)).replace('{name}', nextName), 0x57F287));
                } catch (error) {
                    const message = describeRenameError(error);
                    await interaction.editReply(buildMessage(RESPONSES.failedTitle, message, 0xED4245)).catch(() => null);
                }
            });
            return null;
        } catch (error) {
            console.error('Error running rename command:', error);
            if (error?.code === 10062) return null;
            const message = describeRenameError(error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(buildMessage(RESPONSES.errorTitle, message, 0xED4245)).catch(() => null);
            }
            return interaction.reply(buildMessage(RESPONSES.errorTitle, message, 0xED4245)).catch(() => null);
        }
    }
};
