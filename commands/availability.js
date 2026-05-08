const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { resolveEmbedByTitle } = require('../utils/embed-config');
const ticketHandler = require('../handlers/ticket-handler');
const { buildV2FromTemplate } = require('../utils/components-v2-messages');
const { resolveManagerRoleId } = require('../utils/guild-defaults');

const STATUS_CHOICES = [
    { name: 'Available', value: 'available' },
    { name: 'Increased Volume', value: 'increased_volume' },
    { name: 'Reduced Assistance', value: 'reduced_assistance' },
    { name: 'Automatic (Clear Override)', value: 'auto' }
];

function toStatusLabel(status) {
    if (status === 'increased_volume') return 'Increased Volume';
    if (status === 'reduced_assistance') return 'Reduced Assistance';
    return 'Available';
}

function buildMessage(title, description, color = 0x5865F2) {
    return buildV2FromTemplate(ticketStore, resolveEmbedByTitle, title, description, color);
}

function hasAvailabilityPermission(interaction) {
    const managerRoleId = resolveManagerRoleId(interaction.guildId);
    if (managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId)) return true;
    return Boolean(
        interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('availability')
        .setDescription('View or set ticket availability per ticket type')
        .setDMPermission(false)
        .addStringOption(option => {
            option
                .setName('ticket_type')
                .setDescription('Ticket type to inspect or set')
                .setRequired(false)
                .setAutocomplete(true);

            return option;
        })
        .addStringOption(option =>
            option.setName('status')
                .setDescription('Status override for the selected ticket type')
                .setRequired(false)
                .addChoices(...STATUS_CHOICES)
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (!focused || focused.name !== 'ticket_type') return;

        const query = String(focused.value || '').trim().toLowerCase();
        const ticketTypes = ticketStore.getTicketTypesForGuild(interaction.guildId);
        const candidates = [
            { name: 'All ticket types', value: 'all' },
            ...ticketTypes.map(type => ({ name: String(type.name || '').trim(), value: String(type.name || '').trim() })).filter(t => t.value)
        ];

        const filtered = query
            ? candidates.filter(item => item.name.toLowerCase().includes(query) || item.value.toLowerCase().includes(query))
            : candidates;

        await interaction.respond(filtered.slice(0, 25));
    },

    async execute(interaction) {
        if (!interaction.inGuild()) {
            const base = buildMessage('Unavailable', 'This command can only be used in a server.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        if (!hasAvailabilityPermission(interaction)) {
            const managerRoleId = resolveManagerRoleId(interaction.guildId);
            const details = managerRoleId
                ? `You need the configured manager role (<@&${managerRoleId}>) or server management permissions.`
                : 'Configure the manager role in the Setup page (or set `MANAGER_ROLE_ID` only for the test guild fallback).';
            const base = buildMessage('Permission Denied', details, 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const selectedType = interaction.options.getString('ticket_type') || 'all';
        const selectedStatus = interaction.options.getString('status');
        const activeStorage = ticketStore.getActiveStorage();
        const guildId = interaction.guildId;
        const ticketTypes = ticketStore.getTicketTypesForGuild(interaction.guildId);

        if (selectedStatus) {
            if (selectedType === 'all') {
                if (selectedStatus !== 'auto') {
                    const base = buildMessage('Invalid Selection', 'Choose a specific ticket type when setting a status.', 0xED4245);
                    return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
                }

                if (!guildId || ticketStore.isTestGuild?.(guildId)) {
                    activeStorage.availabilityOverrides = {};
                    ticketStore.saveActiveStorage(activeStorage);
                } else {
                    ticketStore.setGuildConfig(guildId, { availabilityOverrides: {} }, activeStorage);
                }

                return interaction.reply(buildMessage(
                    'Ticket Availability Updated',
                    'Cleared manual overrides for **all** ticket types. Status now follows automatic thresholds.'
                ));
            }

            const ticketType = ticketStore.findTicketType(selectedType, guildId);
            if (!ticketType) {
                const base = buildMessage('Invalid Ticket Type', 'Invalid ticket type selected.', 0xED4245);
                return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
            }

            const key = ticketStore.normalizeType(ticketType.name);
            if (!guildId || ticketStore.isTestGuild?.(guildId)) {
                if (selectedStatus === 'auto') {
                    if (activeStorage.availabilityOverrides && typeof activeStorage.availabilityOverrides === 'object') {
                        delete activeStorage.availabilityOverrides[key];
                    }
                } else {
                    activeStorage.availabilityOverrides[key] = selectedStatus;
                }
                ticketStore.saveActiveStorage(activeStorage);
            } else {
                const guildConfig = ticketStore.getGuildConfig(guildId, activeStorage);
                const overrides = guildConfig?.availabilityOverrides && typeof guildConfig.availabilityOverrides === 'object'
                    ? { ...guildConfig.availabilityOverrides }
                    : {};
                if (selectedStatus === 'auto') delete overrides[key];
                else overrides[key] = selectedStatus;
                ticketStore.setGuildConfig(guildId, { availabilityOverrides: overrides }, activeStorage);
            }

            const refreshedStorage = ticketStore.getActiveStorage();
            const updated = ticketHandler.getEffectiveAvailability(refreshedStorage, ticketType.name, guildId);
            const mode = updated.source === 'manual' ? 'Manual Override' : 'Automatic Threshold';
            return interaction.reply(buildMessage(
                    'Ticket Availability Updated',
                    `Ticket type: **${ticketType.name}**\n` +
                    `Status: **${toStatusLabel(updated.status)}**\n` +
                    `Mode: **${mode}**\n` +
                    `Active tickets: **${updated.count}**`
                ));
        }

        if (selectedType === 'all') {
            const lines = ticketTypes.map(type => {
                const result = ticketHandler.getEffectiveAvailability(activeStorage, type.name, guildId);
                const mode = result.source === 'manual' ? 'manual' : 'auto';
                return `**${type.name}**: ${toStatusLabel(result.status)} (${result.count} active, ${mode})`;
            });

            return interaction.reply(buildMessage('Current Ticket Availability', lines.join('\n') || 'No ticket types found.'));
        }

        const ticketType = ticketStore.findTicketType(selectedType, interaction.guildId);
        if (!ticketType) {
            const base = buildMessage('Invalid Ticket Type', 'Invalid ticket type selected.', 0xED4245);
            return interaction.reply({ ...base, flags: MessageFlags.Ephemeral | base.flags });
        }

        const result = ticketHandler.getEffectiveAvailability(activeStorage, ticketType.name, guildId);
        const mode = result.source === 'manual' ? 'Manual Override' : 'Automatic Threshold';
        return interaction.reply(buildMessage(
            'Current Ticket Availability',
            `Ticket type: **${ticketType.name}**\n` +
            `Status: **${toStatusLabel(result.status)}**\n` +
            `Mode: **${mode}**\n` +
            `Active tickets: **${result.count}**`
        ));
    }
};
