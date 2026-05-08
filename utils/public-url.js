function trimTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getPublicBaseUrl() {
    const raw =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.PUBLIC_BASE_URL ||
        process.env.DASHBOARD_PUBLIC_URL ||
        process.env.TRANSCRIPT_PUBLIC_URL ||
        '';

    const configured = trimTrailingSlashes(String(raw || '').trim());
    if (configured) return configured;

    const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3100);
    return `http://localhost:${port}`;
}

module.exports = { getPublicBaseUrl };
