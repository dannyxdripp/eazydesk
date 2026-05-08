const { SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');

const RESPONSES = {
    invalidChannelTitle: 'Invalid Channel',
    invalidChannelDescription: 'This command can only be used in ticket channels.',
    invalidTeamTitle: 'Invalid Team',
    invalidTeamDescription: 'Invalid support team specified.',
    configTitle: 'Configuration Error',
    configDescription: 'That team does not have a valid role configured in JSON.',
    transferredBody: '<:transfer:1487470747097104575> **Ticket Transferred**\n> Ticket type changed from **{from}** to **{to}**\n-# Action by {user}',
    warningTitle: 'Transfer Warning',
    warningDescription: 'Team permissions update is delayed. Please retry `/transfer` in a few seconds.',
    errorTitle: 'Command Error',
    errorDescription: 'Failed to transfer ticket. Please try again.'
};

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function runDeferredTask(task, delayMs = 300) {
    setTimeout(() => {
        Promise.resolve()
            .then(task)
            .catch(error => {
                console.error('[transfer] Deferred task failed:', error);
            });
    }, Math.max(0, Number(delayMs || 0)));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Transfer a ticket to a different support team')
        .addStringOption(option =>
            option
                .setName('team')
                .setDescription('The support team to transfer the ticket to')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (!focused || focused.name !== 'team') return;

        const query = String(focused.value || '').trim().toLowerCase();
        const ticketTypes = ticketStore.getTicketTypesForGuild(interaction.guildId);
        const filtered = query
            ? ticketTypes.filter(t => String(t?.name || '').toLowerCase().includes(query))
            : ticketTypes;

        await interaction.respond(
            filtered.slice(0, 25).map(t => ({
                name: String(t.name || '').slice(0, 100),
                value: ticketStore.toTicketSelectValue(t.name)
            }))
        );
    },

    async execute(interaction) {
        try {
            await interaction.deferReply();
            const teamValue = interaction.options.getString('team');
            const ticketChannel = interaction.channel;
            const activeStorage = ticketStore.getActiveStorage();
            const ticket = ticketStore.getTicketByChannelId(ticketChannel.id, activeStorage);

            if (!ticket) {
                return interaction.editReply(buildMessage(RESPONSES.invalidChannelTitle, RESPONSES.invalidChannelDescription, 0xED4245));
            }

            const ticketType = ticketStore.findTicketType(teamValue, interaction.guildId);
            if (!ticketType) {
                return interaction.editReply(buildMessage(RESPONSES.invalidTeamTitle, RESPONSES.invalidTeamDescription, 0xED4245));
            }

            const teamData = ticketStore.findSupportTeamForTicketType(ticketType.name, interaction.guildId);
            const teamRoleIds = ticketStore.getSupportTeamRoleIds(teamData);

            if (!teamRoleIds.length) {
                return interaction.editReply(buildMessage(RESPONSES.configTitle, RESPONSES.configDescription, 0xED4245));
            }

            const previousType = ticket.ticketType;
            ticket.ticketType = ticketType.name;
            ticket.transferred = true;
            ticketStore.saveActiveStorage(activeStorage);

            const container = new ContainerBuilder().addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    RESPONSES.transferredBody
                        .replace('{from}', previousType || 'Unknown')
                        .replace('{to}', ticketType.name)
                        .replace('{user}', String(interaction.user))
                )
            );
            await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [container] });

            runDeferredTask(async () => {
                try {
                    for (const roleId of teamRoleIds) {
                        await ticketChannel.permissionOverwrites.edit(roleId, {
                            ViewChannel: true,
                            SendMessages: true
                        });
                        await sleep(250);
                    }
                } catch (error) {
                    await interaction.followUp(buildMessage(RESPONSES.warningTitle, RESPONSES.warningDescription, 0xFEE75C)).catch(() => null);
                    throw error;
                }
            });
        } catch (error) {
            console.error('Error running transfer command:', error);
            if (error?.code === 10062) return null;
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(buildMessage(RESPONSES.errorTitle, RESPONSES.errorDescription, 0xED4245)).catch(() => null);
            }
            return interaction.reply(buildMessage(RESPONSES.errorTitle, RESPONSES.errorDescription, 0xED4245)).catch(() => null);
        }
    }
};
