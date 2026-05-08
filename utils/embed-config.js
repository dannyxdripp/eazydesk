const DEFAULT_EMBED_TEMPLATES = {
    ticketClaimed: {
        color: '#57F287',
        title: 'Ticket Claimed',
        description: 'This ticket has been claimed by {claimer}.'
    },
    ticketUnclaimed: {
        color: '#FEE75C',
        title: 'Ticket Unclaimed',
        description: 'This ticket has been unclaimed (previous assignee: {previousAssignee}).'
    },
    closeRequestCreated: {
        color: '#FEE75C',
        title: 'Close Request Created',
        description: 'Requested by {requester}\nReason: {reason}\nAuto-close in **{timerLabel}** unless canceled.'
    },
    ticketClosed: {
        color: '#57F287',
        title: 'Ticket Closed',
        description: 'Closed by {closedBy}\nReason: {reason}'
    }
};

function getTemplatesFromStorage(ticketStore) {
    const config = ticketStore.getBotConfig();
    const templates = config?.embedTemplates;
    return templates && typeof templates === 'object' ? templates : {};
}

function resolveTemplate(ticketStore, key) {
    const defaults = DEFAULT_EMBED_TEMPLATES[key] || {};
    const current = getTemplatesFromStorage(ticketStore)[key];
    if (!current || typeof current !== 'object') return defaults;
    return { ...defaults, ...current };
}

function renderTemplateString(text, vars = {}) {
    return String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(vars[key] ?? ''));
}

function resolveEmbedPayload(ticketStore, key, vars = {}) {
    const template = resolveTemplate(ticketStore, key);
    const rawColor = String(template.color || '').replace('#', '');
    const parsedColor = Number.parseInt(rawColor, 16);
    return {
        color: Number.isNaN(parsedColor) ? 0x5865F2 : parsedColor,
        title: renderTemplateString(template.title, vars),
        description: renderTemplateString(template.description, vars)
    };
}

function normalizeTitleKey(title) {
    return String(title || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'untitled_embed';
}

function intColorToHex(color) {
    const value = Number(color);
    if (!Number.isFinite(value)) return '#5865F2';
    return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function resolveEmbedByTitle(ticketStore, title, description, color = 0x5865F2, vars = {}) {
    const key = `auto_${normalizeTitleKey(title)}`;
    const config = ticketStore.getBotConfig();
    const templates = config?.embedTemplates && typeof config.embedTemplates === 'object'
        ? { ...config.embedTemplates }
        : {};

    const defaultTitle = String(title || '');
    const defaultDescription = String(description || '');

    // Auto templates should not "freeze" dynamic content (eg `/availability` output).
    // Store pass-through placeholders by default, and render with `{title}` / `{description}` vars.
    if (!templates[key]) {
        templates[key] = {
            title: '{title}',
            description: '{description}',
            color: intColorToHex(color),
            __auto: true
        };
        ticketStore.setBotConfig({ embedTemplates: templates });
    } else {
        const existing = templates[key];
        // Best-effort migration for older auto templates that stored literal strings and therefore
        // prevented dynamic embeds from updating. Preserve previous values for recovery.
        if (existing && typeof existing === 'object' && key.startsWith('auto_') && existing.__auto !== true) {
            const rawTitle = String(existing.title ?? '');
            const rawDescription = String(existing.description ?? '');
            const hasTitleVars = rawTitle.includes('{') && rawTitle.includes('}');
            const hasDescVars = rawDescription.includes('{') && rawDescription.includes('}');

            // Only migrate if the template still uses the default title for this auto key.
            // This is a best-effort guard to avoid overwriting intentional customizations.
            if (!hasTitleVars && !hasDescVars && rawTitle === defaultTitle) {
                templates[key] = {
                    ...existing,
                    __legacyTitle: rawTitle,
                    __legacyDescription: rawDescription,
                    title: '{title}',
                    description: '{description}',
                    __auto: true,
                    __autoMigratedAt: new Date().toISOString()
                };
                ticketStore.setBotConfig({ embedTemplates: templates });
            }
        }
    }

    const template = templates[key] || {};
    const rawColor = String(template.color || intColorToHex(color)).replace('#', '');
    const parsedColor = Number.parseInt(rawColor, 16);
    const mergedVars = {
        ...vars,
        title: defaultTitle,
        description: defaultDescription
    };
    return {
        key,
        color: Number.isNaN(parsedColor) ? color : parsedColor,
        title: renderTemplateString(template.title || '{title}', mergedVars),
        description: renderTemplateString(template.description || '{description}', mergedVars)
    };
}

module.exports = {
    DEFAULT_EMBED_TEMPLATES,
    resolveEmbedPayload,
    resolveEmbedByTitle
};
