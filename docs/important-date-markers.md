# Important Date Markers API

This document covers the public frontend endpoint for graph/event date markers and the admin-only Discord commands used to manage them.

## Purpose
- Store important dates with labels in the backend.
- Let frontend graphs fetch a simple array of markers.
- Allow admin-only management from Discord without editing the database manually.

---

## Public Endpoint

### Route
`GET /api/important-dates`

### Query Parameters
All parameters are optional.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | all | Caps the number of markers returned. Maximum `1000`. |

### Response
`200 OK`

```json
{
  "markers": [
    {
      "id": 1,
      "date": "2026-04-15T00:00:00.000Z",
      "unix": 1776211200,
      "label": "Open Beta Started"
    },
    {
      "id": 2,
      "date": "2026-05-02T18:30:00.000Z",
      "unix": 1777746600,
      "label": "Patch 0.8 Released"
    }
  ]
}
```

### Response Field Notes
- `id`: internal marker ID. Useful for admin/removal flows, not required by frontend rendering.
- `date`: ISO UTC timestamp string.
- `unix`: Unix timestamp in seconds.
- `label`: short marker text to show on the graph.

### Sorting
- Markers are returned sorted ascending by date.

---

## Frontend Guidance

### Recommended usage
- Use `date` if your chart library accepts ISO timestamps directly.
- Use `unix` if your graph layer prefers numeric timestamps.
- Use `label` as the marker/annotation text.

### Notes
- Dates are normalized and stored in UTC.
- Markers can represent whole-day events or exact timestamp events.
- The endpoint is public and read-only.

---

## Admin Discord Commands

These commands are owner-only.

### Add marker
`/admin-add-important-date`

Options:
- `label` required
- `date` required
- `time` optional

Accepted date examples:
- `today`
- `tomorrow`
- `yesterday`
- `2026-04-15`
- `04/15/2026`
- `2026-04-15 14:30`
- `04/15/2026 2:30pm`

Accepted time examples:
- `14:30`
- `14:30:00`
- `2pm`
- `2:30pm`

Behavior:
- Stores the date in UTC.
- Replies with the created marker ID and normalized ISO timestamp.

### List markers
`/admin-list-important-dates`

Options:
- `limit` optional, default `20`

Behavior:
- Shows stored marker IDs, timestamps, and labels.
- Use the returned marker ID for removal.

### Remove marker
`/admin-remove-important-date`

Options:
- `id` required

Behavior:
- Deletes the marker by ID.

---

## Storage Notes
- Stored in SQLite like the other backend databases.
- Default DB path:
  - `databases/important_dates.db`
- Optional override env var:
  - `IMPORTANT_DATES_DB`
