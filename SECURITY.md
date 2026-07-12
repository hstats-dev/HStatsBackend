# Security Policy

## Reporting Vulnerabilities

If you discover a security issue in HStats Backend, please do not open a public GitHub issue with exploit details.

Report the issue privately through one of the project maintainer contact methods listed on the HStats.dev organization or project page.

Include:

- A clear description of the issue.
- Steps to reproduce, if safe to share.
- Affected endpoint, file, or feature.
- Potential impact.
- Any suggested fix, if known.

## Sensitive Data

Never commit or share:

- `.env`
- SQLite database files.
- Discord bot tokens.
- Discord webhook URLs.
- OAuth client secrets.
- reCAPTCHA secrets.
- account encryption keys.
- session secrets.

## Supported Security Expectations

The backend is intended to protect:

- Account sessions.
- Account email data.
- Private plugin reporting UUIDs.
- Admin-only Discord commands.
- Server ingest endpoints from obvious spam and spoofing attempts.

The backend does not treat public plugin UUIDs, public developer UUIDs, public stats, or SVG embed URLs as secret.

## Deployment Checklist

Before production deployment:

- Set a strong `SESSION_SECRET`.
- Set unique `ACCOUNT_DATA_KEY` and `ACCOUNT_DATA_HMAC_KEY` values.
- Set a strong `ACCOUNT_PASSWORD_PEPPER`.
- Keep `.env` outside version control.
- Keep all SQLite database files outside version control.
- Use HTTPS in production.
- Set `PRODUCTION=true`.
- Rotate leaked private plugin UUIDs from the dashboard or admin tooling.
- Rotate Discord webhooks and bot tokens if they are ever exposed.
- Rotate the Hytale OAuth client secret if it is ever exposed.

## Git History

If sensitive files were ever committed, removing them from the current tree is not enough. Purge them from Git history and rotate any affected secrets.
