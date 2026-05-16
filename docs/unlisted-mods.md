# Unlisted Mods

This document covers backend support for mods that should remain accessible by direct link, but should not appear in public discovery surfaces.

## Behavior

- Mods are listed by default.
- Developers can mark a mod as unlisted.
- Unlisted mods still resolve by direct public UUID through the normal mod detail endpoint.
- Unlisted mods are hidden from the public mods listing.
- Unlisted mods are hidden from public developer profile mod lists.
- When the signed-in developer views their own developer profile endpoint, their unlisted mods are included.
- Public developer SVG embeds exclude unlisted mods from aggregate counts and history.
- Recent activity is unchanged and may still include mod registration events.

## Data Model

The `plugins` table now includes:

```sql
is_unlisted INTEGER DEFAULT 0
```

Public plugin payloads now include:

```json
{
  "is_unlisted": false
}
```

This appears anywhere `toPublicPlugin(...)` is used, including listing payloads and authenticated owner-facing responses.

## Update Visibility

`POST /api/plugin/apply-plugin-visibility`

Requires session.

Request:

```json
{
  "plugin_uuid": "PUBLIC_OR_PRIVATE_PLUGIN_UUID",
  "is_unlisted": true
}
```

Response:

```json
{
  "status": "success",
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "is_unlisted": true
}
```

Errors:

- `400` when `plugin_uuid` is missing.
- `400` when `is_unlisted` is not a boolean.
- `401` when not authenticated.
- `403` when the signed-in account does not own/manage the mod.
- `404` when the mod does not exist.

## Create As Unlisted

`POST /api/plugin/add-plugin`

The existing create endpoint now accepts optional `is_unlisted`.

Request:

```json
{
  "name": "Example Mod",
  "is_unlisted": true
}
```

Response:

```json
{
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "private_plugin_uuid": "PRIVATE_PLUGIN_UUID",
  "is_unlisted": true
}
```

If omitted, `is_unlisted` defaults to `false`.

## Existing Endpoints

### `GET /api/plugin/list-plugins`

Unauthenticated users only see listed mods.

Authenticated users also see their own unlisted mods in the list. This lets dashboard/search views that reuse the public listing still show the developer's own unlisted work.

Each `plugin_info` object includes `is_unlisted`.

### `GET /api/account/developer/:developer_uuid`

Unauthenticated users and other signed-in users only see listed mods in:

```json
developer.mods_managed
```

When the signed-in developer requests their own profile, `mods_managed` includes their unlisted mods. Each mod summary includes `is_unlisted`.

### `GET /api/plugin/plugin-info/:plugin_uuid`

Direct links continue to work for unlisted mods.

The endpoint still resolves by public plugin UUID and returns normal stats. The response includes top-level `is_unlisted`.

## Frontend Notes

- Add a visibility control in the developer/plugin settings UI that sends `POST /api/plugin/apply-plugin-visibility`.
- Treat `is_unlisted: true` as "hidden from public discovery, available by direct link."
- Use the public `plugin_uuid` returned by the endpoint for frontend routes and links.
- Do not change server reporting setup; private plugin UUID behavior is unchanged.
- Public mod detail pages should still render normally for unlisted mods when opened directly.
