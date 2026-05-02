# Embed SVG Endpoints

This document covers both public SVG embed endpoints:
- plugin embeds
- developer embeds

Both endpoints return SVG (`image/svg+xml`), support the same layout/theme/style query options, always include the logo and `hstats.dev` watermark, and are always clickable.

## Routes

### Plugin embed
`GET /api/embed/:mod/card.svg`

- `:mod` is the plugin public UUID.
- Click target: `https://hstats.dev`

### Developer embed
`GET /api/embed/developer/:developer_uuid/card.svg`

- `:developer_uuid` is the developer/account UUID used by the public developer profile endpoint.
- Click target: `https://hstats.dev/developer/:developer_uuid`

---

## Query Options
All options are optional on both endpoints.

| Option | Type | Values | Default | Notes |
|---|---|---|---|---|
| `theme` | string | see theme values below | `light` | Visual color theme. |
| `layout` | string | `compact`, `stacked`, `history` | `compact` | Controls structure/format. |
| `size` | string | `sm`, `md`, `lg` | `md` | Uses per-layout size presets. |
| `dark` | bool | `true/false`, `1/0`, `yes/no`, `on/off` | `false` | Alias toggle; if true, forces dark theme. |

### Theme Values
`theme` supports:

- `light`
- `dark`
- `github`
- `terminal`
- `forest`
- `ember`

The existing `light`, `dark`, `layout`, `size`, and `dark` behavior is still supported. Existing embed URLs keep working without changes.

---

## Style Customization
All style options are optional and can be mixed with any supported `theme`, `layout`, and `size`.

### Fonts
| Option | Type | Values | Default | Notes |
|---|---|---|---|---|
| `font` | string | `arial`, `system`, `verdana`, `georgia`, `mono` | `arial` | Uses safe local font stacks for broad SVG host compatibility. |

### Background and Shape
| Option | Type | Values | Default | Notes |
|---|---|---|---|---|
| `background` | string | `solid`, `transparent` | `solid` | `transparent` makes the main card background transparent. |
| `radius` | integer | `0`-`24` | `14` | Controls outer card and inner panel corner radius. |
| `borderWidth` | integer | `0`-`4` | `2` | Controls the outer card border width. |

### Color Overrides
Colors accept 3-digit or 6-digit hex values with or without `#`.

Important: if you include `#` in a URL, encode it as `%23`, because an unencoded `#` starts the URL fragment and will not reach the server. For example, use `bg=%23111827` or `bg=111827`.

| Option | Controls |
|---|---|
| `bg` | Main card background. Also accepts `transparent`. |
| `backgroundColor` | Alias for `bg`. Also accepts `transparent`. |
| `text` | Main text color. |
| `muted` | Secondary text color. |
| `border` | Outer card border color. |
| `divider` | Compact layout divider color. |
| `panel` | Stat panel background. Also accepts `transparent`. |
| `panelBorder` | Stat/chart panel border color. |
| `chartBg` | History chart panel background. Also accepts `transparent`. |
| `chartGrid` | History chart grid color. |
| `chartAxis` | History chart axis color. |
| `serversColor` | Servers stat/history line color. Also derives servers history fill. |
| `playersColor` | Players stat/history line color. Also derives players history fill. |

---

## Layout Behavior

### `compact`
- Smaller two-stat card.
- Shows current `servers` and `players`.

### `stacked`
- Taller card with larger stat blocks.
- Shows current `servers` and `players`.

### `history`
- Renders the last `30` days of hourly history.
- Red series = `servers`
- Green series = `players`

---

## Developer Embed Data Rules

Developer cards aggregate all managed mods for that account.

### Live totals
- `servers` = unique active servers using at least one of the developer's mods.
- `players` = summed players across those unique active servers.
- This avoids double-counting live totals when one server runs multiple mods by the same developer.

### History layout
- History is built by combining each managed plugin's stored hourly history rows.
- Subtitle/summary text on the card labels this as a `30-day aggregate`.
- This is derived from plugin history rows, not from a separate developer-history table.

### Important caveat
- If one server runs multiple mods by the same developer, historical aggregate rows may count that server once per plugin in the history view.
- Live totals are de-duplicated. Historical aggregate rows are not fully de-duplicated because the backend does not currently store developer-level historical server membership.

---

## Plugin History Layout
- Uses plugin hourly history from the backend.
- Summary line uses the plugin's all-time peak values.
- If no history rows exist yet, the card renders a single fallback point from the current live totals.

## Developer History Layout
- Uses combined hourly history across the developer's managed plugins for the last `30` days.
- Summary line shows the peak inside that derived aggregate window.
- If no history rows exist yet, the card renders a single fallback point from the current live totals.

---

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

---

## Caching
- In-memory cache is enabled in the API process using a `Map`.
- Cache key includes:
  - embed type (`plugin` or `developer`)
  - route UUID
  - `theme`
  - `layout`
  - `size`
  - validated style overrides, when present
- Response header `X-Embed-Cache` is set to `HIT` or `MISS`.

### Cache Env Vars
| Variable | Default | Description |
|---|---|---|
| `EMBED_CACHE_TTL_MS` | `60000` | Cache entry lifetime in milliseconds. |
| `EMBED_CACHE_MAX_ENTRIES` | `500` | Maximum number of cached SVGs before oldest entries are evicted. |

---

## Example URLs

### Plugin default
`/api/embed/PLUGIN_PUBLIC_UUID/card.svg`

### Plugin history dark large
`/api/embed/PLUGIN_PUBLIC_UUID/card.svg?layout=history&theme=dark&size=lg`

### Plugin custom colors
`/api/embed/PLUGIN_PUBLIC_UUID/card.svg?theme=dark&bg=111827&text=f9fafb&panel=1f2937&border=374151&serversColor=f97316&playersColor=22c55e`

### Plugin transparent square mono
`/api/embed/PLUGIN_PUBLIC_UUID/card.svg?background=transparent&radius=0&borderWidth=0&font=mono`

### Developer default
`/api/embed/developer/DEVELOPER_UUID/card.svg`

### Developer stacked dark
`/api/embed/developer/DEVELOPER_UUID/card.svg?layout=stacked&theme=dark`

### Developer history large
`/api/embed/developer/DEVELOPER_UUID/card.svg?layout=history&size=lg`

### Developer terminal history
`/api/embed/developer/DEVELOPER_UUID/card.svg?layout=history&theme=terminal&font=mono`

---

## Frontend Integration Notes
- Use the URL directly in `<img src="...">`.
- For cache-busting in preview UIs, append a timestamp query like `&t=1700000000000`.
- Plugin embeds should use the plugin public UUID.
- Developer embeds should use the developer UUID from:
  - `GET /api/account/developer/:developer_uuid`
  - ownership/profile payloads where account IDs are already exposed
- SVG text is sanitized before rendering.
