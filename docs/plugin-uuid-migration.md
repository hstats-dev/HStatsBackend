# Plugin UUID Migration (Public + Private UUIDs)

## Purpose
Plugins now use two UUIDs:

- `public_uuid`: safe for URLs, public API responses, embeds, and frontend routing.
- `private_uuid`: sensitive identifier used for server ingest/reporting and private developer tooling.

This change prevents third parties from using a public plugin identifier to spoof ingest traffic.

## High-Level Summary

## What changed
- Plugin records now include `public_uuid`.
- Existing plugins are auto-migrated: each gets a generated unique `public_uuid`.
- Public-facing plugin APIs now resolve by `public_uuid`.
- Public responses now return public UUIDs.
- Private UUIDs are returned only in authenticated developer contexts where needed.

## What stayed the same
- Internal stats/history storage still keys by private plugin UUID.
- Server ingest endpoints still require a plugin UUID in payload, but this must be the private UUID.
- Existing analytics logic and charts are otherwise unchanged.
- Plugin names, counts, ownership, and ranking behavior are unchanged.

## Database / Backend Model Changes
- `plugins` table now has `public_uuid`.
- Startup migration behavior:
  - adds `public_uuid` column if missing.
  - backfills invalid/missing/duplicate values.
  - enforces uniqueness via index on `public_uuid`.

Internal helper behavior now supports:
- lookup by private UUID.
- lookup by public UUID.
- mapping DB rows to public-facing shape.

## API Contract Changes

## 1) Create Plugin
Route: `POST /api/plugin/add-plugin` (authenticated)

### Before
Returned one UUID:
- `plugin_uuid` (this was also used for ingest and public pages)

### Now
Returns both:
- `plugin_uuid`: public UUID (use for frontend/public)
- `private_plugin_uuid`: private UUID (use for server reporting only)

Example:
```json
{
  "plugin_uuid": "PUBLIC_UUID",
  "private_plugin_uuid": "PRIVATE_UUID"
}
```

## 2) List Plugins
Route: `GET /api/plugin/list-plugins`

### Before
Plugin identifiers in output were private UUIDs.

### Now
All plugin identifiers in response are public UUIDs:
- object keys in `plugins`
- `plugin_info.uuid`
- co-plugin UUIDs (where applicable)

Everything else (sorting, counts, stats payload shape) remains the same.

## 3) Plugin Info
Route: `GET /api/plugin/plugin-info/:plugin_uuid`

### Before
`:plugin_uuid` expected private UUID.

### Now
`:plugin_uuid` expects public UUID.

Response now includes top-level public UUID:
```json
{
  "uuid": "PUBLIC_UUID",
  "name": "...",
  "...": "..."
}
```

All usage counts/history are still computed from private internal IDs.

## 4) Embed
Route: `GET /api/embed/:mod/card.svg`

### Before
`:mod` expected private UUID.

### Now
`:mod` expects public UUID.

SVG content/formatting behavior is otherwise unchanged.

## 5) Plugin Ownership
Route: `GET /api/account/get-plugin-ownership/:plugin_uuid`

### Before
Accepted private UUID.

### Now
Accepts public UUID.

Response shape is unchanged.

## 6) Account Payloads (`/register`, `/login`, `/me`)

Account responses now include split plugin access fields:
- `plugin_access`: public UUIDs
- `private_plugin_access`: private UUIDs

This is for frontend UX + developer config flows.

Existing account fields are otherwise unchanged.

## 7) Developer Profile
Route: `GET /api/account/developer/:developer_uuid`

`mods_managed[].uuid` is now public UUID.

## 8) Delete Plugin
Route: `POST /api/plugin/delete-plugin` (authenticated)

For transition safety, backend accepts either public or private UUID and resolves internally.
No frontend action required if you already use public UUID from UI.

## Frontend Migration Checklist

1. Use public UUIDs for all plugin pages/routes/links.
2. Use public UUIDs for:
   - `/api/plugin/plugin-info/:plugin_uuid`
   - `/api/plugin/list-plugins` keys and item IDs
   - `/api/embed/:mod/card.svg`
   - `/api/account/get-plugin-ownership/:plugin_uuid`
3. On plugin creation, store both:
   - `plugin_uuid` as public ID for routing/display.
   - `private_plugin_uuid` for server setup instructions.
4. In account pages:
   - show `plugin_access` for public references.
   - show/copy `private_plugin_access` only in authenticated developer settings.
5. Do not expose `private_plugin_uuid` in public pages, query params, or share links.

## Recommended UI Language
- Public UUID label: `Plugin ID`
- Private UUID label: `Server Reporting Key (Private)`
- Add warning near private key copy UI:
  - "Keep this private. Used by your server to report stats."

## Backward Compatibility Notes
- Existing plugins are auto-migrated; no manual DB operation needed.
- Ingest plugins must use private UUID. If they currently send old UUIDs, they continue to work because old UUID is now private UUID.
- Public pages should be switched to public UUID immediately to avoid leaking private identifiers going forward.

## Quick End-to-End Example
1. Developer creates plugin.
2. Backend returns:
   - public UUID for frontend pages.
   - private UUID for server config.
3. Frontend links use public UUID.
4. Server plugin reports using private UUID.
5. Stats display normally via public endpoints, backed by private internal mapping.
