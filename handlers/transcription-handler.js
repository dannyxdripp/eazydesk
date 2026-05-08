const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { buildV2Notice } = require('../utils/components-v2-messages');
const { getTranscriptsDir, ensureDir } = require('../utils/storage-paths');
const { resolveTranscriptsChannelId } = require('../utils/guild-defaults');

const TRANSCRIPTS_DIR = getTranscriptsDir();

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTimestamp(date) {
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { hour12: false });
}

function renderMessageContent(message) {
    const lines = [];
    if (message.content) lines.push(`<div class="content">${escapeHtml(message.content)}</div>`);

    if (message.attachments?.size) {
        for (const attachment of message.attachments.values()) {
            const fileName = escapeHtml(attachment.name || 'attachment');
            const url = escapeHtml(attachment.url);
            const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(attachment.name || attachment.url || ''));
            lines.push(`<div class="attachment"><a href="${url}" target="_blank" rel="noopener noreferrer">${fileName}</a>${isImage ? `<img class="attachment-image" src="${url}" alt="${fileName}" loading="lazy" />` : ''}</div>`);
        }
    }

    if (message.embeds?.length) {
        for (const embed of message.embeds) {
            const title = escapeHtml(embed.title || 'Embed');
            const desc = escapeHtml(embed.description || '');
            lines.push(`<div class="embed"><strong>${title}</strong>${desc ? `<div>${desc}</div>` : ''}</div>`);
        }
    }

    if (!lines.length) lines.push('<div class="content"><em>[No text content]</em></div>');
    return lines.join('');
}

function renderMessages(messages) {
    return messages.map(message => {
        const authorName = escapeHtml(message.author?.tag || 'Unknown User');
        const avatar = escapeHtml(message.author?.displayAvatarURL?.({ extension: 'png', size: 64 }) || '');
        const timestamp = escapeHtml(formatTimestamp(message.createdAt));
        return `
            <article class="message">
                <img class="avatar" src="${avatar}" alt="avatar" />
                <div class="body">
                    <header>
                        <span class="author">${authorName}</span>
                        <time>${timestamp}</time>
                    </header>
                    ${renderMessageContent(message)}
                </div>
            </article>
        `;
    }).join('\n');
}

function buildTranscriptHtml(channel, messages) {
    const channelName = escapeHtml(channel.name);
    const guildName = escapeHtml(channel.guild?.name || 'Unknown Server');
    const generatedAt = escapeHtml(formatTimestamp(new Date()));
    const messageCount = messages.length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Transcript #${channelName}</title>
    <style>
        :root {
            --bg: #1f2125;
            --bg-elevated: #2b2d31;
            --panel: rgba(49, 51, 56, 0.96);
            --panel-strong: #232428;
            --text: #f2f3f5;
            --muted: #aeb4bd;
            --link: #59b8ff;
            --embed: #1b1d21;
            --border: rgba(255,255,255,.08);
            --accent: #5865f2;
            --shadow: 0 20px 60px rgba(0,0,0,.35);
        }
        body[data-theme="midnight"]{
            --bg:#111318;
            --bg-elevated:#171a20;
            --panel:rgba(24,26,32,.96);
            --panel-strong:#14171c;
            --text:#f5f7fb;
            --muted:#98a1ad;
            --border:rgba(255,255,255,.07);
            --link:#7ac7ff;
            --accent:#6b7cff;
        }
        body[data-theme="slate"]{
            --bg:#eef2f7;
            --bg-elevated:#ffffff;
            --panel:rgba(255,255,255,.96);
            --panel-strong:#f7f9fc;
            --text:#182230;
            --muted:#637083;
            --border:rgba(24,34,48,.10);
            --link:#2563eb;
            --embed:#f4f7fb;
            --accent:#4f46e5;
            --shadow:0 18px 48px rgba(15,23,42,.12);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background: var(--bg);
            color: var(--text);
            font: 14px/1.4 "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
            transition: background .25s ease, color .25s ease;
        }
        .wrap {
            max-width: 1100px;
            margin: 0 auto;
            padding: 20px;
        }
        .top {
            position: sticky;
            top: 0;
            z-index: 10;
            background: color-mix(in srgb, var(--panel) 88%, transparent);
            border-bottom: 1px solid var(--border);
            padding: 14px 20px;
            backdrop-filter: blur(18px);
            box-shadow: 0 8px 28px rgba(0,0,0,.14);
        }
        .top-inner {
            max-width: 1100px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: center;
            flex-wrap: wrap;
        }
        .brand {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        .brand-mark {
            width: 42px;
            height: 42px;
            border-radius: 14px;
            object-fit: cover;
            box-shadow: var(--shadow);
        }
        .title {
            font-size: 16px;
            font-weight: 800;
            margin: 0;
        }
        .meta {
            margin-top: 4px;
            color: var(--muted);
            font-size: 12px;
        }
        .toolbar {
            display:flex;
            gap:10px;
            align-items:center;
            flex-wrap:wrap;
        }
        .toolbar select,.toolbar button{
            border:1px solid var(--border);
            background:var(--panel-strong);
            color:var(--text);
            border-radius:12px;
            padding:10px 12px;
            font:inherit;
        }
        .hero {
            margin: 10px 0 18px;
            padding: 18px;
            border: 1px solid var(--border);
            border-radius: 20px;
            background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 94%, transparent), color-mix(in srgb, var(--panel-strong) 98%, transparent));
            box-shadow: var(--shadow);
        }
        .messages { display:grid; gap: 2px; }
        .message {
            display: grid;
            grid-template-columns: 40px 1fr;
            gap: 12px;
            padding: 10px 12px;
            border-radius: 14px;
            transition: background .16s ease, transform .16s ease;
        }
        .message:hover { background: color-mix(in srgb, var(--panel-strong) 70%, transparent); transform: translateY(-1px); }
        .avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--panel-strong);
        }
        header {
            display: flex;
            align-items: baseline;
            gap: 8px;
            flex-wrap: wrap;
        }
        .author { font-weight: 600; }
        time {
            color: var(--muted);
            font-size: 12px;
        }
        .content {
            white-space: pre-wrap;
            word-break: break-word;
            margin-top: 2px;
        }
        .attachment { margin-top: 6px; }
        .attachment-image {
            display:block;
            max-width: min(440px, 100%);
            margin-top: 10px;
            border-radius: 14px;
            border: 1px solid var(--border);
            box-shadow: var(--shadow);
        }
        .attachment a, a {
            color: var(--link);
            text-decoration: none;
        }
        .attachment a:hover, a:hover { text-decoration: underline; }
        .embed {
            margin-top: 8px;
            border-left: 4px solid var(--accent);
            background: var(--embed);
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid var(--border);
        }
        .empty {
            padding: 24px;
            color: var(--muted);
            text-align: center;
            border: 1px dashed var(--border);
            border-radius: 16px;
            background: color-mix(in srgb, var(--panel-strong) 72%, transparent);
        }
        .count-pill {
            display:inline-flex;
            align-items:center;
            gap:8px;
            padding:6px 10px;
            border-radius:999px;
            border:1px solid var(--border);
            background:var(--panel-strong);
            color:var(--muted);
            font-size:12px;
        }
        @media (max-width: 720px) {
            .wrap { padding: 14px; }
            .top { padding: 12px 14px; }
            .message { grid-template-columns: 34px 1fr; gap: 10px; padding: 10px 8px; }
            .avatar { width: 34px; height: 34px; }
        }
    </style>
