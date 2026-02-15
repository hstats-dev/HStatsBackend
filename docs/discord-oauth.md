# Discord OAuth Login

## Overview
Discord OAuth is now wired into the existing session auth system.

- Session cookie is still the source of auth (`req.session.accountId`).
- Email/password login still works.
- Discord login can:
  - sign in an already-linked account,
  - auto-link to an existing email account (only when Discord email is verified),
  - create a new Discord-based account.

## Endpoints

### Start OAuth
`GET /api/account/oauth/discord/start`

Optional query params:

- `return_to`: frontend path to redirect to after callback (must start with `/`, example: `/auth/discord-complete`)
- `mode=json`: returns JSON instead of redirecting immediately

Default behavior:

- Generates CSRF `state` and stores it in the user session.
- Redirects browser to Discord authorize URL.

JSON mode response:

```json
{
  "authorization_url": "https://discord.com/oauth2/authorize?..."
}
```

### OAuth Callback
`GET /api/account/oauth/discord/callback`

Behavior:

- Validates `state` and expiry.
- Exchanges `code` with Discord.
- Fetches `users/@me`.
- Resolves account (linked account, email-linked account, or new account).
- Sets session cookie (`accountId`).
- Redirects back to frontend with query params:
  - `oauth_provider=discord`
  - `oauth_status=success|error`
  - `oauth_error=<code>` when status is `error`

## Frontend Flow

1. Send user to `/api/account/oauth/discord/start?return_to=/your-finish-route`.
2. Backend handles Discord login and redirects back to your frontend path.
3. On frontend finish route:
   - read `oauth_status` / `oauth_error`,
   - call `GET /api/account/me` with credentials to load account.

Fetch example:

```js
await fetch("http://localhost:3000/api/account/me", {
  method: "GET",
  credentials: "include"
});
```

## Account Matching Rules

1. If `discord_id` already linked: log into that account.
2. Else if Discord email is verified and matches existing email account: link Discord to that account and log in.
3. Else: create a new account with Discord identity.

## Account Payload Changes

`/api/account/me` now includes:

- `discord_connected` (boolean)
- `discord_username` (string)

## Required Backend Env

Required:

- `DISCORD_OAUTH_CLIENT_ID`
- `DISCORD_OAUTH_CLIENT_SECRET`

Optional but recommended:

- `DISCORD_OAUTH_REDIRECT_URI`
  - If omitted, backend auto-builds it from incoming host:
    `/api/account/oauth/discord/callback`
- `DISCORD_OAUTH_FRONTEND_ORIGIN`
  - Defaults:
    - production: `https://hstats.dev`
    - dev: `http://localhost:5173`

## Discord Developer Portal Setup

In your Discord application OAuth2 settings, add redirect URL(s) that match backend callback exactly, for example:

- `http://localhost:3000/api/account/oauth/discord/callback`
- `https://<your-api-domain>/api/account/oauth/discord/callback`
