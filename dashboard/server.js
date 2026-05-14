const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { MessageFlags, ChannelType, PermissionsBitField } = require('discord.js');
const ticketStore = require('../utils/ticket-store');
const { getPublicBaseUrl } = require('../utils/public-url');
const { DEFAULT_EMBED_TEMPLATES } = require('../utils/embed-config');
const { getEffectiveAvailability } = require('../handlers/ticket-handler');
const { buildV2Notice } = require('../utils/components-v2-messages');
const closeRequestCommand = require('../commands/closerequest');
const { getTranscriptRetentionDays, resolveTranscriptPath, deleteTranscriptArchive } = require('../utils/transcript-archive');

let dashboardServer = null;
const ASSETS_DIR = path.join(__dirname, 'assets');
const COPYRIGHT_NAME = 'Sync Development';
let cachedHomeCss = { mtimeMs: 0, value: '' };

const transcriptOauthStates = new Map();
const transcriptSessions = new Map();
const TRANSCRIPT_SESSION_COOKIE = 'transcript_session';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TRANSCRIPT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const dashboardOauthStates = new Map();
const dashboardSessions = new Map();
const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

function randomToken(bytes = 24) {
    return crypto.randomBytes(Math.max(16, Number(bytes) || 24)).toString('base64url');
}

function getDiscordOAuthClientId() {
    return String(process.env.DISCORD_OAUTH_CLIENT_ID || process.env.DISCORD_CLIENT_ID || process.env.OAUTH_CLIENT_ID || '').trim();
}

function getDiscordOAuthClientSecret() {
    return String(process.env.DISCORD_OAUTH_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || process.env.OAUTH_CLIENT_SECRET || '').trim();
}

function hasDiscordOAuthConfigured() {
    return Boolean(getDiscordOAuthClientId() && getDiscordOAuthClientSecret());
}

function isTranscriptOAuthRequired() {
    const raw = String(process.env.TRANSCRIPT_REQUIRE_OAUTH ?? 'true').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getBotOwnerId() {
    return String(process.env.BOT_OWNER_ID || process.env.OWNER_USER_ID || process.env.OWNER_ID || '').trim();
}

function parseCsvUserIds(raw) {
    const out = [];
    for (const part of String(raw || '').split(',')) {
        const value = String(part || '').trim();
        if (/^\d{17,20}$/.test(value)) out.push(value);
    }
    return [...new Set(out)];
}

function getDashboardAllowedUserIds() {
    return parseCsvUserIds(process.env.DASHBOARD_ALLOWED_USER_IDS || process.env.DASHBOARD_OAUTH_ALLOWED_USER_IDS || '');
}

function isDashboardOAuthRequired() {
    const raw = String(process.env.DASHBOARD_REQUIRE_OAUTH ?? 'true').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function cleanupTranscriptAuthMaps() {
    const now = Date.now();

    for (const [state, entry] of transcriptOauthStates.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > OAUTH_STATE_TTL_MS) transcriptOauthStates.delete(state);
    }

    for (const [sessionId, entry] of transcriptSessions.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > TRANSCRIPT_SESSION_TTL_MS) transcriptSessions.delete(sessionId);
    }

    for (const [state, entry] of dashboardOauthStates.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > OAUTH_STATE_TTL_MS) dashboardOauthStates.delete(state);
    }

    for (const [sessionId, entry] of dashboardSessions.entries()) {
        const createdAt = Number(entry?.createdAt || 0);
        if (!createdAt || (now - createdAt) > TRANSCRIPT_SESSION_TTL_MS) dashboardSessions.delete(sessionId);
    }
}

setInterval(cleanupTranscriptAuthMaps, 5 * 60 * 1000).unref?.();

function getHomeCss() {
    try {
        const cssPath = path.join(ASSETS_DIR, 'styles.css');
        const stat = fs.statSync(cssPath);
        if (cachedHomeCss && cachedHomeCss.mtimeMs === stat.mtimeMs) return cachedHomeCss.value;
        const raw = fs.readFileSync(cssPath, 'utf8');
        const safe = String(raw || '').replace(/<\/style/gi, '<\\/style');
        cachedHomeCss = { mtimeMs: stat.mtimeMs, value: safe };
        return safe;
    } catch {
        return cachedHomeCss?.value || '';
    }
}

function getDashboardEnabled() {
    const configured = String(process.env.DASHBOARD_ENABLED || '').trim().toLowerCase();
    if (configured) return configured === 'true';
    return Boolean(process.env.PORT || process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
}

function getDashboardPort() {
    return Number(process.env.PORT || process.env.DASHBOARD_PORT || 3100);
}

function isDashboardPortConfigured() {
    return Boolean(String(process.env.PORT || process.env.DASHBOARD_PORT || '').trim());
}

function getDashboardHost() {
    const configured = String(process.env.DASHBOARD_HOST || '').trim();
    if (configured) return configured;

    if (process.env.PORT || process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
        return '0.0.0.0';
    }

    // Safer default: keep an unauthenticated dashboard bound to localhost.
    // If a token is configured, we allow remote access by default (0.0.0.0) unless overridden.
    return getDashboardToken() ? '0.0.0.0' : '127.0.0.1';
}

function getDashboardToken() {
    return String(process.env.DASHBOARD_TOKEN || '').trim();
}

function getDashboardOwnerToken() {
    return String(process.env.DASHBOARD_OWNER_TOKEN || '').trim();
}

function getDefaultAppealsChannelId() {
    return '';
}

function dashboardLog(message) { console.log(`[Dashboard \u{1F4E1}] ${message}`); }
function sendHtml(res, code, html) { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); } }
function sendJson(res, code, payload, headers = {}) { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(payload)); } }

function safeNextPath(value) {
    const next = String(value || '').trim();
    if (!next) return '/';
    if (next.startsWith('/t/')) return next;
    return '/';
}

function safeDashboardNextPath(value) {
    const next = String(value || '').trim();
    if (!next) return '/dashboard';
    if (!next.startsWith('/')) return '/dashboard';
    if (next.startsWith('//')) return '/dashboard';

    const basePath = next.split('?')[0].split('#')[0];
    const allowed = new Set([
        '/',
        '/dashboard',
        '/overview',
        '/settings',
        '/availability',
        '/tickets',
        '/transcripts',
        '/commands/ticket-types',
        '/commands/tag',
        '/commands/feedback',
        '/statistics',
        '/embed-editor',
        '/documentation',
        '/setup',
        '/controller'
    ]);

    if (allowed.has(basePath)) return next;
    if (basePath.startsWith('/t/')) return next;
    return '/dashboard';
}

