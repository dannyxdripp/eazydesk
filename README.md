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

Owner Console -> Custom branded bot lets you save the bot name, avatar, application id, public key, token, and status text. After a token is saved on a Custom plan server, Controller shows an on/off switch for that branded bot. The switch will not turn on until a token is saved.
