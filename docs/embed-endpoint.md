# Embed Card Endpoint

## Route
`GET /api/embed/:mod/card.svg`

- `:mod` is the plugin UUID.
- Response is SVG (`image/svg+xml`).
- Card is always clickable and links to `https://hstats.dev`.
- Card always includes the logo and `hstats.dev` watermark.
- Card does not render the plugin UUID text.

## Query Options
All options are optional.

| Option | Type | Values | Default | Notes |
|---|---|---|---|---|
| `theme` | string | `light`, `dark` | `light` | Visual color theme. |
| `layout` | string | `compact`, `stacked`, `history` | `compact` | Controls structure/format. |
| `size` | string | `sm`, `md`, `lg` | `md` | Uses per-layout size presets. |
| `dark` | bool | `true/false`, `1/0`, `yes/no`, `on/off` | `false` | Alias toggle; if true, forces dark theme. |

## History Layout
- `layout=history` renders an hourly peak trend graph for the plugin.
- The graph includes both series from plugin hourly stats:
  - `servers_count`
  - `players_count`
- Data source is the last `30` days (`getPluginDailyStatsLastDays`).
- If no history rows exist yet, the card renders a single fallback point from current live totals.

## Caching
- In-memory cache is enabled in the API process using a `Map`.
- Cache key includes: plugin UUID + `theme` + `layout` + `size`.
- Response header `X-Embed-Cache` is set to `HIT` or `MISS`.

### Cache Env Vars
| Variable | Default | Description |
|---|---|---|
| `EMBED_CACHE_TTL_MS` | `60000` | Cache entry lifetime in milliseconds. |
| `EMBED_CACHE_MAX_ENTRIES` | `500` | Maximum number of cached SVGs before oldest entries are evicted. |

## Size Presets
Sizes depend on `layout`:

- `compact`
  - `sm`: `520x146`
  - `md`: `620x170`
  - `lg`: `760x210`
- `stacked`
  - `sm`: `420x180`
  - `md`: `500x220`
  - `lg`: `620x260`
- `history`
  - `sm`: `620x220`
  - `md`: `760x280`
  - `lg`: `920x340`

## Example URLs
Default:

`/api/embed/PLUGIN_UUID/card.svg`

History graph (light):

`/api/embed/PLUGIN_UUID/card.svg?layout=history`

History graph dark large:

`/api/embed/PLUGIN_UUID/card.svg?layout=history&theme=dark&size=lg`

## Frontend Integration Notes
- Use the URL directly in `<img src="...">`.
- For cache-busting in preview UIs, append a timestamp query like `&t=1700000000000`.
- The endpoint sanitizes plugin text before rendering to SVG.