function createHomeHtml(options = {}) {
    const year = new Date().getFullYear();
    const protectedMode = Boolean(getDashboardToken());
    const botConfig = ticketStore.getBotConfig();
    const homeImages = options.showOwnerGallery && Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [];
    const safeImages = homeImages
        .map(url => String(url || '').trim())
        .filter(url => /^https?:\/\//i.test(url))
        .slice(0, 6);
    const securityNote = protectedMode
        ? 'Dashboard access requires a token.'
        : 'Dashboard is running without a token (local-only by default).';

    const gallery = safeImages.length
        ? `<section class="gallery">
      <h2>Highlights</h2>
      <div class="gallery-grid">
        ${safeImages.map(url => `<a class="shot" href="${url}" target="_blank" rel="noreferrer"><img src="${url}" alt="Preview" loading="lazy" /></a>`).join('')}
      </div>
    </section>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tickets Dashboard</title>
  <link rel="icon" href="/assets/sync.png" />
  <style>${getHomeCss()}</style>
</head>
<body class="home">
  <div class="bg">
    <div class="orb o1"></div>
    <div class="orb o2"></div>
    <div class="orb o3"></div>
    <div class="grid"></div>
  </div>

  <header class="top">
    <div class="brand">
      <img src="/assets/sync.png" alt="eazyDesk" />
      <div class="brand-text">
        <div class="brand-title">eazyDesk</div>
        <div class="brand-sub">Support your customers with ease.</div>
      </div>
    </div>
    <nav class="nav">
      <a class="nav-link" href="/documentation">Documentation</a>
      <a class="nav-link" href="/dashboard">Dashboard</a>
    </nav>
  </header>

  <main class="hero">
    <section class="hero-card">
      <div class="kicker">Support &bull; Tickets &bull; Automations</div>
      <h1>Run support like a <span class="accent">pro.</span></h1>
      <p>
        Manage all the things for your bot with our new and improved sleek dashboard, no more bulky commands or confusing setups. Get it all in one place, and back doing what you do best.
      </p>
      <div class="cta">
        <a class="btn primary" href="/dashboard">Visit your Dashboard</a>
        <a class="btn ghost" href="/documentation">Documentation</a>
      </div>
      <div class="note">
        <span class="pill">${securityNote}</span>
      </div>
    </section>

    <section class="feature-grid">
      <div class="feature">
        <div class="feature-title">Glassy UI</div>
        <div class="feature-desc">A dark, blue-accented look with subtle glow&mdash;easy on the eyes.</div>
      </div>
      <div class="feature">
        <div class="feature-title">Safer by default</div>
        <div class="feature-desc">When no token is set, the dashboard binds to localhost only.</div>
      </div>
      <div class="feature">
        <div class="feature-title">Config-first</div>
        <div class="feature-desc">Make changes quickly without redeploying frontends.</div>
      </div>
    </section>

    ${gallery}
  </main>

  <footer class="footer">
    <div class="footer-inner">
      <div class="muted">&copy; ${year} ${COPYRIGHT_NAME} &mdash; Build ${new Date().toISOString()} &mdash; PID ${process.pid}</div>
      <div class="muted">Tickets Dashboard</div>
    </div>
  </footer>
</body>
</html>`;
}

function baseDashboardPage({ title, body, script = '' }) {
    const css = `
    :root{color-scheme:dark;--bg:#0b1020;--panel:rgba(17,20,36,.78);--tx:#f7f8ff;--mut:rgba(247,248,255,.66);--bd:rgba(255,255,255,.10);--acc:#38bdf8;--shadow:0 18px 50px rgba(0,0,0,.55)}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(700px 380px at 20% 10%,rgba(56,189,248,.18),transparent 55%),radial-gradient(650px 360px at 78% 20%,rgba(37,99,235,.16),transparent 60%),var(--bg);color:var(--tx);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    a{color:inherit}
    .wrap{max-width:1050px;margin:0 auto;padding:18px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--bd);backdrop-filter:blur(8px);position:sticky;top:0;background:rgba(8,10,20,.64);z-index:10}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none}
    .brand img{width:28px;height:28px}
    .title{font-size:18px;font-weight:800;letter-spacing:.2px}
    .nav{display:flex;gap:10px;flex-wrap:wrap}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;border-radius:14px;border:1px solid var(--bd);background:rgba(255,255,255,.03);text-decoration:none;cursor:pointer;transition:transform .15s ease,border-color .2s ease,background .2s ease}
    .btn:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.22);background:rgba(56,189,248,.10)}
    .btn.primary{background:linear-gradient(180deg,rgba(56,189,248,.22),rgba(56,189,248,.12));border-color:rgba(56,189,248,.35)}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    @media(max-width:860px){.grid{grid-template-columns:1fr}.nav{justify-content:flex-end}}
    .card{border:1px solid var(--bd);background:linear-gradient(180deg,rgba(17,20,36,.78),rgba(11,14,28,.78));box-shadow:var(--shadow);border-radius:18px;padding:14px}
    .muted{color:var(--mut)}
    label{display:block;margin:10px 0 6px;color:rgba(247,248,255,.75);font-size:12px}
    select,input{width:100%;padding:10px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(5,8,20,.78);color:var(--tx)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .list{margin-top:12px;display:grid;gap:10px}
    .item{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:18px;padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center}
    .item strong{font-size:14px}
    .pill{padding:3px 10px;border-radius:999px;border:1px solid rgba(56,189,248,.25);background:rgba(56,189,248,.10);color:rgba(247,248,255,.92);font-size:12px}
    .err{color:#fecaca;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.10);padding:10px 12px;border-radius:14px}
    `;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${String(title || 'Dashboard')}</title>
  <link rel="icon" href="/assets/sync.png" />
  <style>${css}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><img src="/assets/sync.png" alt="logo" /><div class="title">${String(title || 'Dashboard')}</div></a>
    <nav class="nav">
      <a class="btn" href="/dashboard">Servers</a>
      <a class="btn" href="/overview">Dashboard</a>
      <a class="btn" href="/setup">Setup</a>
      <a class="btn" href="/logout">Logout</a>
    </nav>
  </header>
  <main class="wrap">${body || ''}</main>
  <script>${script || ''}</script>
</body>
</html>`;
}

function createControllerHtml() {
    const body = `
      <div class="card">
        <h2 style="margin:0 0 6px">Controller Panel</h2>
        <div class="muted">Choose a server, jump into its dashboard, or restart setup when you need a clean pass.</div>
        <div id="ctrlError" class="err" style="display:none;margin-top:12px"></div>
        <div id="guildList" class="list"></div>
      </div>
    `;

    const script = `
      const list=document.getElementById('guildList');
      const err=document.getElementById('ctrlError');
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      async function api(path,opt){const r=await fetch(path,{credentials:'include',...(opt||{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function item(g){const icon=g.iconURL?'<img src=\"'+esc(g.iconURL)+'\" style=\"width:28px;height:28px;border-radius:10px\" />':'';const status=g.setupCompleted?'<span class=\"pill\">Setup complete</span>':'<span class=\"pill\">Step '+esc(g.setupStep||1)+'</span>';return '<div class=\"item\">'+
        '<div class=\"row\" style=\"gap:10px\">'+icon+'<div><strong>'+esc(g.name)+'</strong><div class=\"muted\">'+esc(g.id)+'</div></div>'+(g.memberCount?('<span class=\"pill\">'+esc(g.memberCount)+' members</span>'):'')+status+'</div>'+
        '<div class=\"row\">'+
          '<a class=\"btn primary\" href=\"/overview?guild='+encodeURIComponent(g.id)+'\">Open Dashboard</a>'+
          '<a class=\"btn\" href=\"/setup?guild='+encodeURIComponent(g.id)+'&page=1\">Open Setup</a>'+
          '<a class=\"btn\" href=\"/tickets?guild='+encodeURIComponent(g.id)+'\">Tickets</a>'+
          '<button class=\"btn\" data-restart=\"'+esc(g.id)+'\">Restart Setup</button>'+
        '</div>'+
      '</div>'}
      async function load(){try{const data=await api('/api/controller/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];list.innerHTML=guilds.length?guilds.map(item).join(''):'<div class=\"muted\">No guilds found. (Bot may not be ready yet.)</div>';for(const btn of document.querySelectorAll('[data-restart]')){btn.onclick=async()=>{try{btn.disabled=true;await api('/api/controller/setup/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:btn.getAttribute('data-restart')})});btn.textContent='Restarted';setTimeout(()=>{btn.textContent='Restart Setup';btn.disabled=false},1200)}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=false}}}}catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;

    return baseDashboardPage({ title: 'Controller', body, script });
}

function createServerPickerHtml() {
    const body = `
      <div class="card">
        <h2 style="margin:0 0 6px">Server Access</h2>
        <div class="muted">This shows the servers your Discord account is in, whether the bot is in them too, and what elevated permissions you have in each server.</div>
        <div id="guildError" class="err" style="display:none;margin-top:12px"></div>
        <div id="guildList" class="list"></div>
      </div>
    `;

    const script = `
      const list=document.getElementById('guildList');
      const err=document.getElementById('guildError');
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      async function api(path,opt){const r=await fetch(path,{credentials:'include',...(opt||{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function renderPerms(g){const tags=[];tags.push(g.botInServer?'<span class="pill">Bot in server</span>':'<span class="pill">Bot not in server</span>');tags.push(g.isOwner?'<span class="pill">Owner</span>':'');tags.push(g.isAdmin?'<span class="pill">Administrator</span>':'');tags.push(!g.isAdmin&&g.canManageGuild?'<span class="pill">Manage Server</span>':'');tags.push(!g.isAdmin&&!g.canManageGuild&&g.canManageChannels?'<span class="pill">Manage Channels</span>':'');return tags.filter(Boolean).join('')}
      function renderAction(g){if(g.botInServer&&g.canAccessDashboard)return '<a class="btn primary" href="/overview?guild='+encodeURIComponent(g.id)+'">Open Dashboard</a>';if(g.botInServer)return '<span class="muted">No dashboard permissions</span>';return '<span class="muted">Bot is not in this server</span>'}
      function item(g){const icon=g.iconURL?'<img src="'+esc(g.iconURL)+'" style="width:28px;height:28px;border-radius:10px" />':'';const detail=Array.isArray(g.permissionSummary)&&g.permissionSummary.length?g.permissionSummary.map(esc).join(' • '):'No elevated permissions';return '<div class="item">'+
        '<div style="display:grid;gap:8px;min-width:0">'+
          '<div class="row" style="gap:10px">'+icon+'<div><strong>'+esc(g.name)+'</strong><div class="muted">'+esc(g.id)+'</div></div>'+(g.memberCount?('<span class="pill">'+esc(g.memberCount)+' members</span>'):'')+'</div>'+
          '<div class="row">'+renderPerms(g)+'</div>'+
          '<div class="muted">'+detail+'</div>'+
        '</div>'+
        '<div class="row">'+renderAction(g)+'</div>'+
      '</div>'}
      async function load(){try{const data=await api('/api/dashboard/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];list.innerHTML=guilds.length?guilds.map(item).join(''):'<div class="muted">No servers found for this account.</div>'}catch(e){err.style.display='block';err.textContent=e.message}}load();
    `;

    return baseDashboardPage({ title: 'Servers', body, script });
}

function createSetupHtml() {
    const body = `
      <style>
        .setup-shell{display:grid;gap:16px}
        .setup-hero{display:grid;gap:14px}
        .setup-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
        .setup-title{font-size:28px;font-weight:800;letter-spacing:.02em}
        .setup-sub{max-width:760px}
        .setup-progress{position:relative;height:14px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid rgba(255,255,255,.08)}
        .setup-progress-bar{position:absolute;inset:0 auto 0 0;width:25%;border-radius:inherit;background:linear-gradient(90deg,rgba(56,189,248,.92),rgba(125,211,252,.72));box-shadow:0 0 22px rgba(56,189,248,.26);transition:width .35s ease}
        .setup-progress-bar::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.36),transparent);animation:setupShimmer 1.8s linear infinite}
        .setup-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
        .setup-step-pill{padding:12px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);transition:transform .25s ease,border-color .25s ease,background .25s ease,opacity .25s ease}
        .setup-step-pill.active{border-color:rgba(56,189,248,.5);background:rgba(56,189,248,.12);transform:translateY(-2px)}
        .setup-step-pill.done{border-color:rgba(87,242,135,.35);background:rgba(87,242,135,.10)}
        .setup-step-no{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(247,248,255,.52)}
        .setup-step-name{font-weight:700;margin-top:4px}
        .setup-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(320px,.9fr);gap:16px}
        .setup-panel{min-height:480px;position:relative;overflow:hidden}
        .setup-panel::before{content:"";position:absolute;inset:auto -60px -90px auto;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.20),transparent 70%);pointer-events:none}
        .setup-stage{display:none;animation:setupFade .28s ease}
        .setup-stage.active{display:block}
        .setup-stage h3{margin:0 0 6px}
        .setup-actions{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:18px}
        .setup-actions .row{display:flex;gap:10px;flex:1 1 260px}
        .setup-mini{display:grid;gap:10px}
        .setup-toggle{display:flex;align-items:flex-start;gap:12px;padding:14px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
        .setup-toggle input{width:auto;margin-top:4px}
        .setup-summary{display:grid;gap:10px;margin-top:14px}
        .setup-summary .item{align-items:flex-start}
        .setup-tag{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid rgba(56,189,248,.24);background:rgba(56,189,248,.08);font-size:12px}
        .setup-inline{display:flex;gap:10px;flex-wrap:wrap}
        .setup-inline > *{flex:1 1 180px}
        .setup-hint-list{display:grid;gap:10px}
        @keyframes setupFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        @keyframes setupShimmer{0%{transform:translateX(-120%)}100%{transform:translateX(140%)}}
        @media(max-width:940px){.setup-grid,.setup-steps{grid-template-columns:1fr}.setup-panel{min-height:auto}}
      </style>
      <div class="setup-shell">
        <div class="card setup-hero">
          <div class="setup-header">
            <div>
              <div class="setup-title">Server Setup</div>
              <div class="muted setup-sub">Walk through the setup in a few clean steps. You can create the needed channels from here, enable a small tutorial, and keep claimer access stable with role permanence.</div>
            </div>
            <a class="btn" id="setupOpenDashboardLink" href="/overview">Open Dashboard</a>
          </div>
          <div class="setup-progress"><div id="setupProgressBar" class="setup-progress-bar"></div></div>
          <div id="setupStepPills" class="setup-steps">
            <div class="setup-step-pill"><div class="setup-step-no">Step 1</div><div class="setup-step-name">Server</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 2</div><div class="setup-step-name">Channels</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 3</div><div class="setup-step-name">Roles</div></div>
            <div class="setup-step-pill"><div class="setup-step-no">Step 4</div><div class="setup-step-name">Finish</div></div>
          </div>
        </div>
        <div class="setup-grid">
          <div class="card setup-panel">
            <div id="setupError" class="err" style="display:none;margin-bottom:12px"></div>

            <section class="setup-stage" data-step="1">
              <h3>Pick the server</h3>
              <div class="muted">Choose the guild this setup should manage, then create or refresh its stored config.</div>
              <label>Guild</label>
              <select id="guildSelect"></select>
              <div class="setup-inline" style="margin-top:12px">
                <button id="initTemplate" class="btn primary" type="button">Create server config</button>
                <button id="restartSetup" class="btn" type="button" style="display:none">Restart setup</button>
              </div>
              <div class="setup-actions">
                <div class="row"></div>
                <div class="row"><button id="stepNext1" class="btn primary" type="button">Continue</button></div>
              </div>
            </section>

            <section class="setup-stage" data-step="2">
              <h3>Choose or create channels</h3>
              <div class="muted">Set the ticket category plus your feedback and transcript archive channels. If they do not exist yet, the bot can create them for you.</div>
              <label>Ticket Category</label>
              <select id="parentCategoryId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="category">Create a channel for me</button>
              </div>
              <label>Feedback Channel</label>
              <select id="appealsChannelId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="feedback">Create a channel for me</button>
              </div>
              <label>Transcripts Channel</label>
              <select id="transcriptsChannelId"></select>
              <div class="setup-inline" style="margin-top:10px">
                <button class="btn" type="button" data-create-kind="transcripts">Create a channel for me</button>
              </div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="1">Back</button></div>
                <div class="row">
                  <button id="saveChannels" class="btn" type="button">Save channels</button>
                  <button id="stepNext2" class="btn primary" type="button">Continue</button>
                </div>
              </div>
            </section>

            <section class="setup-stage" data-step="3">
              <h3>Roles and behaviour</h3>
              <div class="muted">Choose the manager role and a couple of setup toggles for how the bot should behave.</div>
              <label>Manager Role</label>
              <select id="managerRoleId"></select>
              <label>High Escalation Role</label>
              <select id="highEscalationRoleId"></select>
              <label>Immediate Escalation Role</label>
              <select id="immediateEscalationRoleId"></select>
              <div class="setup-mini" style="margin-top:12px">
                <label class="setup-toggle">
                  <input id="rolePermanence" type="checkbox" />
                  <div>
                    <strong>Role permanence</strong>
                    <div class="muted">When a support member claims a ticket, the bot keeps a direct overwrite on that ticket so they retain access even if roles change mid-conversation.</div>
                  </div>
                </label>
                <label class="setup-toggle">
                  <input id="tutorialEnabled" type="checkbox" />
                  <div>
                    <strong>Enable quick tutorial</strong>
                    <div class="muted">Shows a short getting-started guide in the dashboard so new staff know the intended flow.</div>
                  </div>
                </label>
              </div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="2">Back</button></div>
                <div class="row">
                  <button id="saveRoles" class="btn" type="button">Save roles</button>
                  <button id="stepNext3" class="btn primary" type="button">Review</button>
                </div>
              </div>
            </section>

            <section class="setup-stage" data-step="4">
              <h3>Review and finish</h3>
              <div class="muted">Check the summary below, save everything once more if needed, then mark setup complete.</div>
              <div id="setupSummary" class="setup-summary"></div>
              <div class="setup-actions">
                <div class="row"><button class="btn" type="button" data-go-step="3">Back</button></div>
                <div class="row">
                  <button id="saveSetup" class="btn" type="button">Save all</button>
                  <button id="markComplete" class="btn primary" type="button">Mark complete</button>
                </div>
              </div>
            </section>
          </div>

          <div class="card">
            <h3 style="margin:0 0 6px">Tutorial</h3>
            <div class="muted">Suggested flow after setup:</div>
            <div class="setup-hint-list" style="margin-top:12px">
              <div class="item"><strong>1. Post a ticket panel</strong><div class="muted">Use the dashboard or \`/set-panel\` to place the opener in your chosen channel.</div></div>
              <div class="item"><strong>2. Claim tickets</strong><div class="muted">Support members use \`/claim\` to take ownership so stats and metadata stay clean.</div></div>
              <div class="item"><strong>3. Close with transcript</strong><div class="muted">Use \`/closerequest\` or the close button so the transcript archive stays complete.</div></div>
            </div>
            <div class="muted" style="margin-top:12px">If you do not see a guild yet, let the bot finish logging in and refresh this page.</div>
          </div>
        </div>
      </div>
    `;

    const script = `
      const qs=new URLSearchParams(location.search);
      const err=document.getElementById('setupError');
      const dashboardLink=document.getElementById('setupOpenDashboardLink');
      const guildSelect=document.getElementById('guildSelect');
      const parentCategoryId=document.getElementById('parentCategoryId');
      const appealsChannelId=document.getElementById('appealsChannelId');
      const transcriptsChannelId=document.getElementById('transcriptsChannelId');
      const managerRoleId=document.getElementById('managerRoleId');
      const highEscalationRoleId=document.getElementById('highEscalationRoleId');
      const immediateEscalationRoleId=document.getElementById('immediateEscalationRoleId');
      const rolePermanence=document.getElementById('rolePermanence');
      const tutorialEnabled=document.getElementById('tutorialEnabled');
      const summary=document.getElementById('setupSummary');
      const saveBtn=document.getElementById('saveSetup');
      const doneBtn=document.getElementById('markComplete');
      const initBtn=document.getElementById('initTemplate');
      const restartBtn=document.getElementById('restartSetup');
      const progressBar=document.getElementById('setupProgressBar');
      const stepPills=[...document.querySelectorAll('#setupStepPills .setup-step-pill')];
      const stages=[...document.querySelectorAll('.setup-stage')];
      let currentStep=1;
      let setupLocked=false;
      function esc(s){return String(s||'').replace(/[&<>\"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[m]))}
      async function api(path,opt){const r=await fetch(path,{credentials:'include',...(opt||{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
      function opt(id,label,selected){return '<option value=\"'+esc(id)+'\" '+(selected?'selected':'')+'>'+esc(label)+'</option>'}
      function fillSelect(el,items,emptyLabel,selected){const rows=['<option value=\"\">'+esc(emptyLabel)+'</option>'].concat(items.map(it=>opt(it.id,it.label||it.name||it.id,selected===it.id)));el.innerHTML=rows.join('')}
      let catalogs={ roles:[], channels:[], categories:[] };
      function syncPageState(){if(guildSelect&&guildSelect.value)qs.set('guild',guildSelect.value);if(currentStep)qs.set('page',String(currentStep));history.replaceState(null,'','?'+qs.toString());if(dashboardLink)dashboardLink.href='/overview'+(guildSelect&&guildSelect.value?('?guild='+encodeURIComponent(guildSelect.value)):'');}
      function setLocked(locked){setupLocked=!!locked;for(const el of [parentCategoryId,appealsChannelId,transcriptsChannelId,managerRoleId,highEscalationRoleId,immediateEscalationRoleId,rolePermanence,tutorialEnabled]){if(el)el.disabled=setupLocked}for(const btn of document.querySelectorAll('[data-create-kind],#initTemplate,#saveChannels,#saveRoles,#saveSetup,#markComplete')){if(btn)btn.disabled=setupLocked}if(saveBtn)saveBtn.style.display=setupLocked?'none':'';if(doneBtn)doneBtn.style.display=setupLocked?'none':'';if(restartBtn)restartBtn.style.display=setupLocked?'':'none';}
      function gotoStep(step){const safe=Math.max(1,Math.min(4,Number(step)||1));currentStep=safe;stages.forEach(stage=>stage.classList.toggle('active',Number(stage.dataset.step)===safe));stepPills.forEach((pill,index)=>{const n=index+1;pill.classList.toggle('active',n===safe);pill.classList.toggle('done',n<safe)});if(progressBar)progressBar.style.width=(safe/4*100)+'%';syncPageState();renderSummary()}
      function configPayload(){return{guildId:guildSelect.value,parentCategoryId:parentCategoryId.value||null,appealsChannelId:appealsChannelId.value||null,transcriptsChannelId:transcriptsChannelId.value||null,managerRoleId:managerRoleId.value||null,escalationRoles:{high:highEscalationRoleId.value||null,immediate:immediateEscalationRoleId.value||null},rolePermanence:!!rolePermanence.checked,tutorialEnabled:!!tutorialEnabled.checked,setup:{step:currentStep}}}
      function readLabel(selectEl){if(!selectEl)return 'Not set';const option=selectEl.options[selectEl.selectedIndex];return option&&option.value?option.text:'Not set'}
      function renderSummary(){if(!summary)return;summary.innerHTML=''+
        '<div class=\"item\"><div><strong>Guild</strong><div class=\"muted\">'+esc(readLabel(guildSelect))+'</div></div><span class=\"setup-tag\">Step '+currentStep+' of 4</span></div>'+
        '<div class=\"item\"><div><strong>Ticket Category</strong><div class=\"muted\">'+esc(readLabel(parentCategoryId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Feedback Channel</strong><div class=\"muted\">'+esc(readLabel(appealsChannelId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Transcripts Channel</strong><div class=\"muted\">'+esc(readLabel(transcriptsChannelId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Manager Role</strong><div class=\"muted\">'+esc(readLabel(managerRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>High Escalation Role</strong><div class=\"muted\">'+esc(readLabel(highEscalationRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Immediate Escalation Role</strong><div class=\"muted\">'+esc(readLabel(immediateEscalationRoleId))+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Role Permanence</strong><div class=\"muted\">'+(rolePermanence.checked?'Enabled':'Disabled')+'</div></div></div>'+
        '<div class=\"item\"><div><strong>Tutorial</strong><div class=\"muted\">'+(tutorialEnabled.checked?'Enabled':'Disabled')+'</div></div></div>';}
      async function loadCatalogs(){const ch=await api('/api/channels');const cats=await api('/api/categories');const roles=await api('/api/roles');catalogs.channels=Array.isArray(ch.channels)?ch.channels:[];catalogs.categories=Array.isArray(cats.categories)?cats.categories:[];catalogs.roles=Array.isArray(roles.roles)?roles.roles:[];fillSelect(parentCategoryId,catalogs.categories,'Not set',null);const texts=catalogs.channels.filter(c=>c.type==='text');fillSelect(appealsChannelId,texts,'Not set',null);fillSelect(transcriptsChannelId,texts,'Not set',null);fillSelect(managerRoleId,catalogs.roles,'Optional',null);fillSelect(highEscalationRoleId,catalogs.roles,'Optional',null);fillSelect(immediateEscalationRoleId,catalogs.roles,'Optional',null)}
      async function loadGuilds(){const data=await api('/api/my/guilds');const guilds=Array.isArray(data.guilds)?data.guilds:[];guildSelect.innerHTML=guilds.map(g=>'<option value=\"'+esc(g.id)+'\">'+esc(g.name)+' ('+esc(g.id)+')</option>').join('')||'<option value=\"\">No guilds found</option>';const preset=qs.get('guild');if(preset&&guilds.some(g=>g.id===preset))guildSelect.value=preset;syncPageState()}
      async function loadConfig(){const gid=guildSelect.value; if(!gid) return; const data=await api('/api/guild-config?guildId='+encodeURIComponent(gid)); const c=data.config||{}; parentCategoryId.value=c.parentCategoryId||''; appealsChannelId.value=c.appealsChannelId||''; transcriptsChannelId.value=c.transcriptsChannelId||''; managerRoleId.value=c.managerRoleId||''; highEscalationRoleId.value=(c.escalationRoles&&c.escalationRoles.high)||''; immediateEscalationRoleId.value=(c.escalationRoles&&c.escalationRoles.immediate)||''; rolePermanence.checked=c.rolePermanence!==false; tutorialEnabled.checked=!!c.tutorialEnabled; setLocked(Boolean(c&&c.setup&&c.setup.completed)); const requestedPage=Number(qs.get('page')||0); const configStep=Number(c&&c.setup&&c.setup.step)||1; gotoStep(c&&c.setup&&c.setup.completed?4:(requestedPage||configStep));}
      async function saveConfig(extra){const payload={...configPayload(),...(extra||{})};await api('/api/guild-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}
      saveBtn.onclick=async()=>{try{err.style.display='none';await saveConfig();saveBtn.textContent='Saved';setTimeout(()=>saveBtn.textContent='Save all',1000)}catch(e){err.style.display='block';err.textContent=e.message}};
      doneBtn.onclick=async()=>{try{err.style.display='none';await saveConfig({setupComplete:true,setup:{step:4}});doneBtn.textContent='Completed';setTimeout(()=>doneBtn.textContent='Mark complete',1200);await loadConfig()}catch(e){err.style.display='block';err.textContent=e.message}};
      initBtn.onclick=async()=>{try{err.style.display='none';const gid=guildSelect.value;initBtn.disabled=true;await api('/api/guild-config/init',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:gid})});await loadConfig();initBtn.textContent='Created';setTimeout(()=>{initBtn.textContent='Create server config';initBtn.disabled=false},1200)}catch(e){err.style.display='block';err.textContent=e.message;initBtn.disabled=false}};
      restartBtn.onclick=async()=>{try{err.style.display='none';const gid=guildSelect.value;restartBtn.disabled=true;await api('/api/guild-config/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:gid})});await loadConfig();restartBtn.textContent='Restarted';setTimeout(()=>{restartBtn.textContent='Restart Setup';restartBtn.disabled=false},1200)}catch(e){err.style.display='block';err.textContent=e.message;restartBtn.disabled=false}};
      document.getElementById('saveChannels').onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:2}})}catch(e){err.style.display='block';err.textContent=e.message}};
      document.getElementById('saveRoles').onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:3}})}catch(e){err.style.display='block';err.textContent=e.message}};
      async function createChannel(kind){const gid=guildSelect.value;if(!gid)throw new Error('Pick a guild first.');const defaults={category:'Tickets',feedback:'ticket-feedback',transcripts:'ticket-transcripts'};const label=kind==='category'?'category':'channel';const name=prompt('Name for the new '+label+':',defaults[kind]||'tickets');if(name===null)return false;const trimmed=String(name||'').trim();if(!trimmed)throw new Error('A name is required.');await saveConfig({setup:{step:2}});const result=await api('/api/setup/create-channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guildId:gid,kind,name:trimmed,parentCategoryId:parentCategoryId.value||null})});await loadCatalogs();if(kind==='category')parentCategoryId.value=result.channel.id;else if(kind==='feedback')appealsChannelId.value=result.channel.id;else if(kind==='transcripts')transcriptsChannelId.value=result.channel.id;renderSummary();return true}
      document.querySelectorAll('[data-create-kind]').forEach(btn=>btn.onclick=async()=>{try{err.style.display='none';btn.disabled=true;const created=await createChannel(btn.getAttribute('data-create-kind'));if(created){btn.textContent='Created';setTimeout(()=>{btn.textContent='Create a channel for me';btn.disabled=setupLocked},1100)}else{btn.disabled=setupLocked}}catch(e){err.style.display='block';err.textContent=e.message;btn.disabled=setupLocked}});
      document.querySelectorAll('[data-go-step]').forEach(btn=>btn.onclick=()=>gotoStep(btn.getAttribute('data-go-step')));
      document.getElementById('stepNext1').onclick=()=>gotoStep(2);
      document.getElementById('stepNext2').onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:2}});gotoStep(3)}catch(e){err.style.display='block';err.textContent=e.message}};
      document.getElementById('stepNext3').onclick=async()=>{try{err.style.display='none';await saveConfig({setup:{step:3}});gotoStep(4)}catch(e){err.style.display='block';err.textContent=e.message}};
      [guildSelect,parentCategoryId,appealsChannelId,transcriptsChannelId,managerRoleId,highEscalationRoleId,immediateEscalationRoleId,rolePermanence,tutorialEnabled].forEach(el=>{if(el)el.onchange=renderSummary});
      guildSelect.onchange=async()=>{syncPageState();try{await api('/api/state?guild='+encodeURIComponent(guildSelect.value))}catch{};await loadCatalogs();await loadConfig();};
      (async()=>{try{gotoStep(1);await loadGuilds();try{await api('/api/state?guild='+encodeURIComponent(guildSelect.value))}catch{};await loadCatalogs();await loadConfig();renderSummary()}catch(e){err.style.display='block';err.textContent=e.message}})();
    `;

    return baseDashboardPage({ title: 'Setup', body, script });
}

function parseCookies(source) {
    const out = {};
    for (const part of String(source || '').split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function isAuthed(req) {
    const dashboardToken = getDashboardToken();
    const ownerToken = getDashboardOwnerToken();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;

    const tokenOk =
        (dashboardToken && (headerToken === dashboardToken || cookieToken === dashboardToken)) ||
        (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken));
    if (tokenOk) return true;

    if (hasDiscordOAuthConfigured()) {
        const userId = getDashboardSessionUserId(req);
        if (userId) return true;
    }

    if (!dashboardToken && !ownerToken) {
        return !isDashboardOAuthRequired();
    }

    return false;
}

function isOwnerAuthed(req) {
    const ownerToken = String(getDashboardOwnerToken() || getDashboardToken() || '').trim();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;

    if (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken)) return true;

    if (hasDiscordOAuthConfigured()) {
        const userId = getDashboardSessionUserId(req);
        if (userId && userId === getBotOwnerId()) return true;
    }

    if (!ownerToken) {
        return !isDashboardOAuthRequired();
    }

    return false;
}

function isBotOwnerUser(req) {
    const ownerId = getBotOwnerId();
    if (!ownerId) return false;
    const userId = getDashboardSessionUserId(req);
    return Boolean(userId && userId === ownerId);
}

function isStrictOwnerViewer(req) {
    const ownerToken = String(getDashboardOwnerToken() || '').trim();
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;
    if (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken)) return true;
    return isBotOwnerUser(req);
}

function cookieAttributes(options = {}) {
    const parts = [];
    if (options.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`Path=${options.path || '/'}`);
    parts.push(`SameSite=${options.sameSite || 'Lax'}`);
    if (options.secure) parts.push('Secure');
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`);
    return parts.join('; ');
}

function appendSetCookie(res, cookie) {
    try {
        const existing = res.getHeader('Set-Cookie');
        if (!existing) {
            res.setHeader('Set-Cookie', cookie);
            return;
        }
        if (Array.isArray(existing)) {
            res.setHeader('Set-Cookie', [...existing, cookie]);
            return;
        }
        res.setHeader('Set-Cookie', [String(existing), cookie]);
    } catch {}
}

function isHttpsPublicBaseUrl() {
    const base = String(getPublicBaseUrl() || '').toLowerCase();
    return base.startsWith('https://');
}

function setTranscriptSession(res, userId) {
    const sessionId = randomToken();
    transcriptSessions.set(sessionId, { userId: String(userId), createdAt: Date.now() });
    const cookie = `${TRANSCRIPT_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieAttributes({
        maxAge: Math.floor(TRANSCRIPT_SESSION_TTL_MS / 1000),
        secure: isHttpsPublicBaseUrl()
    })}`;
    res.setHeader('Set-Cookie', cookie);
    return sessionId;
}

function clearTranscriptSession(res) {
    const cookie = `${TRANSCRIPT_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure: isHttpsPublicBaseUrl() })}`;
    res.setHeader('Set-Cookie', cookie);
}

function getTranscriptSessionUserId(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const sessionId = String(cookies[TRANSCRIPT_SESSION_COOKIE] || '').trim();
    if (!sessionId) return null;
    const entry = transcriptSessions.get(sessionId);
    if (!entry) return null;
    const createdAt = Number(entry.createdAt || 0);
    if (!createdAt || (Date.now() - createdAt) > TRANSCRIPT_SESSION_TTL_MS) {
        transcriptSessions.delete(sessionId);
        return null;
    }
    return String(entry.userId || '').trim() || null;
}

function setDashboardSession(res, userId, guildIds = [], oauthGuilds = []) {
    const sessionId = randomToken();
    dashboardSessions.set(sessionId, {
        userId: String(userId),
        guildIds: Array.isArray(guildIds) ? guildIds.map(String) : [],
        oauthGuilds: Array.isArray(oauthGuilds)
            ? oauthGuilds.map(g => ({
                id: String(g?.id || '').trim(),
                name: String(g?.name || '').trim(),
                icon: String(g?.icon || '').trim() || null,
                owner: Boolean(g?.owner),
                permissions: String(g?.permissions || '0').trim() || '0'
            })).filter(g => /^\d{17,20}$/.test(g.id))
            : [],
        createdAt: Date.now()
    });
    const cookie = `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieAttributes({
        maxAge: Math.floor(TRANSCRIPT_SESSION_TTL_MS / 1000),
        secure: isHttpsPublicBaseUrl()
    })}`;
    res.setHeader('Set-Cookie', cookie);
    return sessionId;
}

function clearDashboardSession(res) {
    const cookie = `${DASHBOARD_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure: isHttpsPublicBaseUrl() })}`;
    res.setHeader('Set-Cookie', cookie);
}

function getDashboardSession(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const sessionId = String(cookies[DASHBOARD_SESSION_COOKIE] || '').trim();
    if (!sessionId) return null;
    const entry = dashboardSessions.get(sessionId);
    if (!entry) return null;
    const createdAt = Number(entry.createdAt || 0);
    if (!createdAt || (Date.now() - createdAt) > TRANSCRIPT_SESSION_TTL_MS) {
        dashboardSessions.delete(sessionId);
        return null;
    }
    return entry && typeof entry === 'object' ? entry : null;
}

function getDashboardSessionUserId(req) {
    const entry = getDashboardSession(req);
    return String(entry?.userId || '').trim() || null;
}

function getDashboardSessionGuildIds(req) {
    const entry = getDashboardSession(req);
    const list = Array.isArray(entry?.guildIds) ? entry.guildIds.map(String) : [];
    return [...new Set(list.filter(id => /^\d{17,20}$/.test(id)))];
}

function getDashboardSessionOauthGuilds(req) {
    const entry = getDashboardSession(req);
    const guilds = Array.isArray(entry?.oauthGuilds) ? entry.oauthGuilds : [];
    return guilds
        .map(g => ({
            id: String(g?.id || '').trim(),
            name: String(g?.name || '').trim(),
            icon: String(g?.icon || '').trim() || null,
            owner: Boolean(g?.owner),
            permissions: String(g?.permissions || '0').trim() || '0'
        }))
        .filter(g => /^\d{17,20}$/.test(g.id));
}

function summarizeOauthGuildPermissions(guild) {
    let permissions = 0n;
    try { permissions = BigInt(String(guild?.permissions || '0').trim() || '0'); } catch {}
    const isOwner = Boolean(guild?.owner);
    const isAdmin = (permissions & BigInt(PermissionsBitField.Flags.Administrator)) === BigInt(PermissionsBitField.Flags.Administrator);
    const canManageGuild = isOwner || isAdmin || ((permissions & BigInt(PermissionsBitField.Flags.ManageGuild)) === BigInt(PermissionsBitField.Flags.ManageGuild));
    const canManageChannels = isOwner || isAdmin || ((permissions & BigInt(PermissionsBitField.Flags.ManageChannels)) === BigInt(PermissionsBitField.Flags.ManageChannels));
    const permissionSummary = [];
    if (isOwner) permissionSummary.push('Server owner');
    if (isAdmin) permissionSummary.push('Administrator');
    if (!isAdmin && canManageGuild) permissionSummary.push('Manage Server');
    if (!isAdmin && !canManageGuild && canManageChannels) permissionSummary.push('Manage Channels');
    if (!permissionSummary.length) permissionSummary.push('No elevated permissions');

    return {
        isOwner,
        isAdmin,
        canManageGuild,
        canManageChannels,
        permissionSummary,
        canAccessDashboard: isOwner || isAdmin || canManageGuild
    };
}

function getGuildSupportRoleIds(guildId, storage = null) {
    const teams = ticketStore.getSupportTeamsForGuild(guildId, storage);
    const ids = [];
    for (const team of teams) {
        ids.push(...ticketStore.getSupportTeamRoleIds(team));
    }
    return [...new Set(ids.filter(id => /^\d{17,20}$/.test(String(id || ''))))];
}

async function getDashboardAccess(client, req, guildId = null) {
    const id = String(guildId || getDashboardGuild(client, req)?.id || '').trim();
    const ownerView = isStrictOwnerViewer(req);
    if (ownerView) {
        return {
            guildId: id || null,
            level: 'owner',
            isOwner: true,
            isManager: true,
            isStaff: true,
            canFullDashboard: true,
            canManageSettings: true,
            canManageAvailability: true,
            canManageTicketTypes: true,
            canManageEscalations: true,
            canViewTickets: true,
            canEditNotes: true,
            canViewTranscripts: true,
            canCloseTickets: true
        };
    }

    const userId = getDashboardSessionUserId(req);
    if (!userId || !id || !client?.guilds?.cache?.has?.(id)) {
        return {
            guildId: id || null,
            level: 'none',
            isOwner: false,
            isManager: false,
            isStaff: false,
            canFullDashboard: false,
            canManageSettings: false,
            canManageAvailability: false,
            canManageTicketTypes: false,
            canManageEscalations: false,
            canViewTickets: false,
            canEditNotes: false,
            canViewTranscripts: false,
            canCloseTickets: false
        };
    }

    const guild = client.guilds.cache.get(id);
    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
    if (!member) {
        return {
            guildId: id,
            level: 'none',
            isOwner: false,
            isManager: false,
            isStaff: false,
            canFullDashboard: false,
            canManageSettings: false,
            canManageAvailability: false,
            canManageTicketTypes: false,
            canManageEscalations: false,
            canViewTickets: false,
            canEditNotes: false,
            canViewTranscripts: false,
            canCloseTickets: false
        };
    }

    const storage = ticketStore.getActiveStorage();
    const guildConfig = ticketStore.getGuildConfig(id, storage);
    const managerRoleId = String(guildConfig?.managerRoleId || '').trim();
    const supportRoleIds = getGuildSupportRoleIds(id, storage);
    const adminLike = Boolean(
        member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild) ||
        member.permissions?.has?.(PermissionsBitField.Flags.Administrator)
    );
    const isManager = adminLike || (managerRoleId && member.roles?.cache?.has?.(managerRoleId));
    const isStaff = isManager || supportRoleIds.some(roleId => member.roles?.cache?.has?.(roleId));

    return {
        guildId: id,
        level: isManager ? 'manager' : (isStaff ? 'staff' : 'none'),
        isOwner: false,
        isManager,
        isStaff,
        canFullDashboard: false,
        canManageSettings: isManager,
        canManageAvailability: isManager,
        canManageTicketTypes: isManager,
        canManageEscalations: isManager,
        canViewTickets: isStaff,
        canEditNotes: isStaff,
        canViewTranscripts: isStaff,
        canCloseTickets: isManager
    };
}

async function ensureDashboardPermission(client, req, guildId, permission) {
    const access = await getDashboardAccess(client, req, guildId);
    return Boolean(access && access[permission]);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        if (!req || typeof req.on !== 'function') return resolve({});
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > 1500000) return reject(new Error('Body too large'));
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function sanitizeRoleIds(input) {
    const list = Array.isArray(input) ? input : [input];
    return [...new Set(list.map(v => String(v || '').trim()).filter(v => /^\d{17,20}$/.test(v)))];
}

function sanitizeList(input) {
    if (Array.isArray(input)) return [...new Set(input.map(v => String(v || '').trim()).filter(Boolean))];
    return [...new Set(String(input || '').split(/[\n,]+/).map(v => v.trim()).filter(Boolean))];
}

function sanitizeUrlList(input, max = 6) {
    const list = sanitizeList(input)
        .map(v => String(v || '').trim())
        .filter(v => /^https?:\/\//i.test(v));
    return list.slice(0, Math.max(0, Number(max) || 0));
}

function getDashboardGuild(client, req = null) {
    const cookies = parseCookies(req?.headers?.cookie);
    const cookieGuildId = String(cookies.dashboard_guild || '').trim();
    const userId = getDashboardSessionUserId(req);
    const ownerId = getBotOwnerId();

    let allowedGuildIds = null; // null = all guilds
    if (userId && client?.guilds?.cache) {
        if (ownerId && userId === ownerId) {
            allowedGuildIds = [...client.guilds.cache.keys()];
        } else {
            allowedGuildIds = getDashboardSessionGuildIds(req).filter(id => client.guilds.cache.has(id));
        }
    }

    if (cookieGuildId && client.guilds.cache.has(cookieGuildId)) {
        if (!Array.isArray(allowedGuildIds) || allowedGuildIds.includes(cookieGuildId)) {
            return client.guilds.cache.get(cookieGuildId);
        }
    }

    if (Array.isArray(allowedGuildIds) && allowedGuildIds.length) {
        return client.guilds.cache.get(allowedGuildIds[0]) || null;
    }

    return client.guilds.cache.first() || null;
}

function canManageGuild(client, req, guildId) {
    const id = String(guildId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return false;
    if (!client?.guilds?.cache?.has?.(id)) return false;

    // Token-based dashboard auth (DASHBOARD_TOKEN / DASHBOARD_OWNER_TOKEN) is treated as global admin.
    const headers = req?.headers || {};
    const h = headers['x-dashboard-token'];
    const headerToken = Array.isArray(h) ? h[0] : h;
    const cookieToken = parseCookies(headers.cookie).dashboard_token;
    const dashboardToken = getDashboardToken();
    const ownerToken = getDashboardOwnerToken();
    const tokenOk =
        (dashboardToken && (headerToken === dashboardToken || cookieToken === dashboardToken)) ||
        (ownerToken && (headerToken === ownerToken || cookieToken === ownerToken));
    if (tokenOk) return true;

    const userId = getDashboardSessionUserId(req);
    if (!userId) return false;
    const ownerId = getBotOwnerId();
    if (ownerId && userId === ownerId) return true;
    return getDashboardSessionGuildIds(req).includes(id);
}

async function getRoleCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    await guild.roles.fetch();
    return guild.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.hexColor && r.hexColor !== '#000000' ? r.hexColor : '#99AAB5' }));
}

async function getTextChannelCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    await guild.channels.fetch();
    return guild.channels.cache
        .filter(ch => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !ch.isThread())
        .sort((a, b) => {
            const posA = Number(a.rawPosition || 0);
            const posB = Number(b.rawPosition || 0);
            if (posA !== posB) return posA - posB;
            return String(a.name || '').localeCompare(String(b.name || ''));
        })
        .map(ch => ({ id: ch.id, name: ch.name || 'unnamed-channel', type: 'text' }));
}

async function getCategoryCatalog(client, req = null) {
    const guild = getDashboardGuild(client, req);
    if (!guild) return [];
    await guild.channels.fetch();
    return guild.channels.cache
        .filter(ch => ch && ch.type === ChannelType.GuildCategory)
        .sort((a, b) => {
            const posA = Number(a.rawPosition || 0);
            const posB = Number(b.rawPosition || 0);
            if (posA !== posB) return posA - posB;
            return String(a.name || '').localeCompare(String(b.name || ''));
        })
        .map(ch => ({ id: ch.id, name: ch.name || 'unnamed-category', type: 'category' }));
}

function summarizeStats(activeStorage, options = {}) {
    const guildId = options && options.guildId ? String(options.guildId) : null;
    const activeTickets = Number(options?.activeTickets || 0);
    const events = Array.isArray(activeStorage.staffStatsEvents) ? activeStorage.staffStatsEvents : [];
    const now = Date.now();
    const byDay = {};
    for (let i = 13; i >= 0; i -= 1) {
        const day = new Date(now - (i * 86400000)).toISOString().slice(0, 10);
        byDay[day] = { claimed: 0, closed: 0 };
    }
    let totalClaimed = 0;
    let totalClosed = 0;
    for (const event of events) {
        if (guildId && String(event?.guildId || '') !== guildId) continue;
        if (event?.createdBy && String(event.createdBy) === String(event.userId)) continue;
        const ts = Date.parse(event.createdAt || '');
        if (Number.isNaN(ts)) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        if (byDay[day]) {
            if (event.type === 'claimed') { byDay[day].claimed += 1; totalClaimed += 1; }
            if (event.type === 'closed') { byDay[day].closed += 1; totalClosed += 1; }
        }
    }
    return {
        totals: {
            activeTickets,
            totalClaimed,
            totalClosed
        },
        byDay,
        topCloseReasons: typeof ticketStore.getTopCloseRequestReasonsForGuild === 'function'
            ? ticketStore.getTopCloseRequestReasonsForGuild(30, guildId, null, 6, activeStorage)
            : ticketStore.getTopCloseRequestReasons(30, null, 6, activeStorage),
        tagUsage: Object.entries(options?.tagUsage || {}).map(([name, count]) => ({ name, count: Number(count || 0) })).sort((a, b) => b.count - a.count).slice(0, 8)
    };
}

async function getDashboardState(client, req = null) {
    const activeStorage = ticketStore.getActiveStorage();
    const botConfig = ticketStore.getBotConfig(activeStorage);
    const ownerView = isStrictOwnerViewer(req);
    const guild = getDashboardGuild(client, req);
    const access = await getDashboardAccess(client, req, guild?.id || null);
    if (guild) ticketStore.cleanupMissingTicketChannels(guild, activeStorage);
    const [roleCatalog, channelCatalog, categoryCatalog] = await Promise.all([
        getRoleCatalog(client, req),
        getTextChannelCatalog(client, req),
        getCategoryCatalog(client, req)
    ]);
    const guildId = guild?.id || null;
    const guildConfig = guildId ? ticketStore.getGuildConfig(guildId, activeStorage) : {};
    const ticketTypes = ticketStore.getTicketTypesForGuild(guildId);
    const ticketPool = (Array.isArray(activeStorage.tickets) ? activeStorage.tickets : []);
    const tickets = (guild
        ? ticketPool.filter(t => {
            if (!t || !t.channelId) return false;
            if (String(t.guildId || '') === String(guildId)) return true;
            return !t.guildId && guild?.channels?.cache?.has?.(String(t.channelId));
        })
        : [])
        .slice(0, 250)
        .map(t => ({
            channelId: String(t.channelId || ''),
            channelName: guild?.channels?.cache?.get(t.channelId)?.name || null,
            ticketType: t.ticketType || null,
            createdBy: t.createdBy || null,
            claimedBy: t.claimedBy || null,
            createdAt: t.createdAt || null,
            lastActivityAt: t.lastActivityAt || null,
            escalations: Array.isArray(t.escalations) ? t.escalations : [],
            notes: ticketStore.getTicketNotes(String(t.channelId || ''), activeStorage)
        }));

    const transcriptRetentionDays = getTranscriptRetentionDays();
    const transcriptPool = (Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : []);
    const transcripts = (guildId
        ? transcriptPool.filter(t => String(t?.guildId || '') === String(guildId))
        : transcriptPool)
        .slice()
        .sort((a, b) => Date.parse(b?.archivedAt || b?.closedAt || 0) - Date.parse(a?.archivedAt || a?.closedAt || 0))
        .slice(0, 500)
        .map(t => ({
            channelId: String(t?.channelId || ''),
            channelName: t?.channelName || null,
            ticketType: t?.ticketType || null,
            createdBy: t?.createdBy || null,
            claimedBy: t?.claimedBy || null,
            closedBy: t?.closedBy || null,
            createdAt: t?.createdAt || null,
            closedAt: t?.closedAt || t?.archivedAt || null,
            archivedAt: t?.archivedAt || null,
            closeReason: t?.closeReason || null,
            fileName: t?.fileName || null,
            size: typeof t?.size === 'number' ? t.size : null,
            escalations: Array.isArray(t?.escalations) ? t.escalations : [],
            notes: Array.isArray(t?.notes) ? t.notes : []
        }));
    return {
        guildId: guild?.id || null,
        access,
        ticketTypes,
        tickets,
        supportTeams: ticketStore.getSupportTeamsForGuild(guildId),
        tags: ticketStore.getTagsForGuild(guildId),
        roleCatalog,
        channelCatalog,
        categoryCatalog,
        statistics: summarizeStats(activeStorage, {
            guildId,
            activeTickets: tickets.length,
            tagUsage: typeof ticketStore.getTagUsageForGuild === 'function'
                ? ticketStore.getTagUsageForGuild(guildId, activeStorage)
                : (activeStorage.tagUsage || {})
        }),
        transcriptRetentionDays,
        transcripts,
        guildConfigSummary: {
            setup: guildConfig?.setup || {},
            tutorialEnabled: Boolean(guildConfig?.tutorialEnabled),
            rolePermanence: guildConfig?.rolePermanence !== false,
            panelConfig: guildConfig?.panelConfig && typeof guildConfig.panelConfig === 'object' ? guildConfig.panelConfig : {},
            escalationRoles: guildConfig?.escalationRoles && typeof guildConfig.escalationRoles === 'object' ? guildConfig.escalationRoles : {}
        },
        availability: ticketTypes.map(type => ({
            name: type.name,
            key: ticketStore.normalizeType(type.name),
            ...getEffectiveAvailability(activeStorage, type.name, guildId)
        })),
        botConfig: {
            appealsChannelId: guildConfig?.appealsChannelId || null,
            homeImages: ownerView && Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [],
            embedTemplates: botConfig.embedTemplates && typeof botConfig.embedTemplates === 'object'
                ? botConfig.embedTemplates
                : DEFAULT_EMBED_TEMPLATES
        }
    };
}

async function handleApi(req, res, url, client) {
    const { pathname } = url;
    const method = req.method || 'GET';

    if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        const dashboardToken = String(getDashboardToken() || '').trim();
        const ownerToken = String(getDashboardOwnerToken() || '').trim();
        const tokensConfigured = Boolean(dashboardToken || ownerToken);

        if (!tokensConfigured) {
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (token && (token === dashboardToken || token === ownerToken)) {
            sendJson(res, 200, { ok: true }, {
                'Set-Cookie': `dashboard_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`
            });
            return true;
        }

        sendJson(res, 401, { ok: false, error: 'Unauthorized token' });
        return true;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = [
            'dashboard_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
            `${DASHBOARD_SESSION_COOKIE}=; ${cookieAttributes({ maxAge: 0, secure: isHttpsPublicBaseUrl() })}`
        ];
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookies });
        return true;
    }

    if (!isAuthed(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return true;
    }

    if (method === 'GET' && pathname === '/api/state') {
        const state = await getDashboardState(client, req);
        state.isOwner = isStrictOwnerViewer(req);
        sendJson(res, 200, state);
        return true;
    }

    if (method === 'GET' && pathname === '/api/my/guilds') {
        const userId = getDashboardSessionUserId(req);
        if (!userId) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return true;
        }

        const ownerId = getBotOwnerId();
        const allowedGuildIds = ownerId && userId === ownerId
            ? [...client.guilds.cache.keys()]
            : getDashboardSessionGuildIds(req);

        const guilds = allowedGuildIds
            .filter(id => client?.guilds?.cache?.has?.(id))
            .map(id => client.guilds.cache.get(id))
            .filter(Boolean)
            .map(g => ({
                id: g.id,
                name: g.name,
                memberCount: g.memberCount ?? null,
                iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        sendJson(res, 200, { guilds });
        return true;
    }

    if (method === 'GET' && pathname === '/api/dashboard/guilds') {
        const userId = getDashboardSessionUserId(req);
        if (!userId) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return true;
        }

        const ownerId = getBotOwnerId();
        const isOwner = Boolean(ownerId && userId === ownerId);
        let guilds = [];

        if (isOwner) {
            guilds = [...(client?.guilds?.cache?.values?.() || [])]
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    memberCount: g.memberCount ?? null,
                    iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null,
                    botInServer: true,
                    isOwner: true,
                    isAdmin: true,
                    canManageGuild: true,
                    canManageChannels: true,
                    canAccessDashboard: true,
                    permissionSummary: ['Bot owner']
                }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        } else {
            guilds = getDashboardSessionOauthGuilds(req)
                .map(entry => {
                    const sharedGuild = client?.guilds?.cache?.get(entry.id) || null;
                    const perms = summarizeOauthGuildPermissions(entry);
                    return {
                        id: entry.id,
                        name: entry.name || sharedGuild?.name || 'Unknown Server',
                        memberCount: sharedGuild?.memberCount ?? null,
                        iconURL: entry.icon
                            ? `https://cdn.discordapp.com/icons/${entry.id}/${entry.icon}.png?size=64`
                            : (typeof sharedGuild?.iconURL === 'function' ? sharedGuild.iconURL({ extension: 'png', size: 64 }) : null),
                        botInServer: Boolean(sharedGuild),
                        ...perms,
                        canAccessDashboard: Boolean(sharedGuild) && perms.canAccessDashboard
                    };
                })
                .sort((a, b) => {
                    if (a.botInServer !== b.botInServer) return a.botInServer ? -1 : 1;
                    if (a.canAccessDashboard !== b.canAccessDashboard) return a.canAccessDashboard ? -1 : 1;
                    return String(a.name).localeCompare(String(b.name));
                });
        }

        sendJson(res, 200, { guilds });
        return true;
    }

    if (method === 'GET' && pathname === '/api/controller/guilds') {
        if (!isBotOwnerUser(req)) {
            sendJson(res, 403, { error: 'Owner user only' });
            return true;
        }

        const guilds = client?.guilds?.cache
            ? [...client.guilds.cache.values()].map(g => {
                const cfg = typeof ticketStore.getGuildConfig === 'function' ? ticketStore.getGuildConfig(g.id, ticketStore.getActiveStorage()) : {};
                return {
                    id: g.id,
                    name: g.name,
                    memberCount: g.memberCount ?? null,
                    iconURL: typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 64 }) : null,
                    setupCompleted: Boolean(cfg?.setup?.completed),
                    setupStep: Number(cfg?.setup?.step || 1)
                };
            }).sort((a, b) => String(a.name).localeCompare(String(b.name)))
            : [];

        sendJson(res, 200, { guilds, ownerId: getBotOwnerId() });
        return true;
    }

    if (method === 'GET' && pathname === '/api/guild-config') {
        const guildId = String(url.searchParams.get('guildId') || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const config = typeof ticketStore.getGuildConfig === 'function'
            ? ticketStore.getGuildConfig(guildId, ticketStore.getActiveStorage())
            : {};

        sendJson(res, 200, { guildId, config });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const activeStorage = ticketStore.getActiveStorage();
        const currentCfg = typeof ticketStore.getGuildConfig === 'function'
            ? ticketStore.getGuildConfig(guildId, activeStorage)
            : {};

        const next = {};
        for (const key of ['parentCategoryId', 'appealsChannelId', 'transcriptsChannelId', 'managerRoleId']) {
            const value = String(body[key] || '').trim();
            if (value && !/^\d{17,20}$/.test(value)) {
                sendJson(res, 400, { error: `Invalid ${key}` });
                return true;
            }
            if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = value || null;
        }

        if (body.escalationRoles && typeof body.escalationRoles === 'object') {
            const escalationRoles = {};
            for (const key of ['high', 'immediate']) {
                const value = String(body.escalationRoles[key] || '').trim();
                if (value && !/^\d{17,20}$/.test(value)) {
                    sendJson(res, 400, { error: `Invalid escalationRoles.${key}` });
                    return true;
                }
                escalationRoles[key] = value || null;
            }
            next.escalationRoles = escalationRoles;
        }

        if (body.panelConfig && typeof body.panelConfig === 'object') {
            next.panelConfig = {
                title: String(body.panelConfig.title || '').trim().slice(0, 120),
                description: String(body.panelConfig.description || '').trim().slice(0, 4000),
                advisory: String(body.panelConfig.advisory || '').trim().slice(0, 4000)
            };
        }

        if (Object.prototype.hasOwnProperty.call(body, 'rolePermanence')) {
            next.rolePermanence = Boolean(body.rolePermanence);
        }

        if (Object.prototype.hasOwnProperty.call(body, 'tutorialEnabled')) {
            next.tutorialEnabled = Boolean(body.tutorialEnabled);
        }

        if (Object.prototype.hasOwnProperty.call(body, 'setupComplete')) {
            next.setup = {
                ...(body.setup && typeof body.setup === 'object' ? body.setup : {}),
                completed: Boolean(body.setupComplete),
                completedAt: Boolean(body.setupComplete) ? new Date().toISOString() : null
            };
        } else if (body.setup && typeof body.setup === 'object') {
            next.setup = { ...body.setup };
        }

        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, next, activeStorage)
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || next });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config/init') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const activeStorage = ticketStore.getActiveStorage();
        const config = typeof ticketStore.bootstrapGuildConfig === 'function'
            ? ticketStore.bootstrapGuildConfig(guildId, { storage: activeStorage })
            : (typeof ticketStore.setGuildConfig === 'function' ? ticketStore.setGuildConfig(guildId, {}, activeStorage) : {});

        sendJson(res, 200, { ok: true, guildId, config: config || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/guild-config/restart') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const now = new Date().toISOString();
        const userId = getDashboardSessionUserId(req) || getBotOwnerId() || null;
        const activeStorage = ticketStore.getActiveStorage();
        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, { setup: { completed: false, restartedAt: now, restartedBy: userId } }, activeStorage)
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/controller/setup/restart') {
        if (!isBotOwnerUser(req)) {
            sendJson(res, 403, { error: 'Owner user only' });
            return true;
        }

        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }

        const now = new Date().toISOString();
        const updated = typeof ticketStore.setGuildConfig === 'function'
            ? ticketStore.setGuildConfig(guildId, { setup: { completed: false, restartedAt: now, restartedBy: getBotOwnerId() } }, ticketStore.getActiveStorage())
            : null;

        sendJson(res, 200, { ok: true, guildId, config: updated || {} });
        return true;
    }

    if (method === 'POST' && pathname === '/api/setup/create-channel') {
        const body = await readBody(req);
        const guildId = String(body.guildId || '').trim();
        if (!/^\d{17,20}$/.test(guildId)) {
            sendJson(res, 400, { error: 'Invalid guildId' });
            return true;
        }
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        const guild = client?.guilds?.cache?.get(guildId) || await client?.guilds?.fetch?.(guildId).catch(() => null);
        if (!guild) {
            sendJson(res, 404, { error: 'Guild not found' });
            return true;
        }

        const kind = String(body.kind || '').trim().toLowerCase();
        const requestedName = String(body.name || '').trim();
        const parentCategoryId = String(body.parentCategoryId || '').trim();
        const defaults = {
            category: 'Tickets',
            feedback: 'ticket-feedback',
            transcripts: 'ticket-transcripts'
        };
        if (!['category', 'feedback', 'transcripts'].includes(kind)) {
            sendJson(res, 400, { error: 'Invalid channel kind' });
            return true;
        }

        const safeName = (requestedName || defaults[kind])
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 90)
            .replace(/^-|-$/g, '') || defaults[kind].toLowerCase();

        const channel = await guild.channels.create({
            name: safeName,
            type: kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText,
            parent: kind === 'category' ? null : (/^\d{17,20}$/.test(parentCategoryId) ? parentCategoryId : null)
        }).catch(() => null);

        if (!channel) {
            sendJson(res, 500, { error: 'Failed to create channel. Check bot permissions.' });
            return true;
        }

        sendJson(res, 200, {
            ok: true,
            channel: {
                id: channel.id,
                name: channel.name,
                type: kind === 'category' ? 'category' : 'text'
            }
        });
        return true;
    }

    if (method === 'GET' && pathname === '/api/roles') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { roles: await getRoleCatalog(client, req) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/channels') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { channels: await getTextChannelCatalog(client, req) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/categories') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageSettings'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, { categories: await getCategoryCatalog(client, req) });
        return true;
    }

    if (method === 'GET' && pathname === '/api/config') {
        const botConfig = ticketStore.getBotConfig();
        const ownerView = isStrictOwnerViewer(req);
        sendJson(res, 200, {
            appealsChannelId: botConfig.appealsChannelId || getDefaultAppealsChannelId(),
            homeImages: ownerView && Array.isArray(botConfig.homeImages) ? botConfig.homeImages : [],
            embedTemplates: botConfig.embedTemplates && typeof botConfig.embedTemplates === 'object'
                ? botConfig.embedTemplates
                : DEFAULT_EMBED_TEMPLATES
        });
        return true;
    }

    if (method === 'POST' && pathname === '/api/config') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const appealsChannelId = String(body.appealsChannelId || '').trim();
        if (appealsChannelId && !/^\d{17,20}$/.test(appealsChannelId)) {
            sendJson(res, 400, { error: 'Invalid appeals channel id' });
            return true;
        }

        const homeImages = sanitizeUrlList(body.homeImages, 6);
        const next = { appealsChannelId: appealsChannelId || getDefaultAppealsChannelId() };
        if (homeImages.length) next.homeImages = homeImages;
        else if (body.homeImages) next.homeImages = [];

        const config = ticketStore.setBotConfig(next);
        sendJson(res, 200, { ok: true, config });
        return true;
    }

    if (method === 'POST' && pathname === '/api/config/embeds') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner access required' });
            return true;
        }
        const body = await readBody(req);
        const nextTemplates = body?.embedTemplates;
        if (!nextTemplates || typeof nextTemplates !== 'object') {
            sendJson(res, 400, { error: 'embedTemplates object is required' });
            return true;
        }
        const config = ticketStore.setBotConfig({ embedTemplates: nextTemplates });
        sendJson(res, 200, { ok: true, config });
        return true;
    }

    if (method === 'POST' && pathname === '/api/availability') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageAvailability'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const ticketType = ticketStore.findTicketType(body.ticketType, guildId);
        const status = String(body.status || '').trim();
        const allowed = new Set(['available', 'increased_volume', 'reduced_assistance', 'auto']);
        if (!ticketType || !allowed.has(status)) {
            sendJson(res, 400, { error: 'Invalid ticket type or status' });
            return true;
        }
        const active = ticketStore.getActiveStorage();
        const key = ticketStore.normalizeType(ticketType.name);
        if (!guildId || ticketStore.isTestGuild?.(guildId)) {
            if (status === 'auto') {
                if (active.availabilityOverrides && typeof active.availabilityOverrides === 'object') delete active.availabilityOverrides[key];
            } else {
                if (!active.availabilityOverrides || typeof active.availabilityOverrides !== 'object') active.availabilityOverrides = {};
                active.availabilityOverrides[key] = status;
            }
            ticketStore.saveActiveStorage(active);
        } else {
            const cfg = ticketStore.getGuildConfig(guildId, active);
            const current = cfg?.availabilityOverrides && typeof cfg.availabilityOverrides === 'object' ? cfg.availabilityOverrides : {};
            const next = { ...current };
            if (status === 'auto') delete next[key];
            else next[key] = status;
            ticketStore.setGuildConfig(guildId, { availabilityOverrides: next }, active);
        }
        sendJson(res, 200, { ok: true, ticketType: ticketType.name, status });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket-type/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Ticket type name is required' });
            return true;
        }
        const categoryId = String(body.categoryId || '').trim();
        if (categoryId && !/^\d{17,20}$/.test(categoryId)) {
            sendJson(res, 400, { error: 'Invalid category id' });
            return true;
        }
        const roleIds = sanitizeRoleIds(body.roleIds);
        const nextType = {
            name,
            format: String(body.format || `#${ticketStore.toTicketSelectValue(name)}-{username}`).trim(),
            roleIds,
            aliases: sanitizeList(body.aliases),
            embedColor: String(body.embedColor || '#5865F2').trim(),
            emoji: String(body.emoji || '').trim(),
            requireReason: body.requireReason !== false,
            allowAttachments: body.allowAttachments !== false
        };
        if (categoryId) nextType.categoryId = categoryId;
        const openTitle = String(body.openTitle || '').trim();
        const openDescription = String(body.openDescription || '').trim();
        if (openTitle || openDescription) {
            nextType.openEmbed = {
                title: openTitle || '{ticketType}',
                description: openDescription || 'Requester: {requester}\\nReason: {reason}'
            };
        }
        const savedType = ticketStore.upsertTicketType(nextType, guildId);
        const existingTeam = ticketStore.findSupportTeamForTicketType(name, guildId);
        ticketStore.upsertSupportTeam({
            name,
            roleIds,
            roleId: roleIds[0] || null,
            emoji: existingTeam?.emoji || nextType.emoji
        }, guildId);
        sendJson(res, 200, { ok: true, ticketType: savedType });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket-type/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Ticket type name is required' });
            return true;
        }
        const removed = ticketStore.deleteTicketTypeByName(name, guildId);
        // Keep support teams in sync (teams are keyed by the same "name" label).
        ticketStore.deleteSupportTeamByName(name, guildId);

        const active = ticketStore.getActiveStorage();
        const key = ticketStore.normalizeType(name);
        if (!guildId || ticketStore.isTestGuild?.(guildId)) {
            if (active.availabilityOverrides && typeof active.availabilityOverrides === 'object') {
                delete active.availabilityOverrides[key];
                ticketStore.saveActiveStorage(active);
            }
        } else {
            const cfg = ticketStore.getGuildConfig(guildId, active);
            const current = cfg?.availabilityOverrides && typeof cfg.availabilityOverrides === 'object' ? cfg.availabilityOverrides : {};
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                const next = { ...current };
                delete next[key];
                ticketStore.setGuildConfig(guildId, { availabilityOverrides: next }, active);
            }
        }

        sendJson(res, 200, { ok: removed });
        return true;
    }

    if (method === 'POST' && pathname === '/api/support-team/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Support team name is required' });
            return true;
        }
        const supportTeam = ticketStore.upsertSupportTeam({
            name,
            roleIds: sanitizeRoleIds(body.roleIds),
            roleId: sanitizeRoleIds(body.roleIds)[0] || null,
            emoji: String(body.emoji || '').trim()
        }, guildId);
        sendJson(res, 200, { ok: true, supportTeam });
        return true;
    }

    if (method === 'POST' && pathname === '/api/support-team/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Support team name is required' });
            return true;
        }
        sendJson(res, 200, { ok: ticketStore.deleteSupportTeamByName(name, guildId) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tag/upsert') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Tag name is required' });
            return true;
        }
        const kindRaw = String(body.kind || 'suggestion').trim().toLowerCase();
        const kind = kindRaw === 'solution' ? 'solution' : 'suggestion';
        const existing = ticketStore.findTagByName(name, guildId);
        const tag = ticketStore.upsertTag({
            name,
            kind,
            title: String(body.title || name).trim(),
            description: String(body.description || '').trim(),
            keywords: sanitizeList(body.keywords),
            updatedAt: new Date().toISOString(),
            createdAt: existing?.createdAt || new Date().toISOString()
        }, guildId);
        sendJson(res, 200, { ok: true, tag });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tag/delete') {
        const body = await readBody(req);
        const dashboardGuildId = getDashboardGuild(client, req)?.id || null;
        const guildId = String(body.guildId || '').trim() || dashboardGuildId;
        if (guildId && !(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const name = String(body.name || '').trim();
        if (!name) {
            sendJson(res, 400, { error: 'Tag name is required' });
            return true;
        }
        sendJson(res, 200, { ok: ticketStore.deleteTagByName(name, guildId) });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/close') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const reason = String(body.reason || 'Closed via dashboard.').trim();
        if (!/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid channel id' });
            return true;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            sendJson(res, 404, { error: 'Channel not found or not text based' });
            return true;
        }

        const guild = getDashboardGuild(client, req);
        if (guild && channel.guildId && String(channel.guildId) !== String(guild.id)) {
            sendJson(res, 403, { error: 'Channel does not belong to the selected dashboard guild' });
            return true;
        }

        if (!(await ensureDashboardPermission(client, req, channel.guildId || guild?.id || null, 'canCloseTickets'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }

        await closeRequestCommand.closeTicketWithTranscript(channel, reason, null);
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (method === 'POST' && pathname === '/api/tickets/mass-close') {
        const body = await readBody(req);
        const rawType = String(body.ticketType || '').trim();
        const filterKey = ticketStore.normalizeType(rawType);
        const limit = Math.min(100, Math.max(1, Number(body.limit || 25)));
        const reason = String(body.reason || 'Mass closed via dashboard.').trim();

        const activeStorage = ticketStore.getActiveStorage();
        const guild = getDashboardGuild(client, req);
        if (!(await ensureDashboardPermission(client, req, guild?.id || null, 'canCloseTickets'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        if (guild) ticketStore.cleanupMissingTicketChannels(guild, activeStorage);

        const tickets = (Array.isArray(activeStorage.tickets) ? activeStorage.tickets : [])
            .filter(t => {
                if (!t || !t.channelId) return false;
                if (guild) {
                    if (t.guildId && String(t.guildId || '') !== String(guild.id)) return false;
                    if (!t.guildId && !guild?.channels?.cache?.has?.(String(t.channelId))) return false;
                }
                if (filterKey && ticketStore.normalizeType(t.ticketType) !== filterKey) return false;
                return true;
            })
            .slice(0, limit);

        let closed = 0;
        const failed = [];

        for (const ticket of tickets) {
            const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                failed.push({ channelId: ticket.channelId, error: 'Channel not found' });
                continue;
            }
            try {
                await closeRequestCommand.closeTicketWithTranscript(channel, reason, null);
                closed += 1;
            } catch (error) {
                failed.push({ channelId: ticket.channelId, error: String(error?.message || error) });
            }
            await new Promise(r => setTimeout(r, 350));
        }

        sendJson(res, 200, { ok: true, closed, failed });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/note') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const note = String(body.note || '').trim();
        if (!/^\d{17,20}$/.test(channelId) || !note) {
            sendJson(res, 400, { error: 'Valid channelId and note are required' });
            return true;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        const guildId = channel?.guildId || getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canEditNotes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const entry = ticketStore.addTicketNote(channelId, {
            body: note,
            authorId: getDashboardSessionUserId(req) || getBotOwnerId() || null
        });
        sendJson(res, 200, { ok: true, note: entry });
        return true;
    }

    if (method === 'POST' && pathname === '/api/ticket/escalate') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const level = String(body.level || '').trim().toLowerCase();
        const allowedLevels = new Set(['medium', 'high', 'immediate']);
        if (!/^\d{17,20}$/.test(channelId) || !allowedLevels.has(level)) {
            sendJson(res, 400, { error: 'Valid channelId and escalation level are required' });
            return true;
        }
        const activeStorage = ticketStore.getActiveStorage();
        const ticket = ticketStore.getTicketByChannelId(channelId, activeStorage);
        if (!ticket) {
            sendJson(res, 404, { error: 'Ticket not found' });
            return true;
        }
        const guildId = String(ticket.guildId || '').trim() || getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageEscalations'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const entry = {
            level,
            escalatedBy: getDashboardSessionUserId(req) || getBotOwnerId() || null,
            timestamp: new Date().toISOString()
        };
        if (!Array.isArray(ticket.escalations)) ticket.escalations = [];
        ticket.escalations.push(entry);
        ticketStore.saveActiveStorage(activeStorage);
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
            const guildConfig = ticketStore.getGuildConfig(guildId, activeStorage);
            const escalationRoleId = level === 'high'
                ? String(guildConfig?.escalationRoles?.high || '').trim()
                : level === 'immediate'
                    ? String(guildConfig?.escalationRoles?.immediate || '').trim()
                    : '';
            const escalationPing = escalationRoleId ? `<@&${escalationRoleId}>` : '';
            const color = level === 'immediate' ? 0xFFFFFF : level === 'high' ? 0xFF0000 : 0xFEE75C;
            const description = level === 'immediate'
                ? 'This ticket has been escalated to Immediate Response. Immediate action required!'
                : level === 'high'
                    ? 'This ticket has been escalated to High Priority.'
                    : 'This ticket has been escalated to Medium Priority.';
            await channel.send(buildV2Notice('Ticket Escalated', escalationPing ? `${escalationPing}\n\n${description}` : description, color)).catch(() => null);
        }
        sendJson(res, 200, { ok: true, escalation: entry });
        return true;
    }

    if (method === 'POST' && pathname === '/api/transcript/delete') {
        if (!isOwnerAuthed(req)) {
            sendJson(res, 403, { error: 'Owner token required to delete transcripts.' });
            return true;
        }
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        if (!/^\d{17,20}$/.test(channelId)) {
            sendJson(res, 400, { error: 'Invalid channel id' });
            return true;
        }
        const result = deleteTranscriptArchive(channelId);
        sendJson(res, 200, { ok: Boolean(result.removedEntry || result.removedFile), ...result });
        return true;
    }

    if (method === 'POST' && pathname === '/api/embed/publish') {
        const body = await readBody(req);
        const channelId = String(body.channelId || '').trim();
        const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
        const forceV2 = Boolean(body.forceV2);
        if (!/^\d{17,20}$/.test(channelId) || !payload) {
            sendJson(res, 400, { error: 'Invalid channel id or payload' });
            return true;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            sendJson(res, 404, { error: 'Channel not found or not text based' });
            return true;
        }

        let nextPayload = { ...payload };

        if (forceV2 && Array.isArray(nextPayload.embeds) && nextPayload.embeds.length) {
            const embed = nextPayload.embeds[0] || {};
            const title = String(embed.title || 'Message').slice(0, 256);
            const description = String(embed.description || '').slice(0, 4000);
            const color = Number(embed.color || 0x5865F2) || 0x5865F2;
            const base = buildV2Notice(title, description, color);
            nextPayload = {
                ...base,
                components: [...base.components, ...(Array.isArray(nextPayload.components) ? nextPayload.components : [])]
            };
        }

        const hasV2TopLevelComponent = Array.isArray(nextPayload.components) && nextPayload.components.some(c => Number(c?.type) !== 1);
        if (forceV2 || hasV2TopLevelComponent) {
            nextPayload.flags = MessageFlags.IsComponentsV2;
            delete nextPayload.content;
            delete nextPayload.embeds;
            delete nextPayload.stickers;
            delete nextPayload.poll;
        }

        const message = await channel.send(nextPayload);
        sendJson(res, 200, { ok: true, messageId: message.id });
        return true;
    }

    if (method === 'GET' && pathname === '/api/statistics') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        sendJson(res, 200, summarizeStats(ticketStore.getActiveStorage()));
        return true;
    }

    if (method === 'POST' && pathname === '/api/staff/lookup') {
        const guildId = getDashboardGuild(client, req)?.id || null;
        if (!(await ensureDashboardPermission(client, req, guildId, 'canManageTicketTypes'))) {
            sendJson(res, 403, { error: 'Forbidden' });
            return true;
        }
        const body = await readBody(req);
        const raw = String(body.query || '').trim();
        const match = raw.match(/\d{17,20}/);
        if (!match) {
            sendJson(res, 400, { error: 'Provide a user id or mention.' });
            return true;
        }
        const userId = match[0];
        const user = await client.users.fetch(userId).catch(() => null);
        const activeStorage = ticketStore.getActiveStorage();
        const stats7 = ticketStore.getStaffStatsForUserLastDays(userId, 7, activeStorage);
        const stats14 = ticketStore.getStaffStatsForUserLastDays(userId, 14, activeStorage);
        const stats30 = ticketStore.getStaffStatsForUserLastDays(userId, 30, activeStorage);
        sendJson(res, 200, {
            ok: true,
            user: {
                id: userId,
                tag: user ? `${user.username}${user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''}` : null
            },
            stats: { days7: stats7, days14: stats14, days30: stats30 }
        });
        return true;
    }

    return false;
}

function navItem(path, label, currentPath) {
    const meta = {
        '/overview': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
            desc: 'Quick overview'
        },
        '/settings': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/></svg>',
            desc: 'Global bot config'
        },
        '/availability': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
            desc: 'Per-type status'
        },
        '/commands/ticket-types': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>',
            desc: 'Build ticket flows'
        },
        '/commands/tag': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10V4H14L4 14l6 6 10-10z"/><circle cx="15" cy="7" r="1"/></svg>',
            desc: 'Reusable responses'
        },
        '/tickets': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 7h14l3 5v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7l3-5z"/></svg>',
            desc: 'Manage active tickets'
        },
        '/transcripts': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
            desc: 'Browse saved transcripts'
        },
        '/commands/feedback': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
            desc: 'Feedback command setup'
        },
        '/commands/appeal': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
            desc: 'Feedback command setup'
        },
        '/statistics': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M6 20v-4"/><path d="M12 20V10"/><path d="M18 20V4"/></svg>',
            desc: 'Tickets and trends'
        },
        '/embed-editor': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 4-4 4-4 4h-1a2 2 0 0 0-2 2c0 2-1 4-3 4z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16.5" cy="10.5" r="1"/><circle cx="9" cy="15.5" r="1"/></svg>',
            desc: 'Visual template editor'
        },
        '/documentation': {
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
            desc: 'Placeholders and templates'
        }
    };
    const info = meta[path] || { icon: 'UI', desc: 'Dashboard section' };
    const iconMarkup = String(info.icon || '').includes('<svg')
        ? info.icon
        : `<span class="nav-textic">${String(info.icon || '').slice(0, 3)}</span>`;
    return `<a class="nav-item ${path === currentPath ? 'active' : ''}" data-nav="${path}" href="${path}"><span class="nav-kicker">${iconMarkup}</span><span class="nav-copy"><span class="nav-label">${label}</span><span class="nav-sub">${info.desc}</span></span></a>`;
}

