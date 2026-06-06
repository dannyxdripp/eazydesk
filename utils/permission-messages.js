const { PermissionsBitField } = require('discord.js');

const PERMISSION_LABELS = {
    [PermissionsBitField.Flags.CreateInstantInvite]: 'Create Instant Invite',
    [PermissionsBitField.Flags.ViewChannel]: 'View Channels',
    [PermissionsBitField.Flags.SendMessages]: 'Send Messages',
    [PermissionsBitField.Flags.EmbedLinks]: 'Embed Links',
    [PermissionsBitField.Flags.AttachFiles]: 'Attach Files',
    [PermissionsBitField.Flags.ReadMessageHistory]: 'Read Message History',
    [PermissionsBitField.Flags.UseApplicationCommands]: 'Use Application Commands',
    [PermissionsBitField.Flags.ManageChannels]: 'Manage Channels',
    [PermissionsBitField.Flags.ManageRoles]: 'Manage Roles',
    [PermissionsBitField.Flags.CreatePublicThreads]: 'Create Public Threads',
    [PermissionsBitField.Flags.SendMessagesInThreads]: 'Send Messages in Threads',
    [PermissionsBitField.Flags.ManageMessages]: 'Manage Messages'
};

function missingPermissionNames(permissions, required = []) {
    return required
        .filter(permission => !permissions?.has?.(permission))
        .map(permission => PERMISSION_LABELS[permission] || String(permission));
}

function channelMissingPermissionNames(channel, required = []) {
    const me = channel?.guild?.members?.me;
    if (!me || !channel || typeof channel.permissionsFor !== 'function') return required.map(permission => PERMISSION_LABELS[permission] || String(permission));
    return missingPermissionNames(channel.permissionsFor(me), required);
}

function describeChannelPermissionFailure(channel, required = [], action = 'do that') {
    const missing = channelMissingPermissionNames(channel, required);
    return missing.length
        ? `I cannot ${action} because I am missing: **${missing.join(', ')}**.`
        : `Discord blocked me from doing that. Check my role position and channel overwrites.`;
}

module.exports = {
    PERMISSION_LABELS,
    missingPermissionNames,
    channelMissingPermissionNames,
    describeChannelPermissionFailure
};
