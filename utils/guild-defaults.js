const ticketStore = require('./ticket-store');

function isTestGuild(guildId) {
    return Boolean(ticketStore.isTestGuild?.(guildId));
}

function getTestGuildEnvValue(key) {
    return String(process.env[key] || '').trim();
}

function getGuildConfig(guildId, storage = null) {
    return typeof ticketStore.getGuildConfig === 'function'
        ? ticketStore.getGuildConfig(guildId, storage || undefined)
        : {};
}

function resolveManagerRoleId(guildId, storage = null) {
    const guildConfig = getGuildConfig(guildId, storage);
    const configured = String(guildConfig?.managerRoleId || '').trim();
    if (configured) return configured;
    return isTestGuild(guildId) ? getTestGuildEnvValue('MANAGER_ROLE_ID') : '';
}

function resolveParentCategoryId(guildId, storage = null) {
    const guildConfig = getGuildConfig(guildId, storage);
    const configured = String(guildConfig?.parentCategoryId || '').trim();
    if (configured) return configured;
    return isTestGuild(guildId) ? getTestGuildEnvValue('PARENT_CATEGORY_ID') : '';
}

function resolveAppealsChannelId(guildId, storage = null) {
    const guildConfig = getGuildConfig(guildId, storage);
    const configured = String(guildConfig?.appealsChannelId || '').trim();
    if (configured) return configured;
    if (!isTestGuild(guildId)) return '';
    return String(
        process.env.FEEDBACK_CHANNEL_ID ||
        process.env.APPEALS_CHANNEL_ID ||
        ''
    ).trim();
}

function resolveTranscriptsChannelId(guildId, storage = null) {
    const guildConfig = getGuildConfig(guildId, storage);
    const configured = String(guildConfig?.transcriptsChannelId || '').trim();
    if (configured) return configured;
    return isTestGuild(guildId) ? getTestGuildEnvValue('TRANSCRIPTS_CHANNEL_ID') : '';
}

function resolveEscalationRoleId(guildId, level, storage = null) {
    const guildConfig = getGuildConfig(guildId, storage);
    const configured = String(guildConfig?.escalationRoles?.[level] || '').trim();
    if (configured) return configured;
    if (!isTestGuild(guildId)) return '';
    if (level === 'high') return getTestGuildEnvValue('ESCALATION_HIGH_ROLE_ID');
    if (level === 'immediate') return getTestGuildEnvValue('ESCALATION_IMMEDIATE_ROLE_ID');
    return '';
}

module.exports = {
    resolveManagerRoleId,
    resolveParentCategoryId,
    resolveAppealsChannelId,
    resolveTranscriptsChannelId,
    resolveEscalationRoleId
};
