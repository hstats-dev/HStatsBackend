# Account Usernames + Plugin Links API Update

This document covers the new backend support for:
- account usernames (unique display names),
- developer profile name display,
- per-plugin links (GitHub/CurseForge),
- and where those new fields appear in existing responses.

## Summary

## New capabilities
- Users can set a unique account username.
- Developer profile now includes username and falls back to `"No Name"` when unset.
- Plugin owners can set links on each individual plugin.
- Plugin info responses now include per-plugin links.

## Existing capabilities retained
- Account-level developer links still work via:
  - `POST /api/account/apply-github-link`
  - `POST /api/account/apply-curseforge-link`
- Account-level developer links continue to appear in profile/ownership responses.

---

## 1) Account Username

### Endpoint
`POST /api/account/apply-username` (requires session)

### Request body
```json
{
  "username": "Example Dev"
}
```

### Behavior
- If `username` is empty/whitespace, username is cleared.
- If non-empty, it must pass validation and be unique.

### Validation rules (non-empty usernames)
- Length: `3` to `24`.
- Allowed chars: letters, numbers, space, `.`, `_`, `-`.
- Must start and end with letter/number.
- No repeated separators (no double spaces, `..`, `__`, `--`, etc.).
- Profanity blocked via `bad-words-next`.
- Uniqueness is case-insensitive.

### Responses
- `200` success:
```json
{
  "status": "success",
  "username": "Example Dev"
}
```
- `400` invalid format/content.
- `409` username already taken.

---

## 2) Account Payload Changes

These existing endpoints now include `username` in `account`:
- `POST /api/account/register`
- `POST /api/account/login`
- `GET /api/account/me`

`account` payload still includes developer links and plugin access fields from prior updates.

---

## 3) Developer Profile Changes

### Endpoint
`GET /api/account/developer/:developer_uuid`

### New/updated fields
- `developer.username` is now returned.
- If no username is set, value is `"No Name"`.
- `developer.mods_managed[]` now includes per-plugin `links`.

Example (shape only):
```json
{
  "developer": {
    "id": "developer-uuid",
    "username": "No Name",
    "discord_username": "",
    "github_link": "",
    "curseforge_link": "",
    "mods_managed_count": 1,
    "mods_managed": [
      {
        "uuid": "public-plugin-uuid",
        "name": "Plugin Name",
        "added_on": "...",
        "links": {
          "github_link": "",
          "curseforge_link": ""
        },
        "servers_using": 10,
        "total_players": 200
      }
    ]
  }
}
```

---

## 4) Per-Plugin Links

### New endpoint
`POST /api/plugin/apply-plugin-links` (requires session)

### Request body
```json
{
  "plugin_uuid": "PUBLIC_OR_PRIVATE_PLUGIN_UUID",
  "github_link": "https://github.com/example/repo",
  "curseforge_link": "https://www.curseforge.com/hytale/mods/mod-name"
}
```

### Notes
- `plugin_uuid` can be public or private; backend resolves internally.
- Caller must own/have access to plugin.
- Provide at least one of `github_link` / `curseforge_link`.
- Send empty string to clear a specific link.

### Link validation
- GitHub link must start with: `https://github.com/`
- CurseForge mod link must match:
  - `https://www.curseforge.com/hytale/mods/<mod-name>`

### Response
```json
{
  "status": "success",
  "plugin_uuid": "PUBLIC_PLUGIN_UUID",
  "links": {
    "github_link": "https://github.com/example/repo",
    "curseforge_link": ""
  }
}
```

---

## 5) Plugin Response Changes

### `GET /api/plugin/plugin-info/:plugin_uuid`
Now includes:
```json
"links": {
  "github_link": "",
  "curseforge_link": ""
}
```

### `GET /api/plugin/list-plugins`
`plugin_info` now includes `github_link` and `curseforge_link` fields.

---

## Frontend Checklist

1. Add UI for username edit/save using `POST /api/account/apply-username`.
2. Show username in developer pages; expect `"No Name"` fallback.
3. Add UI for per-plugin links in plugin settings using `POST /api/plugin/apply-plugin-links`.
4. Read plugin links from:
   - `plugin-info.links`
   - `list-plugins -> plugin_info.github_link / curseforge_link`
5. Keep using account-level link endpoints for developer profile links (unchanged).
