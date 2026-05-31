# eazydesk

Discord ticket bot with a web dashboard for setup, ticket types, panels, transcripts, staff tools, and branded custom bot controls.

## Run

```bash
npm install
npm start
```

`megajs` is included for JSON backup support. Configure MEGA credentials with the existing environment variables used by `src/utils/mega-backup.js`.

## Ticket Channel Formats

Each ticket type can set a channel name format in Dashboard -> Ticket Types.

Supported placeholders:

- `{number}` / `{ticketNumber}` / `{id}` - per-server ticket counter.
- `{userId}` / `{user}` - Discord user id.
- `{username}` - requester's username.
- `{displayName}` - requester's display/global name.
- `{priority}` - `normal`, `limited`, `reduced`, or `urgent`.
- `{type}` / `{ticketType}` - ticket type name.
- `{suffix}` - short unique fallback id.

Useful presets:

- `ticket-{number}` -> `ticket-1`, `ticket-2`
- `ticket-{userId}` -> `ticket-123456789012345678`
- `{priority}-ticket-{number}` -> `urgent-ticket-12`
- `{type}-{number}` -> `general-support-12`
- `{username}-{suffix}` -> `alex-k9q2`

## Transcripts

Closing a ticket now stores the HTML transcript, records it in the transcript archive, posts a `/t/<token>` view link to the transcript channel, and DMs the ticket creator both the link and an HTML attachment when DMs are open.

Set `PUBLIC_BASE_URL` to your deployed dashboard URL so transcript links point to the right host. Optional OAuth protection is controlled by the existing Discord OAuth transcript settings.

## Custom Branded Bot Control

Custom bots are created in the Discord Developer Portal first. Create the application/bot there, invite it to the target server, then save the application id, public key, token, display name, avatar URL, and status text in Owner Console -> Custom branded bot.

When a Custom plan server has a saved token, Controller shows an on/off switch and a command sync button. Turning it on starts the branded bot runtime, deploys the same slash commands globally and directly to the target guild, checks that the bot is invited to the target server, and records `runtimeStatus`, `lastStartedAt`, `lastCommandSyncAt`, or `lastError` in storage. The first successful startup DMs the server owner a short boot-log animation. Custom bot online, stopped, and error events are also sent to the monitoring webhook (`MONITORING_WEBHOOK_URL`, `DATA_LOSS_WEBHOOK_URL`, or `BOT_MONITORING_WEBHOOK_URL`).

Make sure the branded bot invite includes the `bot` and `applications.commands` scopes. Name, avatar, and profile settings are handled in the Discord Developer Portal, not the dashboard.
