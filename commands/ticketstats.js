const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const WINDOWS = [7, 14, 30];

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function buildBar(value, maxValue, width = 16) {
    if (maxValue <= 0) return '-'.repeat(width);
    const filled = Math.round((value / maxValue) * width);
    return `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`;
}

function buildMiniGraph(claimed, closed) {
    const maxValue = Math.max(claimed, closed, 1);
    const claimedBar = buildBar(claimed, maxValue);
    const closedBar = buildBar(closed, maxValue);
    return [
        '```txt',
        `Claimed |${claimedBar}| ${claimed}`,
        `Closed  |${closedBar}| ${closed}`,
        '```'
    ].join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticketstats')
        .setDescription('Show ticket claim/close stats and trends')
        .addIntegerOption(option =>
            option
                .setName('window')
                .setDescription('Select time window')
                .setRequired(false)
                .addChoices(
                    { name: 'Last 7 days', value: 7 },
                    { name: 'Last 14 days', value: 14 },
                    { name: 'Last 30 days', value: 30 }
                )
        )
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to check (defaults to yourself)')
                .setRequired(false)
        ),

    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const requestedWindow = interaction.options.getInteger('window');
        const days = WINDOWS.includes(requestedWindow) ? requestedWindow : 30;

        const activeStorage = ticketStore.getActiveStorage();
        const { claimed, closed } = ticketStore.getStaffStatsForUserLastDays(targetUser.id, days, activeStorage);
        const graph = buildMiniGraph(claimed, closed);
        // Pull suggestions from the same snapshot to avoid inconsistencies across file reads.
        const prompts = (() => {
            const forUser = ticketStore.getTopCloseRequestReasons(days, targetUser.id, 3, activeStorage);
            const source = forUser.length ? 'user' : 'global';
            const list = forUser.length ? forUser : ticketStore.getTopCloseRequestReasons(days, null, 3, activeStorage);
            if (!list.length) return { source, text: 'Suggested close prompts:\n- No historical close request prompts yet.' };
            return {
                source,
                text: `Suggested close prompts (${source === 'user' ? 'from this user' : 'from server usage'}):\n${list
                    .map(entry => `- ${entry.reason} (${entry.count})`)
                    .join('\n')}`
            };
        })();

        const base = buildMessage(
            'Ticket Statistics',
            [
                `User: ${targetUser}`,
                `Window: Last ${days} days`,
                `Claimed: **${claimed}**`,
                `Closed: **${closed}**`,
                '',
                graph,
                prompts.text
            ].join('\n'),
            0x57F287
        );
        return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
    }
};
