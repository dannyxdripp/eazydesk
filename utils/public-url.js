function trimTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

function normalizePublicBaseUrl(value) {
    const raw = trimTrailingSlashes(String(value || '').trim());
    if (!raw) return '';

    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const parsed = new URL(withProtocol);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return '';
    }
}

function getPublicBaseUrl() {
    const raw =
        process.env.PUBLIC_BASE_URL ||
        process.env.DASHBOARD_PUBLIC_URL ||
        process.env.TRANSCRIPT_PUBLIC_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        '';

    const configured = normalizePublicBaseUrl(raw);
    if (configured) return configured;

    const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3100);
    return `http://localhost:${port}`;
}

module.exports = { getPublicBaseUrl, normalizePublicBaseUrl };