function getAllowedDashboardPages(access = {}) {
    const pages = new Set(['/documentation']);
    if (access?.canFullDashboard || access?.isOwner) {
        ['/overview', '/settings', '/availability', '/commands/ticket-types', '/commands/tag', '/tickets', '/transcripts', '/commands/feedback', '/statistics', '/embed-editor', '/setup', '/controller'].forEach(page => pages.add(page));
        return pages;
    }
    if (access?.canManageSettings) pages.add('/setup');
    if (access?.canManageAvailability) pages.add('/availability');
    if (access?.canManageTicketTypes) {
        pages.add('/overview');
        pages.add('/settings');
        pages.add('/commands/ticket-types');
    }
    if (access?.canManageEscalations || access?.canViewTickets) pages.add('/tickets');
    if (access?.canViewTranscripts) pages.add('/transcripts');
    return pages;
}

function pageTitleForPath(path) {
    const map = {
        '/overview': 'Home',
        '/settings': 'Settings',
        '/availability': 'Availability',
        '/commands/ticket-types': 'Ticket Types',
        '/commands/tag': 'Tags',
        '/tickets': 'Tickets',
        '/transcripts': 'Transcripts',
        '/commands/feedback': 'Feedback',
        '/commands/appeal': 'Feedback',
        '/statistics': 'Statistics',
        '/embed-editor': 'Embed Editor',
        '/documentation': 'Documentation'
    };
    return map[path] || 'Dashboard';
}

