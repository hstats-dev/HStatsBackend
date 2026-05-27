# Plugin Management And Search

This document covers backend changes for renaming mods and filtering mod search/list results.

## Rename A Mod

`POST /api/plugin/apply-plugin-name`

Requires session.

Request:

```json
{
  "plugin_uuid": "PUBLIC_OR_PRIVATE_PLUGIN_UUID",
  "name": "New Mod Name"
}
```

Response:

```json
{
  "status": "success",
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "name": "New Mod Name"
}
```

Validation:

- `name` is trimmed.
- `name` is required.
- Max length is `32` characters.
- Same profanity validation as mod creation.
- `plugin_uuid` may be the public or private plugin UUID.

Errors:

- `400` when `plugin_uuid` is missing.
- `400` when `name` is missing, too long, or fails validation.
- `401` when not authenticated.
- `403` when the signed-in account does not own/manage the mod.
- `404` when the mod does not exist.

## Create Mod Response

`POST /api/plugin/add-plugin`

The response now includes `is_unlisted`.

```json
{
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "private_plugin_uuid": "PRIVATE_PLUGIN_UUID",
  "is_unlisted": false
}
```

The endpoint also accepts optional `is_unlisted` when creating a mod.

## Search/List Mods

`GET /api/plugin/list-plugins`

Existing query params still work:

- `search`: text search against mod name.
- `max`: page size, clamped to `1-51`.
- `page`: 1-based page number.

New query params:

- `sort`: `popular`, `players`, `newest`, or `name`. Defaults to `popular`.
- `links`: `any`, `with_any`, `github`, `curseforge`, or `none`. Defaults to `any`.
- `developer_uuid`: only show mods owned by this developer account UUID.
- `min_servers`: only show mods with at least this many live servers.
- `max_servers`: only show mods with at most this many live servers.
- `min_players`: only show mods with at least this many live players.
- `max_players`: only show mods with at most this many live players.

Visibility behavior is automatic and cannot be controlled by a search filter:

- Unauthenticated users see listed mods only.
- Authenticated users see listed mods plus their own unlisted mods.
- Users cannot search specifically for listed or unlisted mods.

Response now includes top-level pagination and filter metadata:

```json
{
  "plugins": {
    "PUBLIC_PLUGIN_UUID": {
      "plugin_info": {
        "uuid": "PUBLIC_PLUGIN_UUID",
        "public_uuid": "PUBLIC_PLUGIN_UUID",
        "name": "Example Mod",
        "is_unlisted": false
      },
      "servers_using": 12,
      "total_players": 123,
      "daily_stats": [],
      "developer_info": {
        "id": "DEVELOPER_UUID",
        "username": "Example Dev",
        "github_link": "",
        "curseforge_link": ""
      },
      "pages": 3
    }
  },
  "page": 1,
  "max": 51,
  "total_plugins": 123,
  "total_pages": 3,
    "filters": {
      "sort": "popular",
      "links": "any",
      "developer_uuid": "",
    "min_servers": null,
    "max_servers": null,
    "min_players": null,
    "max_players": null
  }
}
```

Notes:

- Existing `plugins[uuid].pages` remains for compatibility.
- New frontend work should prefer top-level `total_pages`.
- `developer_info.id` is now included so search results can link directly to the developer profile.

## Example URLs

Most popular listed-or-visible mods:

```text
/api/plugin/list-plugins?search=world&sort=popular
```

Newest mods from a specific developer:

```text
/api/plugin/list-plugins?developer_uuid=DEVELOPER_UUID&sort=newest
```

Mods with CurseForge links and at least 10 live servers:

```text
/api/plugin/list-plugins?links=curseforge&min_servers=10
```

Mods with any configured link:

```text
/api/plugin/list-plugins?links=with_any
```
