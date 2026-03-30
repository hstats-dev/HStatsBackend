# Private Plugin UUID Refresh

This document covers the backend support for rotating a plugin's private UUID when it has been leaked or exposed.

## Summary

## What this does
- Lets an authenticated plugin owner generate a new private UUID.
- Keeps the public UUID unchanged.
- Updates stored references so existing ownership, server associations, and plugin history continue to point at the same plugin.
- Enforces a `24 hour` cooldown between refreshes for the same plugin.

## What changes after refresh
- The old private UUID stops being valid for server reporting.
- The new private UUID becomes the only valid private/reporting UUID for that plugin.
- Public pages, frontend routes, embeds, and public API usage do not change because `public_uuid` stays the same.

---

## Endpoint
`POST /api/plugin/refresh-private-plugin-uuid` (requires session)

## Request body
```json
{
  "plugin_uuid": "PUBLIC_OR_PRIVATE_PLUGIN_UUID"
}
```

## Notes
- `plugin_uuid` may be either the plugin's public UUID or current private UUID.
- Caller must own or have access to the plugin.
- The backend generates a fresh UUID and ensures it does not collide with any existing plugin public UUID or private UUID.
- Refresh is limited to once every `24 hours` per plugin.

## Success response
`200 OK`

```json
{
  "status": "success",
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "private_plugin_uuid": "NEW_PRIVATE_PLUGIN_UUID",
  "last_private_uuid_refresh_at": "2026-03-20T18:00:00.000Z",
  "next_refresh_at": "2026-03-21T18:00:00.000Z"
}
```

## Error responses

### Missing UUID
`400 Bad Request`
```json
{
  "error": "Missing plugin_uuid field"
}
```

### Plugin not found
`404 Not Found`
```json
{
  "error": "Plugin not found"
}
```

### No access to plugin
`403 Forbidden`
```json
{
  "error": "Cannot refresh a plugin you do not have access to"
}
```

### Cooldown active
`429 Too Many Requests`
```json
{
  "error": "Private plugin UUID can only be refreshed once every 24 hours",
  "retry_after_seconds": 3600,
  "next_refresh_at": "2026-03-21T18:00:00.000Z"
}
```

### Internal failure
`500 Internal Server Error`
```json
{
  "error": "Failed to refresh private plugin UUID"
}
```

---

## Frontend Guidance

1. Add a "Refresh Private UUID" action in authenticated plugin settings only.
2. Confirm with the user before calling the endpoint because the old private UUID will stop working.
3. After success:
   - keep using `plugin_uuid` for frontend routing and public pages.
   - replace the stored/shown private reporting UUID with `private_plugin_uuid`.
   - show `next_refresh_at` to explain when the action becomes available again.
4. Do not expose `private_plugin_uuid` on public pages.

## Suggested UI copy
- Button label: `Refresh Server Reporting Key`
- Warning text: `Refreshing this key will immediately invalidate the old private key used by servers to report stats.`

## Backend Behavior Notes
- Account plugin access entries are updated to the new private UUID.
- Server plugin references are updated to the new private UUID.
- Plugin hourly history and all-time peak records are updated to the new private UUID.
- The plugin's public UUID and public-facing API responses remain stable.