function createUiHtml(currentPath) {
    const pageTitle = pageTitleForPath(currentPath);
    const activeGroup =
        currentPath === '/overview' || currentPath === '/settings' || currentPath === '/availability'
            ? 'general'
            : currentPath === '/commands/ticket-types' || currentPath === '/commands/tag' || currentPath === '/tickets' || currentPath === '/transcripts'
                ? 'tickets'
                : 'content';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Readex+Pro:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<title>Tickets Dashboard</title>
<style>
:root{--bg:#07070a;--bg-alt:#0b1220;--card:rgba(255,255,255,.06);--card-strong:rgba(255,255,255,.09);--bd:rgba(255,255,255,.14);--tx:#f5f7ff;--mt:rgba(245,247,255,.72);--ac:#6366f1;--ac-soft:#a5b4fc;--ok:#57f287;--er:#ed4245}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
html,body{margin:0;color:var(--tx);font-family:"Readex Pro","Segoe UI","Inter",sans-serif;background:radial-gradient(1200px 760px at 105% -10%,rgba(99,102,241,.26),transparent 58%),radial-gradient(1100px 680px at -8% 112%,rgba(34,197,94,.10),transparent 62%),linear-gradient(160deg,var(--bg),#09090e,var(--bg-alt))}
 .layout{display:block;min-height:100vh}
.sidebar{padding:20px 14px;border-right:1px solid rgba(255,255,255,.14);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));backdrop-filter:blur(22px);position:relative;overflow:hidden}
.sidebar:before{content:'';position:absolute;inset:-2px;background:url(/assets/hero.svg) center/cover no-repeat;opacity:.22;filter:saturate(1.1);pointer-events:none}
.brand{display:flex;align-items:center;gap:10px;margin:2px 10px 16px;position:relative;z-index:1}
.brand img{width:210px;height:auto;display:block}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:14px;color:var(--mt);text-decoration:none;margin-bottom:8px;border:1px solid transparent;transition:transform .16s ease,background .2s ease,border-color .2s ease,color .2s ease}
.nav-item:hover{transform:translateX(2px);background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.2);color:var(--tx)}
.nav-item.active{background:linear-gradient(140deg,rgba(255,255,255,.12),rgba(99,102,241,.23));border-color:rgba(129,140,248,.6);color:var(--tx);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.nav-kicker{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:34px;border-radius:11px;background:rgba(10,10,14,.66);border:1px solid rgba(255,255,255,.2);font-size:11px;font-weight:800;letter-spacing:.4px}
.nav-copy{display:flex;flex-direction:column;min-width:0}
.nav-label{font-size:13px;font-weight:700;color:var(--tx)}
.nav-sub{font-size:11px;color:var(--mt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{padding:28px;animation:rise .3s ease}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
.title{margin:0;font-size:30px;font-weight:700;letter-spacing:.3px}
.card{background:linear-gradient(180deg,var(--card),rgba(255,255,255,.03));border:1px solid var(--bd);border-radius:18px;padding:16px;box-shadow:0 16px 50px rgba(0,0,0,.34);backdrop-filter:blur(14px);transition:transform .16s ease,background .2s ease,border-color .2s ease}
.card:hover{transform:translateY(-4px);background:linear-gradient(180deg,var(--card-strong),rgba(255,255,255,.04));border-color:rgba(255,255,255,.2)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.row{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr))}
label{font-size:12px;color:var(--mt);display:block;margin-bottom:6px;font-weight:600}
input,select,textarea,button{width:100%;padding:10px 11px;border-radius:13px;border:1px solid var(--bd);background:rgba(2,6,23,.72);color:var(--tx)}
input:focus,select:focus,textarea:focus{outline:none;border-color:rgba(56,189,248,.65);box-shadow:0 0 0 3px rgba(56,189,248,.18)}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#c7d2fe 50%),linear-gradient(135deg,#c7d2fe 50%,transparent 50%);background-position:calc(100% - 18px) calc(50% - 3px),calc(100% - 12px) calc(50% - 3px);background-size:6px 6px,6px 6px;background-repeat:no-repeat;padding-right:30px;border-radius:14px}
select[multiple]{appearance:auto;background-image:none;padding-right:11px;min-height:188px}
select[multiple] option{padding:8px;border-radius:8px}
textarea{min-height:84px}button{cursor:pointer}
 .btn{background:linear-gradient(135deg,var(--ac),var(--ac-soft));color:#fff;border:1px solid rgba(255,255,255,.18);font-weight:750;box-shadow:0 10px 22px rgba(0,0,0,.28),0 10px 22px rgba(56,189,248,.14),inset 0 1px 0 rgba(255,255,255,.14);transition:transform .16s ease,filter .2s ease,box-shadow .2s ease}
 .btn:hover{filter:brightness(1.04);transform:translateY(-1px);box-shadow:0 14px 28px rgba(0,0,0,.32),0 14px 28px rgba(56,189,248,.16),inset 0 1px 0 rgba(255,255,255,.18)}
 .btn-soft{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:rgba(247,248,255,.92);font-weight:650;box-shadow:none;transition:background .2s ease,transform .16s ease,border-color .2s ease}
 .btn-soft:hover{background:rgba(255,255,255,.12);border-color:rgba(56,189,248,.20);transform:translateY(-1px)}
.btn-danger{background:linear-gradient(135deg,#d93c42,#f04747);color:#fff;border:1px solid rgba(255,255,255,.2);box-shadow:0 8px 20px rgba(240,71,71,.28)}
 .btn,.btn-soft{border-radius:16px}
 .btn:active{transform:translateY(0)}
.notice{min-height:20px;margin-bottom:10px}.ok{color:var(--ok)}.danger{color:var(--er)}.list{display:grid;gap:10px}.item{padding:10px;border:1px solid var(--bd);border-radius:12px;background:rgba(255,255,255,.03)}
.item-top{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.muted{font-size:12px;color:var(--mt)}
 .roles{display:flex;gap:6px;flex-wrap:wrap}.role{--c:#99AAB5;display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 22%,transparent);font-size:12px}.pill{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);font-size:12px;font-weight:700}.pill.ok{border-color:rgba(87,242,135,.35);background:rgba(87,242,135,.12);color:#eafff2}.pill.warn{border-color:rgba(254,231,92,.38);background:rgba(254,231,92,.14);color:#fff9db}.pill.danger{border-color:rgba(237,66,69,.42);background:rgba(237,66,69,.14);color:#ffe9ea}
 .mention{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;border:1px solid rgba(88,101,242,.28);background:rgba(88,101,242,.18);color:#d7dcff;font-weight:800}
 .mention:hover{background:rgba(88,101,242,.24)}
 .welcome{grid-column:1/-1;position:relative;overflow:hidden}
 .welcome:before{content:"";position:absolute;inset:-2px;background:radial-gradient(700px 260px at 15% 25%,rgba(67,180,255,.18),transparent 55%),radial-gradient(560px 220px at 85% 30%,rgba(37,99,235,.12),transparent 60%);opacity:.9;pointer-events:none}
 .welcome > *{position:relative}
 .floaty{margin:0;font-size:20px;font-weight:900;letter-spacing:.15px;line-height:1.2;animation:floatText 4.8s ease-in-out infinite}
 .floaty .accent{background:linear-gradient(45deg,var(--ac-soft),var(--ac));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
 @keyframes floatText{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
 @media (prefers-reduced-motion: reduce){.floaty{animation:none}}
 
 /* Uiverse-inspired checkbox (professional, accent-colored) */
 .checkbox-wrapper{
  --checkbox-size: 22px;
  --checkbox-color: var(--ac-soft);
  --checkbox-shadow: rgba(67,180,255,.22);
  --checkbox-border: rgba(67,180,255,.42);
  display:flex;align-items:center;position:relative;cursor:pointer;padding:10px 10px;user-select:none;
 }
 .checkbox-wrapper input{position:absolute;opacity:0;cursor:pointer;height:0;width:0}
 .checkbox-wrapper .checkmark{
  position:relative;width:var(--checkbox-size);height:var(--checkbox-size);
  border:2px solid var(--checkbox-border);border-radius:10px;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  display:flex;justify-content:center;align-items:center;flex:0 0 auto;
  background:rgba(0,0,0,.18);
  box-shadow:0 0 15px var(--checkbox-shadow);
  overflow:hidden;
 }
 .checkbox-wrapper .checkmark::before{
  content:"";position:absolute;inset:0;
  background:linear-gradient(45deg,var(--checkbox-color),var(--ac));
  opacity:0;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  transform:scale(0) rotate(-45deg);
 }
 .checkbox-wrapper input:checked ~ .checkmark::before{opacity:1;transform:scale(1) rotate(0)}
 .checkbox-wrapper .checkmark svg{
  width:0;height:0;color:#07122a;z-index:1;
  transition:all .4s cubic-bezier(.68,-.55,.265,1.55);
  filter:drop-shadow(0 0 2px rgba(0,0,0,.35));
 }
 .checkbox-wrapper input:checked ~ .checkmark svg{width:18px;height:18px;transform:rotate(360deg)}
 .checkbox-wrapper:hover .checkmark{
  border-color:var(--checkbox-color);
  transform:scale(1.08);
  box-shadow:0 0 20px var(--checkbox-shadow),0 0 40px rgba(56,189,248,.14),inset 0 0 10px rgba(255,255,255,.10);
 }
 .checkbox-wrapper input:checked ~ .checkmark{animation:pulse 1s cubic-bezier(.68,-.55,.265,1.55)}
 @keyframes pulse{
  0%{transform:scale(1);box-shadow:0 0 20px var(--checkbox-shadow)}
  50%{transform:scale(.92);box-shadow:0 0 30px var(--checkbox-shadow),0 0 50px rgba(56,189,248,.14)}
  100%{transform:scale(1);box-shadow:0 0 20px var(--checkbox-shadow)}
 }
 .checkbox-wrapper .label{
  margin-left:12px;
  font-size:14px;font-weight:800;
  color:rgba(247,248,255,.86);
  text-shadow:0 0 10px rgba(67,180,255,.10);
  opacity:.92;transition:all .24s ease;
 }
 .checkbox-wrapper input:checked ~ .label{color:var(--checkbox-color)}
 .checkbox-wrapper:hover .label{opacity:1;transform:translateX(3px)}
 .checkbox-wrapper::after,.checkbox-wrapper::before{content:"";position:absolute;width:4px;height:4px;border-radius:50%;background:var(--checkbox-color);opacity:0;transition:all .5s}
 .checkbox-wrapper::before{left:-10px;top:50%}
 .checkbox-wrapper::after{right:-10px;top:50%}
 .checkbox-wrapper:hover::before{opacity:1;transform:translateX(-10px);box-shadow:0 0 10px var(--checkbox-color)}
 .checkbox-wrapper:hover::after{opacity:1;transform:translateX(10px);box-shadow:0 0 10px var(--checkbox-color)}
 .ms-item.checkbox-wrapper::after,.ms-item.checkbox-wrapper::before{display:none}
details.acc{margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.03);overflow:hidden}
details.acc summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px;font-weight:850;color:rgba(247,248,255,.9);background:rgba(255,255,255,.02)}
details.acc summary::-webkit-details-marker{display:none}
details.acc[open] summary{background:rgba(56,189,248,.10)}
details.acc .acc-body{padding:12px 12px;border-top:1px solid rgba(255,255,255,.10);animation:pageIn .18s ease}
.dot{width:8px;height:8px;border-radius:50%;background:var(--c)}
.select-wrap{display:grid;gap:8px}
.select-toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between}
.toolbar-buttons{display:flex;gap:8px}
.chip-btn{width:auto;border-radius:999px;padding:6px 10px;font-size:12px;border:1px solid var(--bd);background:rgba(255,255,255,.06)}
.chip-btn:hover{background:rgba(129,140,248,.2)}
.select-count{font-size:12px;color:var(--mt)}
.emoji-inline{display:inline-flex;align-items:center;justify-content:center;min-width:20px;min-height:20px}
.emoji-inline img{width:20px;height:20px;object-fit:contain;vertical-align:middle}
.custom-select{position:relative;cursor:pointer;transition:300ms}
.cs-trigger{
 display:flex;align-items:center;justify-content:space-between;gap:10px;
 background:rgba(42,47,59,.55);
 border:1px solid rgba(255,255,255,.10);
 border-radius:14px;
 padding:10px 12px;
 color:rgba(247,248,255,.86);
 box-shadow:0 10px 24px rgba(0,0,0,.18);
 transition:transform 220ms ease,background 220ms ease,border-color 220ms ease
}
.cs-trigger:hover{transform:translateY(-1px);background:rgba(50,55,65,.55);border-color:rgba(56,189,248,.24)}
.cs-caret{display:inline-block;transform:rotate(-90deg);transition:transform 300ms ease;opacity:.9}
.custom-select.open .cs-caret{transform:rotate(0deg)}
.cs-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
.cs-caret{opacity:.75;font-size:11px}
.cs-menu{
 position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:20;
 background:rgba(42,47,59,.92);
 border:1px solid rgba(255,255,255,.12);
 border-radius:14px;
 padding:8px;
 box-shadow:0 18px 40px rgba(0,0,0,.45);
 backdrop-filter:blur(16px);
 opacity:0;
 transform:translateY(-12px) scale(.985);
 pointer-events:none;
 transition:opacity 300ms ease,transform 300ms ease
}
.custom-select.open .cs-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.cs-search{margin-bottom:8px}
.cs-list{max-height:220px;overflow:auto;display:grid;gap:6px}
.cs-opt{width:100%;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.04);display:flex;gap:8px;align-items:center;transition:300ms}
.cs-opt:hover{background:rgba(50,55,65,.65);border-color:rgba(56,189,248,.22)}
.cs-opt.active{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.40)}
.role-ms{position:relative;display:grid;gap:8px}
.ms-trigger{
 display:flex;align-items:center;justify-content:space-between;gap:10px;
 background:rgba(42,47,59,.55);
 border:1px solid rgba(255,255,255,.10);
 border-radius:14px;
 padding:10px 12px;
 color:rgba(247,248,255,.86);
 box-shadow:0 10px 24px rgba(0,0,0,.18);
 transition:transform 220ms ease,background 220ms ease,border-color 220ms ease
}
.ms-trigger:hover{transform:translateY(-1px);background:rgba(50,55,65,.55);border-color:rgba(56,189,248,.24)}
.role-ms.open .cs-caret{transform:rotate(0deg)}
.ms-menu{
 position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:25;
 background:rgba(42,47,59,.92);
 border:1px solid rgba(255,255,255,.12);
 border-radius:14px;
 padding:8px;
 box-shadow:0 18px 40px rgba(0,0,0,.45);
 backdrop-filter:blur(16px);
 opacity:0;
 transform:translateY(-12px) scale(.985);
 pointer-events:none;
 transition:opacity 300ms ease,transform 300ms ease
}
.role-ms.open .ms-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.ms-toolbar{display:flex;gap:8px;margin-bottom:8px}
.ms-toolbar input{flex:1}
.ms-list{max-height:230px;overflow:auto;display:grid;gap:6px}
.ms-item{border-radius:14px;background:rgba(255,255,255,.03);border:1px solid transparent}
.ms-item:hover{background:rgba(255,255,255,.05);border-color:rgba(56,189,248,.20)}
.ms-item.checkbox-wrapper{padding:10px 10px;--checkbox-size:20px}
.ms-item.checkbox-wrapper .label{font-size:13px;font-weight:750;text-shadow:none}
.ms-chips{display:flex;gap:6px;flex-wrap:wrap}
.ms-chip{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;background:rgba(99,102,241,.24);border:1px solid rgba(129,140,248,.4);font-size:12px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.12);backdrop-filter:blur(18px)}
.preview-shell{border:1px solid rgba(255,255,255,.16);border-radius:14px;background:linear-gradient(180deg,rgba(20,23,33,.90),rgba(14,17,25,.86));padding:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
.main{padding:20px 22px}
.topbar{position:sticky;top:0;z-index:5;background:linear-gradient(180deg,rgba(7,7,10,.72),rgba(7,7,10,.30));backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:14px 16px;margin-bottom:14px}
.title{margin:0;font-size:26px;letter-spacing:.2px}
@keyframes pageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
#app{animation:pageIn .22s ease;transition:opacity .18s ease,transform .18s ease}
#app.swap{opacity:0;transform:translateY(6px)}
.preview-msg{display:flex;gap:10px;align-items:flex-start}
.preview-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#22c55e)}
.preview-content{flex:1;min-width:0}
.preview-name{font-size:13px;font-weight:700;margin-bottom:6px}
.preview-tag{font-size:10px;font-weight:800;background:#5865f2;color:#fff;border-radius:4px;padding:1px 5px;margin-left:6px}
.preview-embed{display:flex;gap:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;min-height:78px}
.preview-bar{width:4px;border-radius:8px;background:#5865F2}
.preview-main{flex:1;min-width:0}
.preview-title{font-size:14px;font-weight:700;margin-bottom:6px}
.preview-desc{white-space:pre-wrap;font-size:13px;color:#d7dcf4;line-height:1.4}
.auth{position:fixed;inset:0;background:rgba(5,8,15,.74);display:none;align-items:center;justify-content:center}
.auth-card{width:min(430px,92vw);padding:16px;background:#111936;border:1px solid var(--bd);border-radius:12px}
@media(max-width:900px){
 .layout{grid-template-columns:1fr}
 .main{padding:16px}
 .title{font-size:22px}
 .row,.topbar{grid-template-columns:1fr;display:grid}

 /* Mobile-first navigation: drawer + big dropdown */
  #menuBtn{display:inline-flex}
  .topbar-right{justify-content:flex-start}
  .topbar-right .topnav{min-width:0;width:100%}
  .topnav-btn{min-width:0}
  .topnav-menu{left:0;right:0}
  .sidebar{
   position:fixed;left:0;top:0;bottom:0;width:min(320px,92vw);
   transform:translateX(-105%);
   transition:transform .22s ease;
  z-index:50;
  border-right:1px solid rgba(255,255,255,.10);
  border-bottom:none;
 }
 body.menu-open .sidebar{transform:translateX(0)}
 .overlay{display:none;position:fixed;inset:0;background:rgba(5,8,15,.62);backdrop-filter:blur(4px);z-index:49}
 body.menu-open .overlay{display:block}

 input,select,textarea,button{font-size:16px}
 .nav-item{padding:12px 12px}
 .nav-kicker{min-width:40px;height:40px}
}

/* --- Dashboard 2026 polish (Dyno/Circle/Sapph-inspired) --- */
:root{
 --bg:#050712;--bg-alt:#070a18;--card:rgba(255,255,255,.055);--card-strong:rgba(255,255,255,.085);
 --bd:rgba(255,255,255,.12);--tx:#f7f8ff;--mt:rgba(247,248,255,.74);
 --ac:#2563eb;--ac-soft:#38bdf8;--ok:#57f287;--er:#ed4245;--warn:#fee75c;
 --shadow:0 20px 60px rgba(0,0,0,.45);--shadow-soft:0 14px 40px rgba(0,0,0,.35);
}
html,body{font-family:"Inter","Readex Pro","Segoe UI",system-ui,-apple-system,sans-serif}
  body{
   background:
    radial-gradient(1200px 700px at 100% 0%,rgba(37,99,235,.14),transparent 56%),
    radial-gradient(1100px 720px at 0% 105%,rgba(67,180,255,.10),transparent 60%),
    radial-gradient(900px 540px at 25% -10%,rgba(87,242,135,.06),transparent 55%),
    linear-gradient(160deg,var(--bg),#070716,var(--bg-alt));
  }

  /* Theme toggle: light */
  body[data-theme="light"]{
  --bg:#f6f1e6;--bg-alt:#f1e4ce;
  --bd:rgba(15,23,42,.14);--tx:#0b1220;--mt:rgba(11,18,32,.64);
  --shadow:0 18px 55px rgba(15,23,42,.12);--shadow-soft:0 12px 36px rgba(15,23,42,.10);
 }
 body[data-theme="light"]{
  background:
   radial-gradient(1200px 700px at 100% 0%,rgba(67,180,255,.20),transparent 56%),
   radial-gradient(1100px 720px at 0% 105%,rgba(37,99,235,.10),transparent 60%),
   radial-gradient(900px 520px at 50% -12%,rgba(254,231,92,.10),transparent 60%),
   linear-gradient(160deg,var(--bg),#fbf6ec,var(--bg-alt));
 }
 body[data-theme="light"] .sidebar{background:linear-gradient(180deg,rgba(253,249,241,.86),rgba(247,239,227,.72));border-right:1px solid rgba(15,23,42,.10)}
 body[data-theme="light"] .sidebar:before{opacity:.07;filter:saturate(1) contrast(1)}
 body[data-theme="light"] .nav-kicker{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.10)}
 body[data-theme="light"] .nav-item{color:rgba(11,18,32,.72)}
 body[data-theme="light"] .nav-label{color:var(--tx)}
 body[data-theme="light"] .nav-sub{color:rgba(11,18,32,.60)}
 body[data-theme="light"] .nav-item:hover{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.12);color:var(--tx)}
body[data-theme="light"] .nav-item.active{background:linear-gradient(140deg,rgba(67,180,255,.14),rgba(37,99,235,.10));border-color:rgba(67,180,255,.24);box-shadow:inset 0 1px 0 rgba(255,255,255,.55)}
 body[data-theme="light"] .topbar{background:linear-gradient(180deg,rgba(253,249,241,.82),rgba(247,239,227,.62));border-color:rgba(15,23,42,.10)}
 body[data-theme="light"] .card{background:linear-gradient(180deg,rgba(253,249,241,.86),rgba(247,239,227,.70));border-color:rgba(15,23,42,.12)}
 body[data-theme="light"] .card:hover{background:linear-gradient(180deg,rgba(253,249,241,.92),rgba(247,239,227,.76));border-color:rgba(15,23,42,.16)}
 body[data-theme="light"] input,body[data-theme="light"] select,body[data-theme="light"] textarea{background:rgba(253,249,241,.92);color:var(--tx);border-color:rgba(15,23,42,.14)}
 body[data-theme="light"] input:focus,body[data-theme="light"] select:focus,body[data-theme="light"] textarea:focus{border-color:rgba(67,180,255,.55);box-shadow:0 0 0 3px rgba(67,180,255,.16)}
 body[data-theme="light"] .cs-menu,body[data-theme="light"] .ms-menu,body[data-theme="light"] .topnav-menu{background:rgba(253,249,241,.96);border-color:rgba(15,23,42,.12)}
 body[data-theme="light"] .cs-opt{background:rgba(15,23,42,.02)}
 body[data-theme="light"] .cs-opt:hover{background:rgba(67,180,255,.10);border-color:rgba(67,180,255,.20)}
 body[data-theme="light"] .ms-item{background:rgba(15,23,42,.02)}
 body[data-theme="light"] .ms-chip{background:rgba(67,180,255,.14);border-color:rgba(67,180,255,.20);color:var(--tx)}
 body[data-theme="light"] .btn-soft{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.14);color:var(--tx)}
 body[data-theme="light"] .btn-soft:hover{background:rgba(15,23,42,.06);border-color:rgba(67,180,255,.30)}
 body[data-theme="light"] .btn{box-shadow:0 10px 22px rgba(15,23,42,.14),0 10px 22px rgba(67,180,255,.18),inset 0 1px 0 rgba(255,255,255,.25)}
 body[data-theme="light"] .btn:hover{box-shadow:0 14px 28px rgba(15,23,42,.16),0 14px 28px rgba(67,180,255,.22),inset 0 1px 0 rgba(255,255,255,.28)}
 body[data-theme="light"] .checkbox-wrapper .checkmark{background:rgba(253,249,241,.78)}
 body[data-theme="light"] .mention{border-color:rgba(88,101,242,.22);background:rgba(88,101,242,.12);color:#1d2a6b}

 /* Theme toggle: hacker (hidden) */
 body[data-theme="hacker"]{
  --bg:#020607;--bg-alt:#000c08;
  --bd:rgba(0,255,136,.18);--tx:#d7ffe9;--mt:rgba(215,255,233,.70);
  --ac:#00ff88;--ac-soft:#00e5ff;
  --shadow:0 20px 70px rgba(0,0,0,.65);--shadow-soft:0 14px 46px rgba(0,0,0,.52);
 }
 body[data-theme="hacker"]{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
  background:
   radial-gradient(1100px 720px at 10% 0%,rgba(0,255,136,.16),transparent 56%),
   radial-gradient(1000px 650px at 100% 100%,rgba(0,229,255,.10),transparent 60%),
   repeating-linear-gradient(0deg,rgba(0,255,136,.06) 0,rgba(0,255,136,.06) 1px,transparent 1px,transparent 4px),
   linear-gradient(160deg,var(--bg),#000000,var(--bg-alt));
 }
 body[data-theme="hacker"] .topbar{background:linear-gradient(180deg,rgba(0,0,0,.60),rgba(0,0,0,.22));border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .card{background:linear-gradient(180deg,rgba(0,255,136,.06),rgba(0,0,0,.26));border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .card:hover{border-color:rgba(0,255,136,.26)}
 body[data-theme="hacker"] input,body[data-theme="hacker"] select,body[data-theme="hacker"] textarea{background:rgba(0,0,0,.40);border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] input:focus,body[data-theme="hacker"] select:focus,body[data-theme="hacker"] textarea:focus{border-color:rgba(0,255,136,.45);box-shadow:0 0 0 3px rgba(0,255,136,.16)}
 body[data-theme="hacker"] .cs-menu,body[data-theme="hacker"] .ms-menu,body[data-theme="hacker"] .topnav-menu{background:rgba(0,0,0,.92);border-color:rgba(0,255,136,.18)}
 body[data-theme="hacker"] .topnav-item:hover{border-color:rgba(0,255,136,.28)}
 body[data-theme="hacker"] .mention{border-color:rgba(0,255,136,.24);background:rgba(0,255,136,.12);color:var(--tx)}
 .layout{display:block}
.sidebar{
 padding:18px 14px;
 background:linear-gradient(180deg,rgba(18,20,34,.78),rgba(7,10,24,.78));
 border-right:1px solid rgba(255,255,255,.09);
}
 .sidebar:before{opacity:.12;filter:saturate(1.03) contrast(1.03)}
.brand{margin:6px 10px 18px}
.brand img{width:200px}
.nav-section{margin:14px 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:rgba(247,248,255,.55);font-weight:700}
.nav-item{position:relative;border-radius:16px}
.nav-kicker{
 min-width:36px;height:36px;border-radius:12px;
 background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));
 border:1px solid rgba(255,255,255,.14);
}
.nav-kicker svg{width:18px;height:18px;display:block;opacity:.92}
.nav-textic{font-size:11px;font-weight:800;letter-spacing:.4px;opacity:.9}
.nav-item:hover .nav-kicker{border-color:rgba(56,189,248,.28);box-shadow:0 10px 24px rgba(56,189,248,.10)}
.nav-item.active{border-color:rgba(56,189,248,.38);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 12px 34px rgba(56,189,248,.08)}
.nav-item.active:before{content:'';position:absolute;left:8px;top:10px;bottom:10px;width:3px;border-radius:999px;background:linear-gradient(180deg,var(--ac),var(--ac-soft))}
.nav-home{margin:0 10px 12px}

/* Sidebar radio glider (Uiverse-inspired) */
.radio-container{
 --main-color: var(--ac-soft);
 --main-color-opacity: color-mix(in srgb,var(--ac-soft) 14%, transparent);
 --total-radio: 3;
 display:flex;
 flex-direction:column;
 position:relative;
 padding-left:.5rem;
 margin:0 10px 12px;
}
.radio-container input{cursor:pointer;appearance:none}
.radio-container label{
 cursor:pointer;
 padding:12px 12px 12px 10px;
 border-radius:14px;
 position:relative;
 color:rgba(247,248,255,.58);
 font-weight:850;
 letter-spacing:.04em;
 transition:all .22s ease;
}
.radio-container input:checked + label{color:var(--main-color);background:rgba(255,255,255,.03)}
.radio-container .glider-container{
 position:absolute;left:0;top:0;bottom:0;
 background:linear-gradient(0deg,rgba(0,0,0,0) 0%,rgba(27,27,27,1) 50%,rgba(0,0,0,0) 100%);
 width:1px;
}
.radio-container .glider-container .glider{
 position:relative;
 height:calc(100% / var(--total-radio));
 width:100%;
 background:linear-gradient(0deg,rgba(0,0,0,0) 0%,var(--main-color) 50%,rgba(0,0,0,0) 100%);
 transition:transform .5s cubic-bezier(.37,1.95,.66,.56);
}
.radio-container .glider-container .glider::before{
 content:"";position:absolute;height:60%;width:300%;top:50%;transform:translateY(-50%);
 background:var(--main-color);filter:blur(10px);
}
.radio-container .glider-container .glider::after{
 content:"";position:absolute;left:0;height:100%;width:150px;
 background:linear-gradient(90deg,var(--main-color-opacity) 0%,rgba(0,0,0,0) 100%);
}
.radio-container input:nth-of-type(1):checked ~ .glider-container .glider{transform:translateY(0)}
.radio-container input:nth-of-type(2):checked ~ .glider-container .glider{transform:translateY(100%)}
.radio-container input:nth-of-type(3):checked ~ .glider-container .glider{transform:translateY(200%)}
 .nav-group{margin:10px 10px 0;display:none}
 .nav-group.open{display:block}
 .nav-group-body{display:block;animation:pageIn .18s ease}
.main{padding:22px 24px;max-width:1240px;margin:0 auto}
.topbar{
 border-radius:18px;
 border:1px solid rgba(255,255,255,.10);
 box-shadow:var(--shadow-soft);
}
 .topbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
  .brand-mini{display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:16px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);box-shadow:var(--shadow-soft);overflow:hidden;flex:0 0 auto;transition:transform .16s ease,background .2s ease,border-color .2s ease}
 .brand-mini:hover{transform:translateY(-1px);background:rgba(255,255,255,.06);border-color:rgba(56,189,248,.24)}
  .brand-mini img{width:26px;height:26px;display:block}
  .titles{display:flex;flex-direction:column;gap:2px;min-width:0}
  .topbar-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
  .topbar-right .topnav{width:auto;min-width:200px}
  .topbar-right .theme-nav{min-width:160px}
  .topbar-right .btn,.topbar-right .btn-soft{width:auto}
 
 /* Top navigation dropdown (smooth, animated) */
 .topnav{position:relative}
  .topnav-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:190px}
  #topNav .topnav-btn{min-width:220px}
  #themeNav .topnav-btn{min-width:160px}
 .topnav-btn .chev{opacity:.78;transition:transform .18s ease}
 .topnav.open .topnav-btn .chev{transform:rotate(180deg)}
 .topnav-menu{
  position:absolute;right:0;top:calc(100% + 8px);
  min-width:260px;max-height:60vh;overflow:auto;padding:8px;
  background:rgba(10,14,30,.92);border:1px solid rgba(255,255,255,.12);
  border-radius:16px;box-shadow:var(--shadow);backdrop-filter:blur(18px);
  opacity:0;transform:translateY(-6px) scale(.98);pointer-events:none;
  transition:opacity .16s ease,transform .18s ease
 }
 .topnav.open .topnav-menu{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
 #themeNav .topnav-menu{min-width:190px}
 .topnav-item{
  width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
  text-align:left;padding:10px 11px;border-radius:12px;
  background:transparent;border:1px solid transparent;color:rgba(247,248,255,.82);
  cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .16s ease
 }
.topnav-item:hover{background:rgba(255,255,255,.05);border-color:rgba(56,189,248,.22);transform:translateY(-1px)}
.topnav-item.active{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.34);color:var(--tx)}
 .topnav-item .tag{font-size:11px;color:rgba(247,248,255,.55)}
#menuBtn{display:none}
.overlay{display:none}
.title{font-size:26px;font-weight:750;letter-spacing:.15px}
.card{border-radius:18px;box-shadow:var(--shadow-soft);background:linear-gradient(180deg,rgba(17,20,36,.78),rgba(11,14,28,.78));border-color:rgba(255,255,255,.10)}
.card:hover{box-shadow:var(--shadow);transform:translateY(-3px)}
.item{transition:transform .16s ease,border-color .2s ease,background .2s ease}
.item:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.035)}
 input,select,textarea,button{background:rgba(5,8,20,.78)}
 .btn{border-radius:14px}
 .btn-danger{border-radius:14px}
 .btn-soft{border-radius:14px}

 /* Dyno-style editor layout */
 .split{display:grid;grid-template-columns:360px 1fr;gap:14px;align-items:start}
 .list-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
 .list-card input{background:rgba(6,9,22,.7)}
 .list-compact{gap:8px}
 .list-btn{display:block;width:100%;text-align:left;padding:10px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);color:var(--tx);transition:transform .16s ease,border-color .2s ease,background .2s ease}
.list-btn:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.22);background:rgba(56,189,248,.08)}
.list-btn.active{border-color:rgba(56,189,248,.34);background:linear-gradient(180deg,rgba(56,189,248,.14),rgba(255,255,255,.03));box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
 .list-title{font-weight:800;font-size:13px;display:flex;align-items:center;gap:8px}
 .list-meta{margin-top:4px;font-size:12px;color:rgba(247,248,255,.65);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .help{margin-top:6px;font-size:12px;color:rgba(247,248,255,.60)}
 textarea{min-height:110px}
 @media(max-width:1100px){.split{grid-template-columns:1fr}}
 </style></head>
<body>
 <div id="auth" class="auth"><div class="auth-card"><h3>Dashboard Login</h3><div class="muted" style="margin-bottom:10px">Sign in with Discord to continue.</div><a id="authDiscord" class="btn" href="/login" style="display:block;text-align:center;text-decoration:none">Sign in with Discord</a><div class="muted" style="margin:12px 0 6px">or use a token</div><label>Token</label><input id="authToken" type="password" /><div class="row" style="margin-top:10px"><button id="authLogin" class="btn">Login</button></div><div id="authMsg" class="notice danger"></div></div></div>
 <div class="layout"><main class="main"><div class="topbar"><div class="topbar-left"><a class="brand-mini" href="/" title="Landing page"><img src="/assets/sync.png" alt="Tickets Dashboard" /></a><div class="titles"><h2 id="pageTitle" class="title">${pageTitle}</h2><div class="muted" id="pageHint">Navigate using the dropdowns to keep things tidy.</div></div></div><div class="topbar-right"><div id="topNav" class="topnav"><button id="topNavBtn" class="btn-soft topnav-btn" type="button"><span id="topNavLabel">Navigate</span><span class="chev">v</span></button><div id="topNavMenu" class="topnav-menu" role="menu"><button type="button" class="topnav-item" data-topnav-item data-value="/overview">Home <span class="tag">General</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/settings">Settings <span class="tag">General</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/availability">Availability <span class="tag">General</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/tickets">Tickets <span class="tag">Tickets</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/transcripts">Transcripts <span class="tag">Tickets</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/commands/ticket-types">Ticket Types <span class="tag">Tickets</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/commands/tag">Tags <span class="tag">Tickets</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/commands/feedback">Feedback <span class="tag">Content</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/statistics">Statistics <span class="tag">Content</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/embed-editor">Embed Editor <span class="tag">Content</span></button><button type="button" class="topnav-item" data-topnav-item data-value="/documentation">Documentation <span class="tag">Content</span></button></div></div><button id="refreshStateBtn" class="btn" style="padding:10px 16px">Refresh</button></div></div><div id="notice" class="notice"></div><section id="app"></section></main></div>
<script>
 let currentPath=${JSON.stringify(currentPath)},tokenKey='dashboard_token_ui',defaultEmbedTemplates=${JSON.stringify(DEFAULT_EMBED_TEMPLATES)};
const app=document.getElementById('app'),notice=document.getElementById('notice'),auth=document.getElementById('auth'),authDiscord=document.getElementById('authDiscord'),authToken=document.getElementById('authToken'),authMsg=document.getElementById('authMsg');
 const themeKey='dash_theme';
 const inferTheme=()=>{try{const saved=localStorage.getItem(themeKey);if(saved==='light'||saved==='dark')return saved;return 'dark'}catch{return 'dark'}};
 document.body.dataset.theme=inferTheme();
  let state=null;
  let ui=(()=>{try{const raw=sessionStorage.getItem('dash_ui');const parsed=raw?JSON.parse(raw):{};return parsed&&typeof parsed==='object'?parsed:{};}catch{return {}}})();
 const saveUi=()=>{try{sessionStorage.setItem('dash_ui',JSON.stringify(ui||{}))}catch{}};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const note=(t,m='')=>{notice.textContent=t||'';notice.className='notice '+m};
async function api(path,opt={}){const h={'Content-Type':'application/json',...(opt.headers||{})};const tok=localStorage.getItem(tokenKey);if(tok)h['x-dashboard-token']=tok;const r=await fetch(path,{credentials:'include',...opt,headers:h});if(r.status===401){const next=encodeURIComponent(location.pathname+location.search);window.location='/login?next='+next;throw new Error('Unauthorized')}const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed '+r.status));return d}
function parseEmoji(raw){const s=String(raw||'').trim();if(!s)return null;const m=s.match(/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/);if(m)return{animated:m[1]==='a',name:m[2],id:m[3],raw:s};return{unicode:s,raw:s}}
function emojiHtml(raw){const e=parseEmoji(raw);if(!e)return '';if(e.id){const ext=e.animated?'gif':'png';return '<span class="emoji-inline"><img src="https://cdn.discordapp.com/emojis/'+e.id+'.'+ext+'?size=64&quality=lossless" alt="'+esc(e.name||'emoji')+'" /></span>'}return '<span class="emoji-inline">'+esc(e.unicode)+'</span>'}
function teamLabel(team){const src=team&&typeof team==='object'?team:{};const e=emojiHtml(src.emoji||'');return (e?e+' ':'')+esc(src.name||'')}
function rolePills(ids){const roles=(ids||[]).map(id=>state.roleCatalog.find(r=>r.id===id)).filter(Boolean);if(!roles.length)return '<span class="muted">No roles set</span>';return '<div class="roles">'+roles.map(r=>'<span class="role" style="--c:'+r.color+'"><span class="dot"></span>@'+esc(r.name)+'</span>').join('')+'</div>'}
 function roleSelect(selected,id){const roles=Array.isArray(state.roleCatalog)?state.roleCatalog:[];const selectedSet=new Set(selected||[]);const chips=roles.filter(r=>selectedSet.has(r.id)).map(r=>'<span class="ms-chip">@'+esc(r.name)+'</span>').join('');const checkSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';return '<div class="role-ms" data-role-ms="'+id+'"><button type="button" class="ms-trigger" data-ms-trigger="'+id+'"><span id="'+id+'Count">'+selectedSet.size+' selected</span><span class="cs-caret">v</span></button><div class="ms-menu"><div class="ms-toolbar"><input class="ms-search" data-ms-search="'+id+'" placeholder="Search roles" /><button type="button" class="chip-btn select-all" data-select="'+id+'">All</button><button type="button" class="chip-btn clear-all" data-select="'+id+'">Clear</button></div><div class="ms-list">'+roles.map(r=>'<label class="ms-item checkbox-wrapper" data-ms-item="'+id+'" data-name="'+esc(r.name).toLowerCase()+'"><input type="checkbox" data-ms-check="'+id+'" value="'+r.id+'" '+(selectedSet.has(r.id)?'checked':'')+' /><span class="checkmark">'+checkSvg+'</span><span class="label">@'+esc(r.name)+'</span></label>').join('')+'</div></div><div id="'+id+'Chips" class="ms-chips">'+chips+'</div></div>'}
function channelLabel(channelId,placeholder){const ch=(state.channelCatalog||[]).find(c=>c.id===channelId);return ch?('#'+ch.name):(placeholder||'Select a channel')}
function channelSelect(id,selectedId,placeholder){const channels=Array.isArray(state.channelCatalog)?state.channelCatalog:[];return '<div class="custom-select" data-cs="'+id+'"><input id="'+id+'" type="hidden" value="'+esc(selectedId||'')+'" /><button type="button" class="cs-trigger" data-cs-trigger="'+id+'"><span class="cs-label" id="'+id+'Label">'+esc(channelLabel(selectedId,placeholder))+'</span><span class="cs-caret">v</span></button><div class="cs-menu"><input class="cs-search" data-cs-search="'+id+'" placeholder="Search channels" /><div class="cs-list">'+['<button type="button" class="cs-opt '+(!selectedId?'active':'')+'" data-cs-opt="'+id+'" data-value="">'+esc(placeholder||'Select a channel')+'</button>'].concat(channels.map(ch=>'<button type="button" class="cs-opt '+(selectedId===ch.id?'active':'')+'" data-cs-opt="'+id+'" data-value="'+ch.id+'">#'+esc(ch.name)+'</button>')).join('')+'</div></div></div>'}
function categoryLabel(categoryId,placeholder){const ch=(state.categoryCatalog||[]).find(c=>c.id===categoryId);return ch?(ch.name):(placeholder||'Select a category')}
function categorySelect(id,selectedId,placeholder){const cats=Array.isArray(state.categoryCatalog)?state.categoryCatalog:[];return '<div class="custom-select" data-cs="'+id+'"><input id="'+id+'" type="hidden" value="'+esc(selectedId||'')+'" /><button type="button" class="cs-trigger" data-cs-trigger="'+id+'"><span class="cs-label" id="'+id+'Label">'+esc(categoryLabel(selectedId,placeholder))+'</span><span class="cs-caret">v</span></button><div class="cs-menu"><input class="cs-search" data-cs-search="'+id+'" placeholder="Search categories" /><div class="cs-list">'+['<button type="button" class="cs-opt '+(!selectedId?'active':'')+'" data-cs-opt="'+id+'" data-value="">'+esc(placeholder||'Use default ticket category')+'</button>'].concat(cats.map(ch=>'<button type="button" class="cs-opt '+(selectedId===ch.id?'active':'')+'" data-cs-opt="'+id+'" data-value="'+ch.id+'">'+esc(ch.name)+'</button>')).join('')+'</div></div></div>'}
 function renderSettings(){
  const teams=Array.isArray(state.supportTeams)?state.supportTeams:[];
  const selectedName=(ui&&ui.selectedTeam)?String(ui.selectedTeam):'';
  const selectedTeam=teams.find(t=>t&&t.name===selectedName)||null;
  const list=teams
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
    const active=t&&t.name===selectedName;
    return '<button type="button" class="list-btn teamPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
     '<div class="list-title">'+teamLabel(t)+'</div>'+
     '<div class="list-meta">'+esc((t.roleIds||t.roleId?[].concat(t.roleIds||[],t.roleId||[]).filter(Boolean).length:0))+' role(s)</div>'+
    '</button>';
   }).join('')||'<div class="muted">No support teams yet.</div>';

 return '<div class="grid">'+
   '<div class="card">'+
    '<h3>Guild Settings</h3>'+
    '<label>Feedback Channel</label>'+
    channelSelect('feedbackId',state.botConfig.appealsChannelId||'','Select feedback channel')+
    '<div class="help">Pick a channel by name (no IDs needed).</div>'+
    '<div style="margin-top:12px;display:flex;gap:10px">'+
      '<button id="saveConfig" class="btn" style="width:auto">Save Settings</button>'+
    '</div>'+
   '</div>'+

   '<div class="card">'+
    '<h3>General Ticket Panel</h3>'+
    '<p class="muted">This controls the default support panel content for this server.</p>'+
    '<label>Panel Title</label>'+
    '<input id="panelTitle" value="'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.title)||'Support Desk')+'" placeholder="Support Desk" />'+
    '<label>Panel Description</label>'+
    '<textarea id="panelDescription" placeholder="Explain how users should open tickets.">'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.description)||'')+'</textarea>'+
    '<label>Panel Advisory</label>'+
    '<textarea id="panelAdvisory" placeholder="Rules, monitoring notice, or policy links.">'+esc((state.guildConfigSummary&&state.guildConfigSummary.panelConfig&&state.guildConfigSummary.panelConfig.advisory)||'')+'</textarea>'+
    '<div style="margin-top:12px;display:flex;gap:10px">'+
      '<button id="savePanelConfig" class="btn" style="width:auto">Save Panel</button>'+
    '</div>'+
   '</div>'+
  '</div>'+

  '<div class="split" style="margin-top:14px">'+
    '<div class="card list-card">'+
      '<div class="list-head">'+
        '<div>'+
          '<h3 style="margin:0">Support Teams</h3>'+
          '<div class="muted">Select a team to edit.</div>'+
        '</div>'+
        '<button id="newTeamBtn" class="btn-soft" style="width:auto">New</button>'+
      '</div>'+
      '<input id="teamSearch" placeholder="Search teams..." />'+
      '<div class="list list-compact" id="teamsList" style="margin-top:10px">'+list+'</div>'+
    '</div>'+

    '<div class="card">'+
      '<h3>'+(selectedTeam?'Edit Team':'Create Team')+'</h3>'+
      '<div class="muted" style="margin-bottom:10px">'+(selectedTeam?('Editing: '+esc(selectedTeam.name)):'Create a new team and assign roles.')+'</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Team Name</label>'+
          '<input id="stName" placeholder="Billing" />'+
          '<div class="help">This should match the Ticket Type name you want it to support.</div>'+
        '</div>'+
        '<div>'+
          '<label>Team Emoji</label>'+
          '<input id="stEmoji" placeholder="emoji or &lt;:custom:123&gt;" />'+
          '<div class="help">Shown on buttons where supported.</div>'+
        '</div>'+
      '</div>'+

      '<label>Team Roles</label>'+
      roleSelect([],'stRoles')+
      '<div class="help">Pick roles by name; multiple roles are supported.</div>'+

      '<div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">'+
        '<button id="saveTeam" class="btn">Save</button>'+
        '<button id="resetTeam" class="btn-soft">Clear</button>'+
        (selectedTeam?'<button id="deleteTeamBtn" class="btn-danger">Delete</button>':'')+
      '</div>'+
    '</div>'+
  '</div>';
 }
function availabilityLabel(status){if(status==='reduced_assistance')return 'Reduced Assistance';if(status==='increased_volume')return 'Increased Volume';return 'Available'}
function availabilityBadge(info){const s=info.status||'available';const cls=s==='reduced_assistance'?'danger':(s==='increased_volume'?'warn':'ok');const src=info.source==='manual'?'Manual':'Auto';return '<span class="pill '+cls+'">'+availabilityLabel(s)+'</span> <span class="muted">'+src+' Â· '+(info.count||0)+' active</span>'}
function renderAvailability(){const types=(state.ticketTypes||[]);const byKey=new Map((state.availability||[]).map(v=>[v.key,v]));const opts='<option value=\"auto\">Automatic</option><option value=\"available\">Available</option><option value=\"increased_volume\">Increased Volume</option><option value=\"reduced_assistance\">Reduced Assistance</option>';const rows=types.map(t=>{const key=String(t.name||'').trim().toLowerCase();const info=byKey.get(key)||{status:'available',count:0,source:'automatic'};const manual=info.manualStatus||'auto';return '<div class=\"item\"><div class=\"item-top\"><strong>'+esc(t.name)+'</strong><span>'+availabilityBadge(info)+'</span></div><div class="row" style="margin-top:8px"><div><label>Override</label><select class="availSelect" data-name="'+esc(t.name)+'\">'+opts.replace('value=\"'+esc(manual)+'\"','value=\"'+esc(manual)+'\" selected')+'</select></div><div><label>Automatic</label><div class="muted">'+availabilityLabel(info.automaticStatus||'available')+'</div></div></div></div>'}).join('');return '<div class="grid"><div class="card"><h3>Ticket Availability</h3><p class="muted">Overrides apply per ticket type. Automatic mode uses active ticket thresholds.</p></div><div class="card"><h3>Per Ticket Type</h3><div class="list\">'+(rows||'<span class="muted">No ticket types configured yet.</span>')+'</div></div></div>'}
 function renderTypes(){
  const types=Array.isArray(state.ticketTypes)?state.ticketTypes:[];
  const selectedName=(ui&&ui.selectedType)?String(ui.selectedType):'';
  const selectedType=types.find(t=>t&&t.name===selectedName)||null;
  const list=types
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
     const active=t&&t.name===selectedName;
     const e=emojiHtml(t.emoji||'');
     const cat=(state.categoryCatalog||[]).find(c=>c.id===t.categoryId)?.name||'Default';
     return '<button type="button" class="list-btn ttPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
       '<div class="list-title">'+(e?e+' ':'')+esc(t.name)+'</div>'+
       '<div class="list-meta">'+esc(cat)+' Â· '+(t.requireReason===false?'No reason':'Reason required')+' Â· '+(t.allowAttachments===false?'No files':'Files ok')+'</div>'+
     '</button>';
   }).join('')||'<div class="muted">No ticket types yet.</div>';

  return '<div class="split">'+
    '<div class="card list-card">'+
      '<div class="list-head">'+
        '<div>'+
          '<h3 style="margin:0">Ticket Types</h3>'+
          '<div class="muted">Select a type to edit.</div>'+
        '</div>'+
        '<button id="newTypeBtn" class="btn-soft" style="width:auto">New</button>'+
      '</div>'+
      '<input id="typeSearch" placeholder="Search ticket types..." />'+
      '<div class="list list-compact" id="typesList" style="margin-top:10px">'+list+'</div>'+
    '</div>'+

    '<div class="card">'+
      '<h3>'+(selectedType?'Edit Ticket Type':'Create Ticket Type')+'</h3>'+
      '<div class="muted" style="margin-bottom:10px">'+(selectedType?('Editing: '+esc(selectedType.name)):'Create a new type, then configure its behavior.')+'</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Name</label>'+
          '<input id="ttName" placeholder="General Support" />'+
          '<div class="help">Displayed to users; also used to match Support Teams.</div>'+
        '</div>'+
        '<div>'+
          '<label>Emoji</label>'+
          '<input id="ttEmoji" placeholder="emoji or &lt;:custom:123&gt;" />'+
          '<div class="help">Optional; appears on buttons when available.</div>'+
        '</div>'+
      '</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Accent Color</label>'+
          '<input id="ttColor" value="#5865F2" />'+
          '<div class="help">Used in dashboard previews and embeds.</div>'+
        '</div>'+
        '<div>'+
          '<label>Channel Name Format</label>'+
          '<input id="ttFormat" placeholder="#support-{username}" />'+
          '<div class="help">Use <code>{username}</code> in the name template.</div>'+
        '</div>'+
      '</div>'+

      '<label>Ticket Category</label>'+
      categorySelect('ttCategory','','Use default ticket category')+
      '<div class="help">Routes tickets for this type into a Discord category.</div>'+

      '<label>Aliases</label>'+
      '<textarea id="ttAliases" placeholder="support, gs, general"></textarea>'+
      '<div class="help">Comma or newline separated.</div>'+

      '<label>Support Team Roles</label>'+
      roleSelect([],'ttRoles')+
      '<div class="help">Roles that can view/respond in the ticket channel.</div>'+

      '<div class="row">'+
        '<div>'+
          '<label>Open Message Title</label>'+
          '<input id="ttOpenTitle" placeholder="{ticketType}" />'+
        '</div>'+
        '<div>'+
          '<label>Open Message Description</label>'+
          '<textarea id="ttOpenDescription" placeholder="Requester: {requester}\\nReason: {reason}"></textarea>'+
          '<div class="help">Supports placeholders like <code>{requester}</code>, <code>{reason}</code>, <code>{channel}</code>.</div>'+
        '</div>'+
      '</div>'+

      '<div class="row" style="grid-template-columns:1fr 1fr">'+
        '<div style="display:grid;gap:6px;margin-top:6px">'+
         '<label class="checkbox-wrapper">'+
          '<input type="checkbox" id="ttRequireReason" checked />'+
          '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'+
          '<span class="label">Require reason</span>'+
         '</label>'+
         '<label class="checkbox-wrapper">'+
          '<input type="checkbox" id="ttAllowFiles" checked />'+
          '<span class="checkmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'+
          '<span class="label">Allow file uploads</span>'+
         '</label>'+
        '</div>'+
      '</div>'+

      '<div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">'+
        '<button id="saveType" class="btn">Save</button>'+
        '<button id="resetType" class="btn-soft">Clear</button>'+
        (selectedType?'<button id="deleteTypeBtn" class="btn-danger">Delete</button>':'')+
      '</div>'+
    '</div>'+
  '</div>';
 }
 function renderTags(){
  const tags=Array.isArray(state.tags)?state.tags:[];
  const selectedName=(ui&&ui.selectedTag)?String(ui.selectedTag):'';
  const selectedTag=tags.find(t=>t&&t.name===selectedName)||null;
  const list=tags
   .slice()
   .sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')))
   .map(t=>{
    const active=t&&t.name===selectedName;
    return '<button type="button" class="list-btn tagPick '+(active?'active':'')+'" data-name="'+esc(t.name)+'">'+
      '<div class="list-title">'+esc(t.name)+'</div>'+
      '<div class="list-meta">'+esc(t.kind||'suggestion')+' Â· '+esc(t.title||'')+'</div>'+
    '</button>';
   }).join('')||'<div class="muted">No tags yet.</div>';

  return \`
  <div class="split">
    <div class="card list-card">
      <div class="list-head">
        <div>
          <h3 style="margin:0">Tags</h3>
          <div class="muted">Select a tag to edit.</div>
        </div>
        <button id="newTagBtn" class="btn-soft" style="width:auto">New</button>
      </div>
      <input id="tagSearch" placeholder="Search tags..." />
      <div class="list list-compact" id="tagsList" style="margin-top:10px">\${list}</div>
    </div>

    <div class="card">
      <h3>\${selectedTag?'Edit Tag':'Create Tag'}</h3>
      <div class="muted" style="margin-bottom:10px">\${selectedTag?('Editing: '+esc(selectedTag.name)):'Tags power AI suggestions/solutions.'}</div>

      <div class="row">
        <div>
          <label>Name</label>
          <input id="tagName" placeholder="refund" />
          <div class="help">Short identifier users might refer to.</div>
        </div>
        <div>
          <label>Type</label>
          <select id="tagKind">
            <option value="suggestion">Suggestion</option>
            <option value="solution">Solution</option>
          </select>
          <div class="help">Solutions show a â€œresolvedâ€ button in AI flows.</div>
        </div>
      </div>

      <label>Title</label>
      <input id="tagTitle" placeholder="Refund Policy" />

      <label>Description</label>
      <textarea id="tagDesc" placeholder="Explain what to do next..."></textarea>

      <label>Keywords</label>
      <textarea id="tagKeys" placeholder="refund, chargeback, billing"></textarea>
      <div class="help">Comma or newline separated.</div>

      <div class="row" style="margin-top:12px;grid-template-columns:1fr 1fr 1fr">
        <button id="saveTag" class="btn">Save</button>
        <button id="resetTag" class="btn-soft">Clear</button>
        \${selectedTag?'<button id="deleteTagBtn" class="btn-danger">Delete</button>':''}
      </div>
    </div>
  </div>\`;
 }
function renderTickets(){
 const tickets=Array.isArray(state.tickets)?state.tickets:[];
 const guildId=state.guildId||'';
 const canClose=Boolean(state&&state.access&&state.access.canCloseTickets);
 const canEscalate=Boolean(state&&state.access&&state.access.canManageEscalations);
 const canNotes=Boolean(state&&state.access&&state.access.canEditNotes);
 const typeOptions=['<option value=\"\">All ticket types</option>'].concat((state.ticketTypes||[]).map(t=>'<option value=\"'+esc(t.name||'')+'\">'+esc(t.name||'')+'</option>')).join('');
 const escalationLabel=(level)=>level==='immediate'?'Immediate':level==='high'?'High':level==='medium'?'Medium':'None';
 const row=t=>{
  const name=t.channelName?('#'+t.channelName):('Ticket Channel');
  const url=guildId?('https://discord.com/channels/'+guildId+'/'+t.channelId):'';
  const topName=url?('<a href=\"'+esc(url)+'\" target=\"_blank\" rel=\"noreferrer\" style=\"color:inherit;text-decoration:none\">'+esc(name)+'</a>'):esc(name);
  const createdAt=esc(String(t.createdAt||'').replace('T',' ').slice(0,19));
  const u=(id)=>id?('<span class=\"mention user\">@'+esc(String(id).slice(0,10))+'</span>'):'<span class=\"muted\">(unknown)</span>';
  const claimed=t.claimedBy?u(t.claimedBy):'<span class=\"muted\">(unclaimed)</span>';
  const created=t.createdBy?u(t.createdBy):'<span class=\"muted\">(unknown)</span>';
  const type=esc(t.ticketType||'Unknown');
  const escalations=Array.isArray(t.escalations)?t.escalations:[];
  const latestEsc=escalations.length?escalations[escalations.length-1]:null;
  const escBadge=latestEsc?('<span class="pill '+(latestEsc.level==='immediate'?'danger':latestEsc.level==='high'?'warn':'')+'">Escalation: '+esc(escalationLabel(latestEsc.level))+'</span>'):'<span class="pill">Escalation: None</span>';
  const notes=Array.isArray(t.notes)?t.notes:[];
  const notesHtml=notes.length?notes.slice(-5).map(n=>'<div class="item" style="padding:10px 12px"><div><strong>'+esc((n.authorId||'staff').slice(0,12))+'</strong><div class="muted">'+esc(String(n.createdAt||'').replace('T',' ').slice(0,19))+'</div></div><div style="margin-top:6px;white-space:pre-wrap">'+esc(n.body||'')+'</div></div>').join(''):'<div class="muted">No notes yet.</div>';
  const noteComposer=canNotes?('<textarea class="ticketNoteBody" data-id="'+esc(t.channelId)+'" placeholder="Add an internal note..."></textarea><div class="row" style="margin-top:8px">'+
    '<button class="btn saveTicketNote" data-id="'+esc(t.channelId)+'">Save Note</button>'+
    (canEscalate?'<select class="ticketEscalationLevel" data-id="'+esc(t.channelId)+'"><option value="">Escalate...</option><option value="medium">Medium</option><option value="high">High</option><option value="immediate">Immediate</option></select><button class="btn-soft applyTicketEscalation" data-id="'+esc(t.channelId)+'">Apply</button>':'')+
   '</div>'):'';
  return '<div class="item"><div class="item-top"><strong>'+topName+'</strong><div style="display:flex;gap:6px"><button class="btn-soft copyTicket" data-id="'+esc(t.channelId)+'">Copy Link</button>'+(canClose?'<button class="btn-danger closeTicket" data-id="'+esc(t.channelId)+'">Close</button>':'')+'</div></div><div class="muted">Type: <strong>'+type+'</strong> &bull; Opened by '+created+' &bull; Claimed: '+claimed+(createdAt?' &bull; '+createdAt:'')+'</div><div style="margin-top:8px">'+escBadge+'</div><details class="acc" style="margin-top:10px"><summary><span>Internal Notes</span><span class="pill">'+notes.length+'</span></summary><div class="acc-body">'+notesHtml+noteComposer+'</div></details></div>';
 };

 const massClose=canClose?'<details class="acc"><summary><span>Advanced: Mass Close</span><span class="pill warn">Danger</span></summary><div class="acc-body">'+
  '<p class="muted">Closes matching active tickets and generates transcripts. Use carefully.</p>'+
  '<div class="row"><div><label>Ticket Type</label><select id="massCloseType">'+typeOptions+'</select></div><div><label>Limit</label><input id="massCloseLimit" type="number" value="25" min="1" max="100" /></div></div>'+
  '<label>Reason</label><input id="massCloseReason" placeholder="Mass closed via dashboard." />'+
  '<div class="row" style="margin-top:10px"><button id="massCloseBtn" class="btn-danger">Mass Close</button><button id="refreshTickets" class="btn-soft">Refresh</button></div>'+
 '</div></details>':'';

 return '<div class="grid">'+
  '<div class="card"><h3>Tickets</h3><p class="muted">A calmer queue view with escalation and internal notes for the team.</p>'+massClose+'</div>'+
  '<div class="card"><h3>Active Tickets</h3><div class="row"><div><label>Search</label><input id="ticketSearch" placeholder="#channel, type, user id..." /></div></div><div id="ticketsList" class="list" style="margin-top:10px">'+(tickets.length?tickets.map(row).join(''):'<div class="muted">No active tickets.</div>')+'</div></div>'+
 '</div>';
}
function renderTranscripts(){
 const items=Array.isArray(state.transcripts)?state.transcripts:[];
 const retention=Number(state.transcriptRetentionDays||0);
 const hint=retention>0?('Transcripts auto-delete after '+retention+' day(s).'):('Transcript retention is disabled.');
 const bytes=(n)=>{const v=Number(n||0);if(!v)return '—';const units=['B','KB','MB','GB'];let i=0,x=v;while(x>=1024&&i<units.length-1){x/=1024;i+=1}const out=i===0?String(x):x.toFixed(x<10?1:0);return out+' '+units[i]};
 const u=(id)=>id?('<span class=\"mention user\">@'+esc(String(id).slice(0,10))+'</span>'):'<span class=\"muted\">(unknown)</span>';
 const expires=(archivedAt)=>{if(!(retention>0)||!archivedAt)return '';const ts=Date.parse(archivedAt);if(!Number.isFinite(ts))return '';return new Date(ts+(retention*86400000)).toISOString().replace('T',' ').slice(0,19)};
 const row=t=>{
  const id=String(t.channelId||'');
  const title=t.channelName?('#'+t.channelName):('Transcript '+id.slice(0,10));
  const type=esc(t.ticketType||'Unknown');
  const archivedAt=String(t.archivedAt||t.closedAt||'');
  const closedAt=esc(archivedAt.replace('T',' ').slice(0,19));
  const opener=t.createdBy?u(t.createdBy):'<span class=\"muted\">(unknown)</span>';
  const closer=t.closedBy?u(t.closedBy):'<span class=\"muted\">(system)</span>';
  const size=esc(bytes(t.size));
  const exp=expires(archivedAt);
  const hay=[id,t.channelName,t.ticketType,t.createdBy,t.claimedBy,t.closedBy].filter(Boolean).join(' ').toLowerCase();
  const noteCount=Array.isArray(t.notes)?t.notes.length:0;
  const notes=noteCount?('<details class=\"acc\" style=\"margin-top:8px\"><summary><span>Notes</span><span class=\"pill\">'+noteCount+'</span></summary><div class=\"acc-body\">'+t.notes.slice(-5).map(n=>'<div class=\"item\" style=\"padding:10px 12px\"><div><strong>'+esc(String(n.authorId||'staff').slice(0,12))+'</strong><div class=\"muted\">'+esc(String(n.createdAt||'').replace('T',' ').slice(0,19))+'</div></div><div style=\"margin-top:6px;white-space:pre-wrap\">'+esc(n.body||'')+'</div></div>').join('')+'</div></details>'):'';
  const reason=t.closeReason?('<details class=\"acc\" style=\"margin-top:8px\"><summary><span>Reason</span><span class=\"pill\">View</span></summary><div class=\"acc-body\"><div class=\"muted\">'+esc(t.closeReason)+'</div></div></details>'):'';
  return '<div class=\"item transcriptItem\" data-hay=\"'+esc(hay)+'\"><div class=\"item-top\"><strong>'+esc(title)+'</strong><div style=\"display:flex;gap:6px\">'+
   '<button class=\"btn-soft viewTranscript\" data-id=\"'+esc(id)+'\">View</button>'+
   '<button class=\"btn-soft downloadTranscript\" data-id=\"'+esc(id)+'\">Download</button>'+
   (state.isOwner?'<button class=\"btn-danger deleteTranscript\" data-id=\"'+esc(id)+'\">Delete</button>':'')+
   '</div></div><div class=\"muted\">Type: <strong>'+type+'</strong> &bull; Opened by '+opener+' &bull; Closed by '+closer+(closedAt?' &bull; '+closedAt:'')+' &bull; '+size+(exp?(' &bull; Expires '+esc(exp)):'')+'</div>'+reason+notes+'</div>';
 };

 return '<div class=\"grid\">'+
  '<div class=\"card\"><h3>Transcripts</h3><p class=\"muted\">Browse saved ticket transcripts. '+esc(hint)+'</p><div class=\"row\"><div><label>Search</label><input id=\"transcriptSearch\" placeholder=\"#channel, type, user id...\" /></div></div></div>'+
  '<div class=\"card\"><h3>Saved Transcripts</h3><div id=\"transcriptsList\" class=\"list\" style=\"margin-top:10px\">'+(items.length?items.map(row).join(''):'<div class=\"muted\">No transcripts saved yet.</div>')+'</div></div>'+
 '</div>';
}
function renderFeedback(){return '<div class="card"><h3>Feedback Command Settings</h3><label>Feedback Channel</label>'+channelSelect('feedbackConfigId',state.botConfig.appealsChannelId||'','Select feedback channel')+'<div style="margin-top:10px"><button id="saveFeedback" class="btn">Save</button></div></div>'}
function renderAppeal(){return renderFeedback()}
function renderStats(){const t=state.statistics&&state.statistics.totals?state.statistics.totals:{activeTickets:0,totalClaimed:0,totalClosed:0};return '<div class="grid"><div class="card"><h3>Numbers (14d)</h3><div class="row"><div class="item"><div class="muted">Active tickets</div><strong>'+t.activeTickets+'</strong></div><div class="item"><div class="muted">Claimed</div><strong>'+t.totalClaimed+'</strong></div><div class="item"><div class="muted">Closed</div><strong>'+t.totalClosed+'</strong></div></div><div class="muted" style="margin-top:8px">Claimed/Closed exclude self-opened tickets when that data is available.</div></div><div class="card"><h3>Support Member Lookup</h3><label>User (ID or mention)</label><input id="staffLookupQuery" placeholder="<@123> or 123..." /><div class="row" style="margin-top:10px"><button id="staffLookupBtn" class="btn">Lookup</button><button id="staffLookupClear" class="btn-soft">Clear</button></div><div id="staffLookupResult" class="list" style="margin-top:10px"></div></div></div>'}
function renderBranding(){const templates=state.botConfig.embedTemplates||defaultEmbedTemplates;const keys=Object.keys(templates);const firstKey=keys[0]||'ticketClaimed';const first=templates[firstKey]||{title:'',description:'',color:'#5865F2'};return '<div class="grid"><div class="card"><h3>Visual Components V2 Template Editor</h3><p class="muted">Template workflow: pick a template, edit text, preview live, then save. These templates render into Components V2 containers (accent color applies only when the bot decides the message is success/error).</p><div class="item" style="margin-top:10px"><div class="muted">Separators: add <code>[[divider]]</code>, <code>[[divider:large]]</code>, <code>[[space]]</code>, or <code>[[space:large]]</code> on their own line inside <strong>Description</strong> to insert dividers/spacers.</div></div><div class="row"><div><label>Template</label><select id="brandingKey">'+keys.map(k=>'<option value="'+esc(k)+'">'+esc(k)+'</option>').join('')+'</select></div><div><label>Accent Color</label><input id="brandingColor" value="'+esc(first.color||'#5865F2')+'" placeholder="#5865F2" /></div></div><label>Title</label><input id="brandingTitle" value="'+esc(first.title||'')+'" /><label>Description</label><textarea id="brandingDescription" style="min-height:160px">'+esc(first.description||'')+'</textarea><div class="row" style="margin-top:10px"><button id="applyBrandingTemplate" class="btn-soft">Apply to Template</button><button id="saveBranding" class="btn">Save Templates</button></div><div class="row" style="margin-top:10px"><button id="resetBrandingDefaults" class="btn-soft">Reset to Defaults</button><button id="formatBrandingJson" class="btn-soft">Format JSON</button></div></div><div class="card"><h3>Live Preview</h3><div class="preview-shell"><div class="preview-msg"><div class="preview-avatar"></div><div class="preview-content"><div class="preview-name">Tickets Bot <span class="preview-tag">BOT</span></div><div id="brandingPreviewEmbed" class="preview-embed"><div id="brandingPreviewBar" class="preview-bar"></div><div class="preview-main"><div id="brandingPreviewTitle" class="preview-title"></div><div id="brandingPreviewDesc" class="preview-desc"></div></div></div></div></div></div><label style="margin-top:14px">Advanced JSON</label><textarea id="brandingTemplates" style="min-height:240px;font-family:Consolas,monospace">'+esc(JSON.stringify(templates,null,2))+'</textarea></div></div>'}
function renderDocs(){
 const rows=[['{ticketType}','Ticket type name'],['{requester}','User mention'],['{username}','Requester username'],['{userId}','Requester ID'],['{reason}','Open reason'],['{timestamp}','Discord timestamp'],['{timestampIso}','ISO timestamp'],['{date}','Date YYYY-MM-DD'],['{time}','Time HH:mm:ss UTC'],['{channel}','Ticket channel mention'],['{channelId}','Ticket channel ID']];
 const embedExample=esc(JSON.stringify({content:'Optional message content',embeds:[{title:'Embed title',description:'Embed description',color:5793266,thumbnail:{url:'https://example.com/thumb.png'},image:{url:'https://example.com/image.png'},footer:{text:'Footer text'}}]},null,2));
 const attachmentExample=esc(JSON.stringify({content:'Image from attachment',embeds:[{title:'Proof',image:{url:'attachment://proof.png'}}]},null,2));
 const sepExample=esc('## Title\\n\\nFirst paragraph.\\n\\n[[divider]]\\n\\nSecond paragraph.\\n\\n[[space:large]]\\n\\nThird paragraph.');
 return '<div class="grid">'+
  '<div class="card"><h3>Placeholders</h3><div class="list">'+
   rows.map(r=>'<div class="item"><div class="item-top"><strong>'+r[0]+'</strong><button class="btn-soft copyPH" data-v="'+r[0]+'">Copy</button></div><div class="muted">'+r[1]+'</div></div>').join('')+
  '</div></div>'+

  '<div class="card"><h3>Embeds: Images</h3><div class="muted">Use <code>thumbnail.url</code> and <code>image.url</code> inside an embed payload.</div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+embedExample+'</pre>'+
   '<div class="muted" style="margin-top:10px">To reference an attached file, set <code>image.url</code> to <code>attachment://filename.png</code> and upload the file with that name.</div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+attachmentExample+'</pre>'+
  '</div>'+

  '<div class="card"><h3>Components V2: Dividers & Spacing</h3>'+
   '<div class="muted">Components V2 messages use containers/text displays. In the <span class="muted">Embed Editor</span>, you can add separators (dividers) and spacing (margins) inside template descriptions using tokens on their own line.</div>'+
   '<div class="item" style="margin-top:10px"><div class="muted">'+
    '<div><code>[[divider]]</code> &mdash; divider, small spacing</div>'+
    '<div><code>[[divider:large]]</code> &mdash; divider, large spacing</div>'+
    '<div><code>[[space]]</code> &mdash; spacing only (no line), small</div>'+
    '<div><code>[[space:large]]</code> &mdash; spacing only (no line), large</div>'+
   '</div></div>'+
   '<pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);padding:10px;border-radius:10px;margin-top:10px">'+sepExample+'</pre>'+
   '<div class="item" style="margin-top:10px"><div class="muted">Tip: keep accent colors minimal; the bot applies accent automatically for success/error notices.</div></div>'+
  '</div>'+
 '</div>'}
function selectedRoles(id){return Array.from(document.querySelectorAll('input[data-ms-check="'+id+'"]:checked')).map(el=>el.value)}
function setRoleSelection(id,values){const selectedSet=new Set((values||[]).map(String));document.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=selectedSet.has(el.value)});updateRoleSelectionUi(id)}
function updateRoleSelectionUi(id){const values=selectedRoles(id);const count=document.getElementById(id+'Count');if(count)count.textContent=values.length+' selected';const chipsEl=document.getElementById(id+'Chips');if(chipsEl){const roleMap=new Map((state.roleCatalog||[]).map(r=>[r.id,r]));chipsEl.innerHTML=values.map(v=>roleMap.get(v)).filter(Boolean).map(r=>'<span class="ms-chip">@'+esc(r.name)+'</span>').join('')}}
function closePickers(){document.querySelectorAll('.custom-select.open').forEach(el=>el.classList.remove('open'));document.querySelectorAll('.role-ms.open').forEach(el=>el.classList.remove('open'));document.querySelectorAll('.topnav.open').forEach(el=>el.classList.remove('open'))}
function wireRoleMultiSelect(id){const wrap=document.querySelector('[data-role-ms="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-ms-trigger="'+id+'"]');const search=wrap.querySelector('[data-ms-search="'+id+'"]');const allBtn=wrap.querySelector('.select-all[data-select="'+id+'"]');const clearBtn=wrap.querySelector('.clear-all[data-select="'+id+'"]');if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();wrap.querySelectorAll('[data-ms-item="'+id+'"]').forEach(item=>{item.style.display=!q||String(item.getAttribute('data-name')||'').includes(q)?'flex':'none'})};if(allBtn)allBtn.onclick=()=>{wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=true});updateRoleSelectionUi(id)};if(clearBtn)clearBtn.onclick=()=>{wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.checked=false});updateRoleSelectionUi(id)};wrap.querySelectorAll('input[data-ms-check="'+id+'"]').forEach(el=>{el.onchange=()=>updateRoleSelectionUi(id)});updateRoleSelectionUi(id)}
function wireChannelSelect(id,placeholder){const wrap=document.querySelector('[data-cs="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-cs-trigger="'+id+'"]');const hidden=document.getElementById(id);const label=document.getElementById(id+'Label');const search=wrap.querySelector('[data-cs-search="'+id+'"]');const opts=Array.from(wrap.querySelectorAll('[data-cs-opt="'+id+'"]'));if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();opts.forEach(btn=>{btn.style.display=!q||btn.textContent.toLowerCase().includes(q)?'flex':'none'})};opts.forEach(btn=>{btn.onclick=()=>{const v=btn.getAttribute('data-value')||'';if(hidden)hidden.value=v;if(label)label.textContent=channelLabel(v,placeholder);opts.forEach(o=>o.classList.toggle('active',o===btn));wrap.classList.remove('open')}})}
function wireCategorySelect(id,placeholder){const wrap=document.querySelector('[data-cs="'+id+'"]');if(!wrap)return;const trigger=wrap.querySelector('[data-cs-trigger="'+id+'"]');const hidden=document.getElementById(id);const label=document.getElementById(id+'Label');const search=wrap.querySelector('[data-cs-search="'+id+'"]');const opts=Array.from(wrap.querySelectorAll('[data-cs-opt="'+id+'"]'));if(trigger)trigger.onclick=(e)=>{e.stopPropagation();const next=!wrap.classList.contains('open');closePickers();if(next){wrap.classList.add('open');if(search)search.focus();}};if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();opts.forEach(btn=>{btn.style.display=!q||btn.textContent.toLowerCase().includes(q)?'flex':'none'})};opts.forEach(btn=>{btn.onclick=()=>{const v=btn.getAttribute('data-value')||'';if(hidden)hidden.value=v;if(label)label.textContent=categoryLabel(v,placeholder);opts.forEach(o=>o.classList.toggle('active',o===btn));wrap.classList.remove('open')}})}
function fillType(name){const t=state.ticketTypes.find(x=>x.name===name);if(!t)return;ttName.value=t.name||'';ttEmoji.value=t.emoji||'';ttColor.value=t.embedColor||'#5865F2';ttFormat.value=t.format||'';const catEl=document.getElementById('ttCategory');if(catEl)catEl.value=t.categoryId||'';const catLabel=document.getElementById('ttCategoryLabel');if(catLabel)catLabel.textContent=categoryLabel((catEl&&catEl.value)||'', 'Use default ticket category');ttAliases.value=(t.aliases||[]).join(', ');ttOpenTitle.value=(t.openEmbed&&t.openEmbed.title)||'';ttOpenDescription.value=(t.openEmbed&&t.openEmbed.description)||'';ttRequireReason.checked=t.requireReason!==false;ttAllowFiles.checked=t.allowAttachments!==false;setRoleSelection('ttRoles',t.roleIds||[])}
function fillTag(name){const t=state.tags.find(x=>x.name===name);if(!t)return;tagName.value=t.name||'';tagKind.value=t.kind||'suggestion';tagTitle.value=t.title||'';tagDesc.value=t.description||'';tagKeys.value=(t.keywords||[]).join(', ')}
function fillTeam(name){const t=state.supportTeams.find(x=>x.name===name);if(!t)return;stName.value=t.name||'';stEmoji.value=t.emoji||'';setRoleSelection('stRoles',(t.roleIds||(t.roleId?[t.roleId]:[]))||[])}
function getBrandingTemplates(){const box=document.getElementById('brandingTemplates');if(!box)return {};try{const parsed=JSON.parse(box.value);return parsed&&typeof parsed==='object'?parsed:{};}catch{return {}}}
function renderBrandingPreview(){const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');const bar=document.getElementById('brandingPreviewBar');const titleView=document.getElementById('brandingPreviewTitle');const descView=document.getElementById('brandingPreviewDesc');const color=((colorEl&&colorEl.value)||'#5865F2').trim();if(bar)bar.style.background=color.startsWith('#')?color:('#'+color.replace('#',''));if(titleView)titleView.textContent=(titleEl&&titleEl.value)||'(No title)';const rawDesc=(descEl&&descEl.value)||'';const cleaned=rawDesc.split(/\\r?\\n/).map(line=>{const t=String(line||'').trim();if(/^\\[\\[(divider|sep|separator)(?::(small|large))?\\]\\]$/i.test(t))return '────────';if(/^\\[\\[(space|spacer)(?::(small|large))?\\]\\]$/i.test(t))return '';return line}).join('\\n').replace(/\\n{3,}/g,'\\n\\n').trim()||'(No description)';if(descView)descView.textContent=cleaned}
function loadBrandingKey(key){const templates=getBrandingTemplates();const t=templates[key]||defaultEmbedTemplates[key]||{title:'',description:'',color:'#5865F2'};const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');if(colorEl)colorEl.value=t.color||'#5865F2';if(titleEl)titleEl.value=t.title||'';if(descEl)descEl.value=t.description||'';renderBrandingPreview()}
function applyBrandingFormToTemplate(){const keyEl=document.getElementById('brandingKey');const colorEl=document.getElementById('brandingColor');const titleEl=document.getElementById('brandingTitle');const descEl=document.getElementById('brandingDescription');const box=document.getElementById('brandingTemplates');if(!keyEl||!box)return;const key=keyEl.value;const templates=getBrandingTemplates();templates[key]={...(templates[key]||{}),color:((colorEl&&colorEl.value)||'').trim(),title:(titleEl&&titleEl.value)||'',description:(descEl&&descEl.value)||''};box.value=JSON.stringify(templates,null,2);renderBrandingPreview()}
function wire(){
 if(!window.__navWired){
 window.__navWired=true;
  const pageTitleEl=document.getElementById('pageTitle');
  const topNav=document.getElementById('topNav');
  const topNavBtn=document.getElementById('topNavBtn');
  const topNavLabel=document.getElementById('topNavLabel');
  const topNavMenu=document.getElementById('topNavMenu');
  const topNavItems=Array.from(document.querySelectorAll('[data-topnav-item]'));
  const themeNav=document.getElementById('themeNav');
  const themeBtn=document.getElementById('themeBtn');
  const themeLabel=document.getElementById('themeLabel');
  const themeItems=Array.from(document.querySelectorAll('[data-theme-item]'));
    const menuBtn=document.getElementById('menuBtn');
    const menuOverlay=document.getElementById('menuOverlay');
    const closeMenu=()=>{try{document.body.classList.remove('menu-open')}catch{}};
    if(menuBtn)menuBtn.onclick=()=>{document.body.classList.toggle('menu-open')};
    if(menuOverlay)menuOverlay.onclick=()=>closeMenu();
    const navTitleForPath=(p)=>({ '/overview':'Home','/settings':'Settings','/availability':'Availability','/commands/ticket-types':'Ticket Types','/commands/tag':'Tags','/tickets':'Tickets','/transcripts':'Transcripts','/commands/feedback':'Feedback','/statistics':'Statistics','/embed-editor':'Embed Editor','/documentation':'Documentation'}[p]||'Dashboard');
     const groupForPath=(p)=>{if(p==='/overview'||p==='/settings'||p==='/availability')return 'general';if(p==='/commands/ticket-types'||p==='/commands/tag'||p==='/tickets'||p==='/transcripts')return 'tickets';return 'content'};
     const allowedPages=()=>{const access=(state&&state.access)||{};const set=new Set(['/documentation']);if(access.isOwner||access.canFullDashboard){['/overview','/settings','/availability','/commands/ticket-types','/commands/tag','/tickets','/transcripts','/commands/feedback','/statistics','/embed-editor'].forEach(p=>set.add(p));return set}if(access.canManageTicketTypes){set.add('/overview');set.add('/settings');set.add('/commands/ticket-types')}if(access.canManageAvailability)set.add('/availability');if(access.canViewTickets||access.canManageEscalations)set.add('/tickets');if(access.canViewTranscripts)set.add('/transcripts');return set};
     let darkSecretCount=0;
     const normaliseTheme=(t)=>{const v=String(t||'').trim();return (v==='light'||v==='dark')?v:'dark'};
     const syncThemeUi=()=>{const cur=normaliseTheme(document.body.dataset.theme);if(themeLabel)themeLabel.textContent='Theme: '+(cur==='light'?'Light':'Dark');themeItems.forEach(btn=>{const v=btn.getAttribute('data-theme-item')||'';btn.classList.toggle('active',v===cur)})};
     const applyTheme=(t)=>{document.body.dataset.theme=normaliseTheme(t);syncThemeUi()};
     const setTheme=(t)=>{const next=normaliseTheme(t);try{localStorage.setItem(themeKey,next)}catch{}applyTheme(next)};
     const registerDarkSecret=()=>false;
     applyTheme(document.body.dataset.theme||'dark');
     if(themeNav&&themeBtn){themeBtn.onclick=(ev)=>{ev.stopPropagation();const next=!themeNav.classList.contains('open');closePickers();if(next)themeNav.classList.add('open');else themeNav.classList.remove('open')}};
     themeItems.forEach(btn=>{btn.onclick=()=>{const pick=btn.getAttribute('data-theme-item')||'';if(pick==='dark'){setTheme('dark')}else{setTheme('light')}closePickers()}});
     const closeTopNav=()=>{if(topNav)topNav.classList.remove('open')};
   const setTopNavValue=(p)=>{const next=String(p||'');if(topNav)topNav.dataset.value=next;if(topNavLabel)topNavLabel.textContent=navTitleForPath(next);topNavItems.forEach(b=>{const v=b.getAttribute('data-value')||'';b.classList.toggle('active',v===next)})};
   const syncNav=()=>{document.querySelectorAll('.nav-item').forEach(a=>{const p=a.getAttribute('data-nav')||a.getAttribute('href')||'';a.classList.toggle('active',p===currentPath)})};
   const syncGroups=()=>{const g=groupForPath(currentPath);document.querySelectorAll('[data-nav-group]').forEach(el=>{const name=el.getAttribute('data-nav-group');el.classList.toggle('open',name===g)})};
   const navigate=(p)=>{const next=String(p||'').trim();if(!next||next===currentPath||!allowedPages().has(next))return;closeMenu();closeTopNav();history.pushState({},'',next);currentPath=next;if(pageTitleEl)pageTitleEl.textContent=navTitleForPath(currentPath);setTopNavValue(currentPath);render();syncNav();syncGroups();window.scrollTo({top:0,behavior:'smooth'})};
   window.__dashNav={navTitleForPath,navigate,syncNav,syncGroups};
   document.querySelectorAll('[data-nav]').forEach(a=>{a.onclick=(ev)=>{ev.preventDefault();navigate(a.getAttribute('data-nav'))}});
   document.querySelectorAll('[data-nav-group-btn]').forEach(b=>{b.onclick=()=>{const g=b.getAttribute('data-nav-group-btn');if(!g)return;document.querySelectorAll('[data-nav-group]').forEach(el=>{el.classList.toggle('open',el.getAttribute('data-nav-group')===g && !el.classList.contains('open'))})}});
   if(topNav&&topNavBtn){topNavBtn.onclick=(ev)=>{ev.stopPropagation();const next=!topNav.classList.contains('open');closePickers();if(next)topNav.classList.add('open');else topNav.classList.remove('open')}};
   topNavItems.forEach(btn=>{const v=btn.getAttribute('data-value')||'';btn.style.display=allowedPages().has(v)?'flex':'none';btn.onclick=()=>{navigate(v)}});
    setTopNavValue(currentPath);
    window.onpopstate=()=>{currentPath=location.pathname||'/overview';if(pageTitleEl)pageTitleEl.textContent=navTitleForPath(currentPath);setTopNavValue(currentPath);render();syncNav();syncGroups()};
    syncNav();syncGroups();
    window.addEventListener('keydown',(ev)=>{if(ev.key==='Escape'){closeMenu();closePickers();closeTopNav();}}, { passive: true });
 
   document.querySelectorAll('input[name=\"navGroupPick\"]').forEach(r=>{
    r.onchange=()=>{const v=r.value;document.querySelectorAll('[data-nav-group]').forEach(el=>{el.classList.toggle('open',el.getAttribute('data-nav-group')===v)})};
   });
 }
 document.onclick=(ev)=>{if(!ev.target.closest('.custom-select')&&!ev.target.closest('.role-ms')&&!ev.target.closest('.topnav'))closePickers()};
 document.querySelectorAll('.qa').forEach(b=>b.onclick=()=>{const p=b.getAttribute('data-go');if(p&&window.__dashNav&&typeof window.__dashNav.navigate==='function')window.__dashNav.navigate(p)});
 document.querySelectorAll('.copyPH').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.v||'');note('Placeholder copied.','ok')});
 const saveConfig=document.getElementById('saveConfig');if(saveConfig)saveConfig.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,appealsChannelId:feedbackId.value||null,setup:{step:4}})});note('Settings saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const savePanelConfig=document.getElementById('savePanelConfig');if(savePanelConfig)savePanelConfig.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,panelConfig:{title:(document.getElementById('panelTitle')?.value||'').trim(),description:document.getElementById('panelDescription')?.value||'',advisory:document.getElementById('panelAdvisory')?.value||''},setup:{step:4}})});note('Panel saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const saveHomeImages=document.getElementById('saveHomeImages');if(saveHomeImages)saveHomeImages.onclick=async()=>{try{const urls=[document.getElementById('homeImg1')?.value||'',document.getElementById('homeImg2')?.value||'',document.getElementById('homeImg3')?.value||''].map(s=>String(s||'').trim()).filter(Boolean);await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:urls})});note('Home images saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const clearHomeImages=document.getElementById('clearHomeImages');if(clearHomeImages)clearHomeImages.onclick=async()=>{try{await api('/api/config',{method:'POST',body:JSON.stringify({appealsChannelId:(state&&state.botConfig&&state.botConfig.appealsChannelId)||'',homeImages:[]})});note('Home images cleared.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const saveFeedback=document.getElementById('saveFeedback');if(saveFeedback)saveFeedback.onclick=async()=>{try{await api('/api/guild-config',{method:'POST',body:JSON.stringify({guildId:state.guildId,appealsChannelId:feedbackConfigId.value||null,setup:{step:4}})});note('Feedback settings saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
 const refreshTickets=document.getElementById('refreshTickets');if(refreshTickets)refreshTickets.onclick=async()=>{try{await boot();note('Tickets refreshed.','ok')}catch(e){note(e.message,'danger')}};
 const massCloseBtn=document.getElementById('massCloseBtn');if(massCloseBtn)massCloseBtn.onclick=async()=>{try{const typeEl=document.getElementById('massCloseType');const limitEl=document.getElementById('massCloseLimit');const reasonEl=document.getElementById('massCloseReason');const ticketType=(typeEl&&typeEl.value)||'';const limit=Number((limitEl&&limitEl.value)||25);const reason=(reasonEl&&reasonEl.value)||'Mass closed via dashboard.';const confirmText=prompt('Type CLOSE to confirm mass close of up to '+limit+' ticket(s).');if(confirmText!=='CLOSE')return;const result=await api('/api/tickets/mass-close',{method:'POST',body:JSON.stringify({ticketType,limit,reason})});note('Mass close complete. Closed '+(result.closed||0)+'.','ok');await boot()}catch(e){note(e.message,'danger')}};
 document.querySelectorAll('.copyTicket').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const gid=(state&&state.guildId)?String(state.guildId):'';const link=(gid&&id)?('https://discord.com/channels/'+gid+'/'+id):id;await navigator.clipboard.writeText(link);note('Ticket link copied.','ok')}catch(e){note('Copy failed.','danger')}});
 document.querySelectorAll('.closeTicket').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const reason=prompt('Close ticket '+id+'? Enter a reason:', 'Closed via dashboard.');if(reason===null)return;await api('/api/ticket/close',{method:'POST',body:JSON.stringify({channelId:id,reason:String(reason)})});note('Ticket closed.','ok');await boot()}catch(e){note(e.message,'danger')}});
 document.querySelectorAll('.saveTicketNote').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const box=document.querySelector('.ticketNoteBody[data-id=\"'+id+'\"]');const noteBody=(box&&box.value)||'';if(!String(noteBody||'').trim())return note('Write a note first.','danger');await api('/api/ticket/note',{method:'POST',body:JSON.stringify({channelId:id,note:noteBody})});note('Note saved.','ok');await boot()}catch(e){note(e.message,'danger')}});
 document.querySelectorAll('.applyTicketEscalation').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';const levelEl=document.querySelector('.ticketEscalationLevel[data-id=\"'+id+'\"]');const level=(levelEl&&levelEl.value)||'';if(!level)return note('Choose an escalation level.','danger');await api('/api/ticket/escalate',{method:'POST',body:JSON.stringify({channelId:id,level})});note('Escalation updated.','ok');await boot()}catch(e){note(e.message,'danger')}});
 const ticketSearch=document.getElementById('ticketSearch');if(ticketSearch)ticketSearch.oninput=()=>{const q=(ticketSearch.value||'').toLowerCase().trim();document.querySelectorAll('#ticketsList .item').forEach(it=>{const show=!q||it.textContent.toLowerCase().includes(q);it.style.display=show?'':'none'})};
 document.querySelectorAll('.viewTranscript').forEach(b=>b.onclick=()=>{const id=b.dataset.id||'';if(!id)return;window.open('/transcripts/'+encodeURIComponent(id),'_blank','noopener')});
 document.querySelectorAll('.downloadTranscript').forEach(b=>b.onclick=()=>{const id=b.dataset.id||'';if(!id)return;window.open('/transcripts/'+encodeURIComponent(id)+'?download=1','_blank','noopener')});
 document.querySelectorAll('.deleteTranscript').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id||'';if(!id)return;const confirmText=prompt('Type DELETE to remove transcript '+id+' from disk.');if(confirmText!=='DELETE')return;await api('/api/transcript/delete',{method:'POST',body:JSON.stringify({channelId:id})});note('Transcript deleted.','ok');await boot()}catch(e){note(e.message,'danger')}});
 const transcriptSearch=document.getElementById('transcriptSearch');if(transcriptSearch)transcriptSearch.oninput=()=>{const q=(transcriptSearch.value||'').toLowerCase().trim();document.querySelectorAll('.transcriptItem').forEach(it=>{const hay=String(it.getAttribute('data-hay')||'');const show=!q||hay.includes(q);it.style.display=show?'':'none'})};
  const saveTeam=document.getElementById('saveTeam');if(saveTeam)saveTeam.onclick=async()=>{try{await api('/api/support-team/upsert',{method:'POST',body:JSON.stringify({name:stName.value.trim(),emoji:stEmoji.value.trim(),roleIds:selectedRoles('stRoles')})});ui.selectedTeam=stName.value.trim();saveUi();note('Support team saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const resetTeam=document.getElementById('resetTeam');if(resetTeam)resetTeam.onclick=()=>{stName.value='';stEmoji.value='';setRoleSelection('stRoles',[])};
  const saveType=document.getElementById('saveType');if(saveType)saveType.onclick=async()=>{try{await api('/api/ticket-type/upsert',{method:'POST',body:JSON.stringify({name:ttName.value.trim(),emoji:ttEmoji.value.trim(),embedColor:ttColor.value.trim(),format:ttFormat.value.trim(),categoryId:(document.getElementById('ttCategory')?.value||'').trim(),aliases:ttAliases.value,roleIds:selectedRoles('ttRoles'),openTitle:ttOpenTitle.value.trim(),openDescription:ttOpenDescription.value,requireReason:ttRequireReason.checked,allowAttachments:ttAllowFiles.checked})});ui.selectedType=ttName.value.trim();saveUi();note('Ticket type saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
  const resetType=document.getElementById('resetType');if(resetType)resetType.onclick=()=>{['ttName','ttEmoji','ttFormat','ttAliases','ttOpenTitle','ttOpenDescription'].forEach(id=>document.getElementById(id).value='');const catEl=document.getElementById('ttCategory');if(catEl)catEl.value='';const catLabel=document.getElementById('ttCategoryLabel');if(catLabel)catLabel.textContent=categoryLabel('', 'Use default ticket category');ttColor.value='#5865F2';ttRequireReason.checked=true;ttAllowFiles.checked=true;setRoleSelection('ttRoles',[])};
const saveBranding=document.getElementById('saveBranding');if(saveBranding)saveBranding.onclick=async()=>{try{const parsed=getBrandingTemplates();await api('/api/config/embeds',{method:'POST',body:JSON.stringify({embedTemplates:parsed})});note('Branding templates saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const applyBrandingTemplate=document.getElementById('applyBrandingTemplate');if(applyBrandingTemplate)applyBrandingTemplate.onclick=()=>applyBrandingFormToTemplate();
const formatBrandingJson=document.getElementById('formatBrandingJson');if(formatBrandingJson)formatBrandingJson.onclick=()=>{const box=document.getElementById('brandingTemplates');if(box)box.value=JSON.stringify(getBrandingTemplates(),null,2)};
const resetBrandingDefaults=document.getElementById('resetBrandingDefaults');if(resetBrandingDefaults)resetBrandingDefaults.onclick=()=>{const box=document.getElementById('brandingTemplates');if(box)box.value=JSON.stringify(defaultEmbedTemplates,null,2);if(brandingKey)loadBrandingKey(brandingKey.value)};
const brandingKey=document.getElementById('brandingKey');if(brandingKey)brandingKey.onchange=()=>loadBrandingKey(brandingKey.value);
const brandingTitle=document.getElementById('brandingTitle');if(brandingTitle)brandingTitle.oninput=()=>renderBrandingPreview();
const brandingDescription=document.getElementById('brandingDescription');if(brandingDescription)brandingDescription.oninput=()=>renderBrandingPreview();
const brandingColor=document.getElementById('brandingColor');if(brandingColor)brandingColor.oninput=()=>renderBrandingPreview();
 if(brandingKey)loadBrandingKey(brandingKey.value);

  const wirePickList=(opts)=>{
    const {pickSelector,searchId,listId,newBtnId,deleteBtnId,onPick,onNew,onDelete,initialPick}=opts||{};
    document.querySelectorAll(pickSelector||'').forEach(btn=>btn.onclick=()=>{const name=btn.dataset.name||'';if(!name)return;onPick&&onPick(name)});
    const newBtn=document.getElementById(newBtnId||'');if(newBtn)newBtn.onclick=()=>{onNew&&onNew()};
    const delBtn=document.getElementById(deleteBtnId||'');if(delBtn)delBtn.onclick=()=>{onDelete&&onDelete()};
    const search=document.getElementById(searchId||'');const list=document.getElementById(listId||'');
    if(search&&list){search.oninput=()=>{const q=(search.value||'').trim().toLowerCase();Array.from(list.querySelectorAll('.list-btn')).forEach(it=>{const show=!q||it.textContent.toLowerCase().includes(q);it.style.display=show?'':'none'})};}
    if(initialPick) initialPick();
  };

  if(currentPath==='/commands/ticket-types'){
    wirePickList({
      pickSelector:'.ttPick',
      searchId:'typeSearch',
      listId:'typesList',
      newBtnId:'newTypeBtn',
      deleteBtnId:'deleteTypeBtn',
      onPick:(name)=>{ui.selectedType=name;saveUi();fillType(name);note('Editing ticket type: '+name,'')},
      onNew:()=>{ui.selectedType='';saveUi();if(document.getElementById('resetType'))document.getElementById('resetType').click();note('Creating new ticket type.','')},
      onDelete:async()=>{
        const name=String(ui.selectedType||'').trim();
        if(!name)return;
        if(!confirm('Delete ticket type \"'+name+'\"?'))return;
        try{await api('/api/ticket-type/delete',{method:'POST',body:JSON.stringify({name})});ui.selectedType='';saveUi();note('Ticket type deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedType){fillType(ui.selectedType)}}
    });
  }

  if(currentPath==='/commands/tag'){
    wirePickList({
      pickSelector:'.tagPick',
      searchId:'tagSearch',
      listId:'tagsList',
      newBtnId:'newTagBtn',
      deleteBtnId:'deleteTagBtn',
      onPick:(name)=>{ui.selectedTag=name;saveUi();fillTag(name);note('Editing tag: '+name,'')},
      onNew:()=>{ui.selectedTag='';saveUi();if(document.getElementById('resetTag'))document.getElementById('resetTag').click();note('Creating new tag.','')},
      onDelete:async()=>{
        const name=String(ui.selectedTag||'').trim();
        if(!name)return;
        if(!confirm('Delete tag \"'+name+'\"?'))return;
        try{await api('/api/tag/delete',{method:'POST',body:JSON.stringify({name})});ui.selectedTag='';saveUi();note('Tag deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedTag){fillTag(ui.selectedTag)}}
    });
  }

  if(currentPath==='/settings'){
    wirePickList({
      pickSelector:'.teamPick',
      searchId:'teamSearch',
      listId:'teamsList',
      newBtnId:'newTeamBtn',
      deleteBtnId:'deleteTeamBtn',
      onPick:(name)=>{ui.selectedTeam=name;saveUi();fillTeam(name);note('Editing team: '+name,'')},
      onNew:()=>{ui.selectedTeam='';saveUi();if(document.getElementById('resetTeam'))document.getElementById('resetTeam').click();note('Creating new team.','')},
      onDelete:async()=>{
        const name=String(ui.selectedTeam||'').trim();
        if(!name)return;
        if(!confirm('Delete support team \"'+name+'\"?'))return;
        try{await api('/api/support-team/delete',{method:'POST',body:JSON.stringify({name})});ui.selectedTeam='';saveUi();note('Support team deleted.','ok');await boot()}catch(e){note(e.message,'danger')}
      },
      initialPick:()=>{if(ui.selectedTeam){fillTeam(ui.selectedTeam)}}
    });
  }
wireRoleMultiSelect('ttRoles');
wireRoleMultiSelect('stRoles');
wireChannelSelect('feedbackId','Select feedback channel');
wireChannelSelect('feedbackConfigId','Select feedback channel');
wireCategorySelect('ttCategory','Use default ticket category');
const saveTag=document.getElementById('saveTag');if(saveTag)saveTag.onclick=async()=>{try{await api('/api/tag/upsert',{method:'POST',body:JSON.stringify({name:tagName.value.trim(),kind:tagKind.value,title:tagTitle.value.trim(),description:tagDesc.value,keywords:tagKeys.value})});ui.selectedTag=tagName.value.trim();saveUi();note('Tag saved.','ok');await boot()}catch(e){note(e.message,'danger')}};
const resetTag=document.getElementById('resetTag');if(resetTag)resetTag.onclick=()=>{['tagName','tagTitle','tagDesc','tagKeys'].forEach(id=>document.getElementById(id).value='');if(document.getElementById('tagKind'))document.getElementById('tagKind').value='suggestion'};
/* Dyno-style pick list handles tag selection/deletion */
  document.querySelectorAll('.availSelect').forEach(sel=>{sel.onchange=async()=>{try{await api('/api/availability',{method:'POST',body:JSON.stringify({ticketType:sel.dataset.name,status:sel.value})});note('Availability updated.','ok');await boot()}catch(e){note(e.message,'danger')}}});
 const staffLookupBtn=document.getElementById('staffLookupBtn');if(staffLookupBtn)staffLookupBtn.onclick=async()=>{try{const q=(document.getElementById('staffLookupQuery').value||'').trim();const r=await api('/api/staff/lookup',{method:'POST',body:JSON.stringify({query:q})});const box=document.getElementById('staffLookupResult');if(box){const tag=r.user&&r.user.tag?r.user.tag:('User '+esc(r.user.id));const mk=(label,val)=>'<div class="item"><div class="item-top"><strong>'+label+'</strong><span>'+val+'</span></div></div>';box.innerHTML=[mk('User',esc(tag)+' ('+esc(r.user.id)+')'),mk('Last 7d','Claimed '+(r.stats.days7.claimed||0)+' / Closed '+(r.stats.days7.closed||0)),mk('Last 14d','Claimed '+(r.stats.days14.claimed||0)+' / Closed '+(r.stats.days14.closed||0)),mk('Last 30d','Claimed '+(r.stats.days30.claimed||0)+' / Closed '+(r.stats.days30.closed||0))].join('')}note('Lookup complete.','ok')}catch(e){note(e.message,'danger')}};
 const staffLookupClear=document.getElementById('staffLookupClear');if(staffLookupClear)staffLookupClear.onclick=()=>{const q=document.getElementById('staffLookupQuery');const box=document.getElementById('staffLookupResult');if(q)q.value='';if(box)box.innerHTML='';note('', '')};
}
function renderOverview(){
 const totals=(state&&state.statistics&&state.statistics.totals)||{activeTickets:0,totalClaimed:0,totalClosed:0};
 const avail=Array.isArray(state&&state.availability)?state.availability:[];
 const reduced=avail.filter(a=>a&&a.status==='reduced_assistance').length;
 const limited=avail.filter(a=>a&&a.status==='increased_volume').length;
 const topReasons=Array.isArray(state&&state.statistics&&state.statistics.topCloseReasons)?state.statistics.topCloseReasons.slice(0,4):[];
 const tags=Array.isArray(state&&state.statistics&&state.statistics.tagUsage)?state.statistics.tagUsage.slice(0,6):[];
 const imgs=Array.isArray(state&&state.botConfig&&state.botConfig.homeImages)?state.botConfig.homeImages:[];
 const img0=esc(imgs[0]||''),img1=esc(imgs[1]||''),img2=esc(imgs[2]||'');
 const hour=(new Date()).getHours();
 const greet=hour<12?'Good morning':(hour<18?'Good afternoon':'Good evening');
 const isOwner=Boolean(state&&state.isOwner);
 const tutorialOn=Boolean(state&&state.guildConfigSummary&&state.guildConfigSummary.tutorialEnabled);
 const rolePermanent=!(state&&state.guildConfigSummary&&state.guildConfigSummary.rolePermanence===false);
 const pill=(n)=>'<span class="pill">'+Number(n||0)+'</span>';
 const preview=imgs.length
  ? ('<div class="row" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px">'+
     imgs.slice(0,3).map(u=>'<a href=\"'+esc(u)+'\" target=\"_blank\" rel=\"noreferrer\" style=\"display:block;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)\"><img src=\"'+esc(u)+'\" style=\"display:block;width:100%;height:92px;object-fit:cover\" loading=\"lazy\" /></a>').join('')+
    '</div>')
  : '';
 const imagesCard=isOwner
  ? ('<div class="card"><h3>Landing Page Images</h3><p class="muted">Paste image URLs to show on <strong>/</strong> (optional).</p>'+
     '<label>Image URL 1</label><input id="homeImg1" value="'+img0+'" placeholder="https://..." />'+
     '<label>Image URL 2</label><input id="homeImg2" value="'+img1+'" placeholder="https://..." />'+
     '<label>Image URL 3</label><input id="homeImg3" value="'+img2+'" placeholder="https://..." />'+
     '<div class="row" style="margin-top:10px"><button id="saveHomeImages" class="btn">Save Images</button><button id="clearHomeImages" class="btn-soft" type="button">Clear</button></div>'+
     preview+
    '</div>')
  : '';
 const tutorialCard=tutorialOn
  ? ('<div class="card"><h3>Quick Tutorial</h3><div class="list" style="margin-top:10px">'+
      '<div class="item"><div class="item-top"><strong>Openers</strong><span>'+(rolePermanent?'Role permanence on':'Role permanence off')+'</span></div><div class="muted">Post a panel, let users open tickets, then claim them to keep ownership clear.</div></div>'+
      '<div class="item"><div class="item-top"><strong>Replies</strong><span>Suggested flow</span></div><div class="muted">Use tags for common answers, update availability when queues rise, and close with transcripts.</div></div>'+
     '</div></div>')
  : '';

 return '<div class="grid">'+
  '<div class="card welcome"><p class="floaty">'+greet+', welcome to <span class="accent">Sync Development</span>.</p><p class="muted">Use the sidebar or dropdown to jump between sections.</p></div>'+

  '<div class="card"><h3>At a Glance</h3><div class="row" style="margin-top:10px">'+
   '<div class="item"><div class="muted">Active Tickets</div><div style="font-size:28px;font-weight:850;margin-top:2px">'+Number(totals.activeTickets||0)+'</div></div>'+
   '<div class="item"><div class="muted">Closed (14d)</div><div style="font-size:28px;font-weight:850;margin-top:2px">'+Number(totals.totalClosed||0)+'</div></div>'+
  '</div><div class="row" style="margin-top:10px">'+
   '<div class="item"><div class="muted">Limited Types</div><div style="font-size:28px;font-weight:850;margin-top:2px">'+limited+'</div></div>'+
   '<div class="item"><div class="muted">Reduced Types</div><div style="font-size:28px;font-weight:850;margin-top:2px">'+reduced+'</div></div>'+
  '</div></div>'+

  '<div class="card"><h3>Quick Actions</h3><p class="muted">Keep it simple: jump to common pages.</p>'+
   '<div class="row" style="grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">'+
    '<button type="button" class="btn-soft qa" data-go="/tickets">View Tickets</button>'+
    '<button type="button" class="btn-soft qa" data-go="/commands/ticket-types">Ticket Types</button>'+
   '</div>'+
   '<div class="row" style="grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">'+
    '<button type="button" class="btn-soft qa" data-go="/availability">Availability</button>'+
    '<button type="button" class="btn-soft qa" data-go="/embed-editor">Embed Editor</button>'+
   '</div>'+
  '</div>'+

  imagesCard+
  tutorialCard+

  '<div class="card"><h3>Top Close Reasons (30d)</h3><div class="list" style="margin-top:10px">'+
   (topReasons.length?topReasons.map(r=>'<div class="item"><div class="item-top"><strong>'+esc(r.reason||'Unknown')+'</strong>'+pill(r.count)+'</div></div>').join(''):'<div class="muted">No data yet.</div>')+
  '</div></div>'+

  '<div class="card"><h3>Popular Tags</h3><div class="list" style="margin-top:10px">'+
   (tags.length?tags.map(t=>'<div class="item"><div class="item-top"><strong>'+esc(t.name||'')+'</strong>'+pill(t.count)+'</div></div>').join(''):'<div class="muted">No tag usage yet.</div>')+
  '</div></div>'+
 '</div>'}
function render(){const access=(state&&state.access)||{};const allowed=new Set(['/documentation']);if(access.isOwner||access.canFullDashboard){['/overview','/settings','/availability','/commands/ticket-types','/commands/tag','/tickets','/transcripts','/commands/feedback','/statistics','/embed-editor'].forEach(p=>allowed.add(p))}else{if(access.canManageTicketTypes){allowed.add('/overview');allowed.add('/settings');allowed.add('/commands/ticket-types')}if(access.canManageAvailability)allowed.add('/availability');if(access.canViewTickets||access.canManageEscalations)allowed.add('/tickets');if(access.canViewTranscripts)allowed.add('/transcripts')}let html='';if(!allowed.has(currentPath)){html='<div class="card"><h3>Access Restricted</h3><p class="muted">This section is not available for your role in the selected server.</p></div>'}else if(currentPath==='/overview')html=renderOverview();else if(currentPath==='/settings')html=renderSettings();else if(currentPath==='/availability')html=renderAvailability();else if(currentPath==='/commands/ticket-types')html=renderTypes();else if(currentPath==='/commands/tag')html=renderTags();else if(currentPath==='/tickets')html=renderTickets();else if(currentPath==='/transcripts')html=renderTranscripts();else if(currentPath==='/commands/feedback')html=renderFeedback();else if(currentPath==='/commands/appeal')html=renderAppeal();else if(currentPath==='/statistics')html=renderStats();else if(currentPath==='/embed-editor')html=renderBranding();else html=renderDocs();app.classList.add('swap');requestAnimationFrame(()=>{app.innerHTML=html;requestAnimationFrame(()=>{app.classList.remove('swap');wire()})})}
async function boot(){state=await api('/api/state');render()}
document.getElementById('refreshStateBtn').onclick=async()=>{try{await boot();note('Dashboard refreshed.','ok')}catch(e){note(e.message,'danger')}};
document.getElementById('authLogin').onclick=async()=>{try{localStorage.setItem(tokenKey,authToken.value.trim());await api('/api/auth/login',{method:'POST',body:JSON.stringify({token:authToken.value.trim()})});auth.style.display='none';authMsg.textContent='';await boot()}catch(e){authMsg.textContent=e.message||'Login failed'}};
(function(){try{if(authDiscord)authDiscord.href='/login?next='+encodeURIComponent(location.pathname+location.search)}catch{}})();
(async()=>{try{await boot()}catch{auth.style.display='flex'}})();
</script></body></html>`;
}