</head>
<body data-theme="discord">
    <div class="top">
        <div class="top-inner">
            <div class="brand">
                <img class="brand-mark" src="/assets/sync.png" alt="Sync" onerror="this.style.display='none'" />
                <div>
                    <h1 class="title">${guildName} &bull; #${channelName}</h1>
                    <div class="meta">Generated ${generatedAt}</div>
                </div>
            </div>
            <div class="toolbar">
                <span class="count-pill">${messageCount} messages</span>
                <select id="themeSelect" aria-label="Theme">
                    <option value="discord">Discord</option>
                    <option value="midnight">Midnight</option>
                    <option value="slate">Slate</option>
                </select>
            </div>
        </div>
    </div>
    <main class="wrap">
        <section class="hero">
            <div class="meta">Transcript archive</div>
            <div style="font-size:15px;margin-top:6px">This view mirrors a Discord-style conversation with a calmer archival layout and a built-in theme switcher.</div>
        </section>
        <section class="messages">
            ${messageCount ? renderMessages(messages) : '<div class="empty">No messages found in this ticket.</div>'}
        </section>
    </main>
    <script>
        const key='sync_transcript_theme';
        const select=document.getElementById('themeSelect');
        const saved=(()=>{try{return localStorage.getItem(key)||'discord'}catch{return 'discord'}})();
        document.body.dataset.theme=saved;
        if(select){select.value=saved;select.onchange=()=>{document.body.dataset.theme=select.value;try{localStorage.setItem(key,select.value)}catch{}}}
    </script>
</body>
</html>`;
}

module.exports = {
    async createTranscript(channel, options = {}) {
        try {
            ensureDir(TRANSCRIPTS_DIR);

            const allMessages = [];
            const participantUserIds = new Set();
            let lastId = null;
            while (true) {
                const batch = await channel.messages.fetch({ limit: 100, before: lastId || undefined });
                if (!batch.size) break;
                for (const message of batch.values()) {
                    allMessages.push(message);
                    const authorId = message?.author?.id;
                    if (authorId && !message?.author?.bot) participantUserIds.add(String(authorId));
                }
                lastId = batch.last().id;
                if (batch.size < 100) break;
            }

            allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            const transcriptPath = path.join(TRANSCRIPTS_DIR, `${channel.id}.html`);
            const htmlContent = buildTranscriptHtml(channel, allMessages);
            fs.writeFileSync(transcriptPath, htmlContent, 'utf-8');

            if (options && options.includeParticipants) {
                return { transcriptPath, participantUserIds: [...participantUserIds] };
            }

            return transcriptPath;
        } catch (error) {
            console.error('Error creating transcript:', error);
            throw error;
        }
    },

    async sendTranscript(channel, transcriptPath, options = {}) {
        try {
            const keepFile = options.keepFile !== false;
            const transcriptsChannelId = resolveTranscriptsChannelId(channel.guild?.id);
            if (!transcriptsChannelId) {
                throw new Error('No transcripts channel is configured for this server.');
            }
            const transcriptsChannel = await channel.guild.channels.fetch(transcriptsChannelId);

            if (!transcriptsChannel) {
                throw new Error('Transcripts channel not found.');
            }

            const fileName = `${channel.id}.html`;
            const file = new AttachmentBuilder(transcriptPath, { name: fileName });
            const base = buildV2Notice('Ticket Transcript', `Transcript for \`${channel.name}\`\n\n**Channel ID:** \`${channel.id}\``, 0x5865F2);

            await transcriptsChannel.send({
                ...base,
                flags: MessageFlags.IsComponentsV2,
                files: [file],
                components: [
                    ...base.components,
                    {
                        type: 13,
                        file: { url: `attachment://${fileName}` }
                    }
                ]
            });
            if (!keepFile) fs.unlinkSync(transcriptPath);
        } catch (error) {
            console.error('Error sending transcript:', error);
            throw error;
        }
    }
};
