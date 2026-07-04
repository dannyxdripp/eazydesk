const { MessageFlags } = require('discord.js');

function isUnknownInteractionError(error) {
    return error?.code === 10062 ||
        error?.rawError?.code === 10062 ||
        String(error?.message || '').toLowerCase().includes('unknown interaction');
}

function isAlreadyAcknowledgedError(error) {
    return error?.code === 40060 || error?.code === 'InteractionAlreadyReplied';
}

function withEphemeralFlag(payload) {
    const baseFlags = Number(payload?.flags || 0);
    return { ...(payload || {}), flags: baseFlags | MessageFlags.Ephemeral };
}

function editablePayload(payload) {
    const next = { ...(payload || {}) };
    if (next.flags !== undefined) {
        const editableFlags = Number(next.flags || 0) & ~MessageFlags.Ephemeral;
        if (editableFlags) next.flags = editableFlags;
        else delete next.flags;
    }
    return next;
}

async function safeDeferReply(interaction, options = {}) {
    if (!interaction || interaction.deferred || interaction.replied || typeof interaction.deferReply !== 'function') return false;
    try {
        await interaction.deferReply(options);
        return true;
    } catch (error) {
        if (!isUnknownInteractionError(error) && !isAlreadyAcknowledgedError(error)) throw error;
        return false;
    }
}

async function safeReply(interaction, payload, options = {}) {
    if (!interaction?.isRepliable?.()) return null;
    const response = options.ephemeral === false ? { ...(payload || {}) } : withEphemeralFlag(payload);
    try {
        if (interaction.deferred) {
            return await interaction.editReply(editablePayload(response));
        }
        if (interaction.replied) {
            return await interaction.followUp(response);
        }
        return await interaction.reply(response);
    } catch (error) {
        if (isUnknownInteractionError(error) || isAlreadyAcknowledgedError(error)) return null;
        throw error;
    }
}

function makeReplyAutoEdit(interaction) {
    if (!interaction || interaction.__replyAutoEditPatched) return;
    const originalReply = interaction.reply?.bind(interaction);
    const originalEditReply = interaction.editReply?.bind(interaction);
    const originalFollowUp = interaction.followUp?.bind(interaction);
    if (!originalReply || !originalEditReply || !originalFollowUp) return;

    interaction.reply = async payload => {
        if (interaction.deferred) {
            return originalEditReply(editablePayload(payload));
        }
        if (interaction.replied) {
            return originalFollowUp(payload);
        }
        return originalReply(payload);
    };
    interaction.__replyAutoEditPatched = true;
}

module.exports = {
    editablePayload,
    isAlreadyAcknowledgedError,
    isUnknownInteractionError,
    makeReplyAutoEdit,
    safeDeferReply,
    safeReply,
    withEphemeralFlag
};