function startDashboard(client) {
    if (!getDashboardEnabled()) {
        dashboardLog('Dashboard disabled via DASHBOARD_ENABLED=false.');
        return null;
    }

    if (dashboardServer) return dashboardServer;

    dashboardServer = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = url.pathname;

            const requestedGuildId = String(url.searchParams.get('guild') || '').trim();
            if (/^\d{17,20}$/.test(requestedGuildId) && isAuthed(req) && client?.guilds?.cache?.has(requestedGuildId)) {
                const userId = getDashboardSessionUserId(req);
                const ownerId = getBotOwnerId();
                const allowed = !userId || (ownerId && userId === ownerId) || getDashboardSessionGuildIds(req).includes(requestedGuildId);
                if (allowed) {
                    appendSetCookie(res, `dashboard_guild=${encodeURIComponent(requestedGuildId)}; ${cookieAttributes({
                        maxAge: 2592000,
                        secure: isHttpsPublicBaseUrl()
                    })}`);
                }
            }

            if (pathname.startsWith('/api/')) {
                const handled = await handleApi(req, res, url, client);
                if (!handled) sendJson(res, 404, { error: 'Not found' });
                return;
            }

            if (pathname.startsWith('/assets/')) {
                const rel = pathname.replace(/^\/assets\//, '');
                const resolved = path.resolve(ASSETS_DIR, rel);
                if (!resolved.startsWith(path.resolve(ASSETS_DIR))) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }

                const ext = path.extname(resolved).toLowerCase();
                const contentType = ext === '.svg'
                    ? 'image/svg+xml'
                    : ext === '.css'
                        ? 'text/css; charset=utf-8'
                        : ext === '.js'
                            ? 'text/javascript; charset=utf-8'
                    : ext === '.png'
                        ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                        ? 'image/jpeg'
                            : ext === '.webp'
                                ? 'image/webp'
                                : ext === '.ico'
                                    ? 'image/x-icon'
                                    : 'application/octet-stream';

                res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
                res.end(fs.readFileSync(resolved));
                return;
            }

            if (pathname === '/') {
                sendHtml(res, 200, createHomeHtml({ showOwnerGallery: isStrictOwnerViewer(req) }));
                return;
            }

            if (pathname === '/home') {
                sendHtml(res, 200, createHomeHtml({ showOwnerGallery: isStrictOwnerViewer(req) }));
                return;
            }

            if (pathname === '/controller') {
                if (hasDiscordOAuthConfigured() && !getDashboardSessionUserId(req)) {
                    const next = encodeURIComponent('/controller' + (url.search || ''));
                    res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                if (!isBotOwnerUser(req)) {
                    sendHtml(res, 403, '<h1>403</h1><p>Owner user only.</p>');
                    return;
                }
                sendHtml(res, 200, createControllerHtml());
                return;
            }

            if (pathname === '/dashboard') {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent('/dashboard' + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }
                sendHtml(res, 200, createServerPickerHtml());
                return;
            }

            if (pathname === '/setup') {
                if (!isAuthed(req)) {
                    if (hasDiscordOAuthConfigured()) {
                        const next = encodeURIComponent('/setup' + (url.search || ''));
                        res.writeHead(302, { Location: `/login?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }
                {
                    const access = await getDashboardAccess(client, req, requestedGuildId || getDashboardGuild(client, req)?.id || null);
                    const allowedPages = getAllowedDashboardPages(access);
                    if (!allowedPages.has('/setup')) {
                        sendHtml(res, 403, '<h1>403</h1><p>You do not have access to setup for this server.</p>');
                        return;
                    }
                }
                sendHtml(res, 200, createSetupHtml());
                return;
            }

            if (pathname === '/commands/appeal') {
                res.writeHead(302, { Location: '/commands/feedback' });
                res.end();
                return;
            }

            if (pathname === '/login') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1><p>Set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET.</p>');
                    return;
                }

                const redirectUri = `${getPublicBaseUrl()}/auth/dashboard/callback`;
                const next = safeDashboardNextPath(url.searchParams.get('next'));
                const state = randomToken(18);
                dashboardOauthStates.set(state, { next, createdAt: Date.now() });

                const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
                authorizeUrl.searchParams.set('client_id', getDiscordOAuthClientId());
                authorizeUrl.searchParams.set('redirect_uri', redirectUri);
                authorizeUrl.searchParams.set('response_type', 'code');
                authorizeUrl.searchParams.set('scope', 'identify guilds');
                authorizeUrl.searchParams.set('state', state);

                res.writeHead(302, { Location: authorizeUrl.toString(), 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/dashboard/callback') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1>');
                    return;
                }

                const code = String(url.searchParams.get('code') || '').trim();
                const state = String(url.searchParams.get('state') || '').trim();
                const saved = dashboardOauthStates.get(state);
                dashboardOauthStates.delete(state);
                const next = safeDashboardNextPath(saved?.next);

                if (!code || !state || !saved) {
                    sendHtml(res, 400, '<h1>Invalid OAuth callback</h1><p>Try signing in again.</p>');
                    return;
                }

                try {
                    const redirectUri = `${getPublicBaseUrl()}/auth/dashboard/callback`;
                    const body = new URLSearchParams();
                    body.set('client_id', getDiscordOAuthClientId());
                    body.set('client_secret', getDiscordOAuthClientSecret());
                    body.set('grant_type', 'authorization_code');
                    body.set('code', code);
                    body.set('redirect_uri', redirectUri);

                    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body
                    });

                    const tokenJson = await tokenRes.json().catch(() => ({}));
                    if (!tokenRes.ok) {
                        throw new Error(String(tokenJson?.error_description || tokenJson?.error || 'OAuth token exchange failed.'));
                    }

                    const accessToken = String(tokenJson.access_token || '').trim();
                    if (!accessToken) {
                        throw new Error('No access token returned from Discord.');
                    }

                    const userRes = await fetch('https://discord.com/api/users/@me', {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    const userJson = await userRes.json().catch(() => ({}));
                    if (!userRes.ok) {
                        throw new Error('Unable to fetch Discord user.');
                    }

                    const userId = String(userJson?.id || '').trim();
                    if (!/^\d{17,20}$/.test(userId)) {
                        throw new Error('Invalid Discord user id.');
                    }

                    const ownerId = getBotOwnerId();
                    let manageableGuildIds = [];
                    let oauthGuilds = [];

                    // Owner gets global access automatically.
                    if (ownerId && userId === ownerId) {
                        manageableGuildIds = [...client.guilds.cache.keys()];
                    } else {
                        const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        });
                        const guildsJson = await guildsRes.json().catch(() => ([]));
                        if (!guildsRes.ok || !Array.isArray(guildsJson)) {
                            throw new Error('Unable to fetch guild list (OAuth scope "guilds" required).');
                        }

                        for (const g of guildsJson) {
                            const id = String(g?.id || '').trim();
                            if (!/^\d{17,20}$/.test(id)) continue;
                            oauthGuilds.push({
                                id,
                                name: String(g?.name || '').trim(),
                                icon: String(g?.icon || '').trim() || null,
                                owner: Boolean(g?.owner),
                                permissions: String(g?.permissions || '0').trim() || '0'
                            });
                            if (!client.guilds.cache.has(id)) continue; // only guilds this bot is in
                            manageableGuildIds.push(id);
                        }
                        manageableGuildIds = [...new Set(manageableGuildIds)];
                    }

                    setDashboardSession(res, userId, manageableGuildIds, oauthGuilds);
                    res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                } catch (error) {
                    console.error('[Dashboard] OAuth error:', error);
                    sendHtml(res, 500, `<h1>OAuth Error</h1><p>${String(error?.message || error)}</p>`);
                    return;
                }
            }

            if (pathname === '/logout') {
                clearDashboardSession(res);
                res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/discord') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1><p>Set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET.</p>');
                    return;
                }

                const redirectUri = `${getPublicBaseUrl()}/auth/discord/callback`;
                const next = safeNextPath(url.searchParams.get('next'));
                const state = randomToken(18);
                transcriptOauthStates.set(state, { next, createdAt: Date.now() });

                const authorizeUrl = new URL('https://discord.com/api/oauth2/authorize');
                authorizeUrl.searchParams.set('client_id', getDiscordOAuthClientId());
                authorizeUrl.searchParams.set('redirect_uri', redirectUri);
                authorizeUrl.searchParams.set('response_type', 'code');
                authorizeUrl.searchParams.set('scope', 'identify');
                authorizeUrl.searchParams.set('state', state);

                res.writeHead(302, { Location: authorizeUrl.toString(), 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/auth/discord/callback') {
                if (!hasDiscordOAuthConfigured()) {
                    sendHtml(res, 500, '<h1>OAuth not configured</h1>');
                    return;
                }

                const code = String(url.searchParams.get('code') || '').trim();
                const state = String(url.searchParams.get('state') || '').trim();
                const saved = transcriptOauthStates.get(state);
                transcriptOauthStates.delete(state);
                const next = safeNextPath(saved?.next);

                if (!code || !state || !saved) {
                    sendHtml(res, 400, '<h1>Invalid OAuth callback</h1><p>Try opening the transcript link again.</p>');
                    return;
                }

                try {
                    const redirectUri = `${getPublicBaseUrl()}/auth/discord/callback`;
                    const body = new URLSearchParams();
                    body.set('client_id', getDiscordOAuthClientId());
                    body.set('client_secret', getDiscordOAuthClientSecret());
                    body.set('grant_type', 'authorization_code');
                    body.set('code', code);
                    body.set('redirect_uri', redirectUri);

                    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body
                    });

                    const tokenJson = await tokenRes.json().catch(() => ({}));
                    if (!tokenRes.ok) {
                        throw new Error(String(tokenJson?.error_description || tokenJson?.error || 'OAuth token exchange failed.'));
                    }

                    const accessToken = String(tokenJson.access_token || '').trim();
                    if (!accessToken) {
                        throw new Error('No access token returned from Discord.');
                    }

                    const userRes = await fetch('https://discord.com/api/users/@me', {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    const userJson = await userRes.json().catch(() => ({}));
                    if (!userRes.ok) {
                        throw new Error('Unable to fetch Discord user.');
                    }

                    const userId = String(userJson?.id || '').trim();
                    if (!/^\d{17,20}$/.test(userId)) {
                        throw new Error('Invalid Discord user id.');
                    }

                    setTranscriptSession(res, userId);
                    res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                } catch (error) {
                    console.error('[Dashboard] OAuth error:', error);
                    sendHtml(res, 500, `<h1>OAuth Error</h1><p>${String(error?.message || error)}</p>`);
                    return;
                }
            }

            if (pathname === '/auth/logout') {
                clearTranscriptSession(res);
                res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }

            if (pathname === '/t/' || pathname === '/t') {
                sendHtml(res, 404, '<h1>404</h1>');
                return;
            }

            if (pathname.startsWith('/t/')) {
                const token = String(pathname.slice('/t/'.length) || '').trim();
                if (!token || token.includes('/')) {
                    sendHtml(res, 404, '<h1>404</h1>');
                    return;
                }

                const activeStorage = ticketStore.getActiveStorage();
                const archives = Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : [];
                const entry = archives.find(a => a && String(a.publicToken || '') === token) || null;

                if (!entry) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const oauthConfigured = hasDiscordOAuthConfigured();
                const oauthRequired = isTranscriptOAuthRequired();
                const userId = getTranscriptSessionUserId(req);

                if (oauthRequired && !oauthConfigured) {
                    sendHtml(res, 503, '<h1>Transcript Viewer Not Configured</h1><p>Admin: set DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_CLIENT_SECRET (or set TRANSCRIPT_REQUIRE_OAUTH=false to allow link-only access).</p>');
                    return;
                }

                if (oauthConfigured) {
                    if (!userId) {
                        const next = encodeURIComponent(pathname + (url.search || ''));
                        res.writeHead(302, { Location: `/auth/discord?next=${next}`, 'Cache-Control': 'no-store' });
                        res.end();
                        return;
                    }

                    const allowed = Array.isArray(entry.allowedUserIds) ? entry.allowedUserIds.map(String) : [];
                    if (allowed.length && !allowed.includes(String(userId))) {
                        sendHtml(res, 403, '<h1>403</h1><p>You are not allowed to view this transcript.</p>');
                        return;
                    }
                }

                const channelId = String(entry.channelId || '').trim();
                const fileName = String(entry.fileName || `${channelId}.html`);
                const filePath = resolveTranscriptPath(channelId, fileName);

                if (!fs.existsSync(filePath)) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const downloadRaw = String(url.searchParams.get('download') || url.searchParams.get('dl') || '').toLowerCase();
                const wantsDownload = downloadRaw === '1' || downloadRaw === 'true' || url.searchParams.has('download');
                const headers = {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Robots-Tag': 'noindex, nofollow'
                };
                if (wantsDownload) headers['Content-Disposition'] = `attachment; filename="${channelId}.html"`;
                res.writeHead(200, headers);
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            if (pathname === '/transcripts/') {
                res.writeHead(302, { Location: '/transcripts' });
                res.end();
                return;
            }

            if (pathname.startsWith('/transcripts/')) {
                if (!isAuthed(req)) {
                    sendHtml(res, 401, '<h1>401</h1><p>Unauthorized</p>');
                    return;
                }

                const id = String(pathname.slice('/transcripts/'.length) || '').trim();
                if (!/^\d{17,20}$/.test(id)) {
                    sendHtml(res, 404, '<h1>404</h1>');
                    return;
                }

                const activeStorage = ticketStore.getActiveStorage();
                const archives = Array.isArray(activeStorage.transcriptArchives) ? activeStorage.transcriptArchives : [];
                const entry = archives.find(a => a && String(a.channelId) === id) || null;
                const fileName = String(entry?.fileName || `${id}.html`);
                const filePath = resolveTranscriptPath(id, fileName);

                if (!fs.existsSync(filePath)) {
                    sendHtml(res, 404, '<h1>404</h1><p>Transcript not found.</p>');
                    return;
                }

                const downloadRaw = String(url.searchParams.get('download') || url.searchParams.get('dl') || '').toLowerCase();
                const wantsDownload = downloadRaw === '1' || downloadRaw === 'true' || url.searchParams.has('download');
                const headers = {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                };
                if (wantsDownload) headers['Content-Disposition'] = `attachment; filename="${id}.html"`;
                res.writeHead(200, headers);
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            const pages = new Set(['/overview', '/settings', '/availability', '/commands/ticket-types', '/commands/tag', '/tickets', '/transcripts', '/commands/feedback', '/statistics', '/embed-editor', '/documentation']);
            if (pages.has(pathname)) {
                const access = await getDashboardAccess(client, req, requestedGuildId || getDashboardGuild(client, req)?.id || null);
                const allowedPages = getAllowedDashboardPages(access);
                if (!allowedPages.has(pathname)) {
                    sendHtml(res, 403, '<h1>403</h1><p>You do not have access to this page.</p>');
                    return;
                }
                sendHtml(res, 200, createUiHtml(pathname));
                return;
            }

            sendHtml(res, 404, '<h1>404</h1>');
        } catch (error) {
            console.error('[Dashboard] Request error:', error);
            if (!res.writableEnded) sendJson(res, 500, { error: 'Internal server error' });
        }
    });

    const portConfigured = isDashboardPortConfigured();
    const startingPort = getDashboardPort();
    let port = startingPort;
    const host = getDashboardHost();
    const attempted = new Set();

    const tryListen = nextPort => {
        attempted.add(nextPort);
        port = nextPort;
        dashboardServer.listen(nextPort, host, () => {
            const displayHost = host === '0.0.0.0' ? '<your-computer-ip>' : host;
            dashboardLog(`Running at http://${displayHost}:${nextPort} (bound to ${host})`);
        });
    };

    dashboardServer.on('error', error => {
        const code = error && typeof error === 'object' ? error.code : null;
        if (code === 'EADDRINUSE') {
            if (!portConfigured) {
                const upper = startingPort + 15;
                let next = null;
                for (let p = startingPort; p <= upper; p += 1) {
                    if (!attempted.has(p)) { next = p; break; }
                }
                if (next !== null) {
                    dashboardLog(`Port ${port} is in use; trying ${next}...`);
                    tryListen(next);
                    return;
                }
            }

            dashboardLog(`Port ${port} is already in use; dashboard will not start. Set DASHBOARD_PORT or stop the other process.`);
        } else {
            console.error('[Dashboard] Server error:', error);
        }

        try { dashboardServer?.close?.(); } catch {}
        dashboardServer = null;
    });

    tryListen(port);
    return dashboardServer;
}

module.exports = { startDashboard };
