# Hytale OpenID Connect

HStats uses Hytale's confidential Authorization Code flow with PKCE. The client secret is used only by the backend and must never be exposed to the frontend.

## Hytale client redirect URIs

Register these redirect URIs in the Hytale developer portal:

- Production: `https://api.hstats.dev/api/account/oauth/hytale/callback`
- Local development: `http://localhost:3000/api/account/oauth/hytale/callback`

The Discord callback paths are not valid for the Hytale flow because HStats has separate provider-specific callbacks.

## Environment

```env
HYTALE_OAUTH_CLIENT_ID=...
HYTALE_OAUTH_SECRET=...
HYTALE_OAUTH_REDIRECT_URI=http://localhost:3000/api/account/oauth/hytale/callback
OAUTH_FRONTEND_ORIGIN=http://localhost:5173
```

Production should use:

```env
HYTALE_OAUTH_REDIRECT_URI=https://api.hstats.dev/api/account/oauth/hytale/callback
OAUTH_FRONTEND_ORIGIN=https://hstats.dev
```

If `HYTALE_OAUTH_REDIRECT_URI` is omitted, the backend derives it from the incoming request host and the `/api/account/oauth/hytale/callback` route. Setting it explicitly is recommended in production so proxies cannot affect the value.

## Security behavior

- Requests only `openid hytale:profile`.
- Generates a fresh state, nonce, and S256 PKCE verifier for each login.
- Stores the temporary OAuth values in the server-side session for five minutes.
- Authenticates the token request with HTTP Basic (`client_secret_basic`).
- Validates the RS256 ID token against Hytale's remote JWKS.
- Checks issuer, audience, expiry, required claims, and nonce.
- Fetches UserInfo and requires its subject to match the validated ID token.
- HMAC-hashes Hytale's application-specific `sub` before database storage.
- Stores the selected public profile UUID and username for account display and refreshes them on later logins.
- Regenerates the HStats session after successful OAuth authentication.

Hytale does not return an email address. A new Hytale login therefore creates a separate HStats account unless the user first signs in to an existing HStats account and connects Hytale from the dashboard.
