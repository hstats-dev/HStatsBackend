import betterSQL from "better-sqlite3";
import { configDotenv } from "dotenv";
import { PLUGIN_HISTORY_DAYS } from "../config.js";
configDotenv();

/*
Plugin hourly stats storage.

Purpose:
- Store hourly peak snapshots per plugin: number of servers using the plugin and the total
  players on those servers.
- Keep a rolling window (last 30 days by default) for charting.

Database location:
- Uses PLUGIN_STATS_DB if set.
- Falls back to "databases/plugin_stats.db".

Expected input format:
- hourStart can be:
  - "YYYY-MM-DD HH:MM:SS" (UTC)
  - "YYYY-MM-DDTHH:MM:SSZ" (UTC)
  - "YYYY-MM-DD" (only accepted for range queries)
*/

const dbPath = process.env.PLUGIN_STATS_DB || "databases/plugin_stats.db";
const db = betterSQL(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_stats_hourly (
        plugin_uuid TEXT NOT NULL,
        hour_start TEXT NOT NULL,
        servers_count INTEGER NOT NULL,
        players_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_uuid, hour_start)
    );
`);

// Best-effort migration for older installs that only have daily stats.
const hasLegacyDailyTable = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'plugin_stats_daily'
`).get();

if (hasLegacyDailyTable) {
    db.exec(`
        INSERT OR IGNORE INTO plugin_stats_hourly (plugin_uuid, hour_start, servers_count, players_count, updated_at)
        SELECT plugin_uuid, day || ' 12:00:00', servers_count, players_count, updated_at
        FROM plugin_stats_daily
    `);
}

function formatUtcHourString(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    const h = String(date.getUTCHours()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:00:00`;
}

function toUtcHourString(value, { allowDayOnly = false, dayAsEnd = false } = {}) {
    if (!value) {
        return formatUtcHourString(new Date());
    }

    if (typeof value !== "string") {
        throw new Error("hour must be a string");
    }

    const trimmed = value.trim();
    if (allowDayOnly && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed} ${dayAsEnd ? "23:00:00" : "00:00:00"}`;
    }

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
        return `${trimmed.slice(0, 13)}:00:00`;
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(trimmed)) {
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error("Invalid ISO UTC datetime");
        }
        return formatUtcHourString(parsed);
    }

    throw new Error("hour must be YYYY-MM-DD HH:MM:SS or ISO UTC datetime");
}

function toUtcHourIsoString(hourStart) {
    return `${String(hourStart).replace(" ", "T")}Z`;
}

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
}

/*
Upsert an hourly snapshot for one plugin.
- pluginUUID: plugin UUID (string).
- serversCount: number of servers using the plugin (integer >= 0).
- playersCount: total players on those servers (integer >= 0).
- hourStart: UTC hour bucket; optional (defaults to current UTC hour).

Behavior:
- Keeps the largest values seen for that hour (per field).
- This allows calling every few minutes and retaining the hourly peak.

Returns: { plugin_uuid, hour_start }
*/
function upsertPluginHourlyStats(pluginUUID, serversCount, playersCount, hourStart = null) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    assertPositiveInt("serversCount", serversCount);
    assertPositiveInt("playersCount", playersCount);

    const bucket = toUtcHourString(hourStart);
    const now = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
        INSERT INTO plugin_stats_hourly (plugin_uuid, hour_start, servers_count, players_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid, hour_start) DO UPDATE SET
            servers_count = CASE
                WHEN excluded.servers_count > plugin_stats_hourly.servers_count
                THEN excluded.servers_count
                ELSE plugin_stats_hourly.servers_count
            END,
            players_count = CASE
                WHEN excluded.players_count > plugin_stats_hourly.players_count
                THEN excluded.players_count
                ELSE plugin_stats_hourly.players_count
            END,
            updated_at = CASE
                WHEN excluded.servers_count > plugin_stats_hourly.servers_count
                  OR excluded.players_count > plugin_stats_hourly.players_count
                THEN excluded.updated_at
                ELSE plugin_stats_hourly.updated_at
            END
    `);
    stmt.run(pluginUUID, bucket, serversCount, playersCount, now);
    return { plugin_uuid: pluginUUID, hour_start: bucket };
}

/*
Compatibility alias for older call sites.
*/
function upsertPluginDailyStats(pluginUUID, serversCount, playersCount, day = null) {
    return upsertPluginHourlyStats(pluginUUID, serversCount, playersCount, day);
}

/*
Fetch hourly stats for a plugin between two values (inclusive).
- fromHour / toHour can be "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", or ISO UTC.
Returns: [{ day, hour_start, servers_count, players_count }]
*/
function getPluginHourlyStats(pluginUUID, fromHour, toHour) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    const fromStr = toUtcHourString(fromHour, { allowDayOnly: true, dayAsEnd: false });
    const toStr = toUtcHourString(toHour, { allowDayOnly: true, dayAsEnd: true });

    const stmt = db.prepare(`
        SELECT hour_start, servers_count, players_count
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ? AND hour_start >= ? AND hour_start <= ?
        ORDER BY hour_start ASC
    `);

    return stmt.all(pluginUUID, fromStr, toStr).map(row => ({
        day: toUtcHourIsoString(row.hour_start),
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

/*
Compatibility alias for older call sites.
*/
function getPluginDailyStats(pluginUUID, fromDay, toDay) {
    return getPluginHourlyStats(pluginUUID, fromDay, toDay);
}

/*
Fetch hourly stats for the last N days (inclusive of now).
- days: integer >= 1, defaults to PLUGIN_HISTORY_DAYS.
Returns: [{ day, hour_start, servers_count, players_count }]
*/
function getPluginHourlyStatsLastDays(pluginUUID, days = PLUGIN_HISTORY_DAYS) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    if (!Number.isInteger(days) || days < 1) {
        throw new Error("days must be an integer >= 1");
    }

    const stmt = db.prepare(`
        SELECT hour_start, servers_count, players_count
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ? AND hour_start >= datetime('now', ?)
        ORDER BY hour_start ASC
    `);

    return stmt.all(pluginUUID, `-${days} days`).map(row => ({
        day: toUtcHourIsoString(row.hour_start),
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

/*
Compatibility alias for older call sites.
*/
function getPluginDailyStatsLastDays(pluginUUID, days = PLUGIN_HISTORY_DAYS) {
    return getPluginHourlyStatsLastDays(pluginUUID, days);
}

/*
Delete rows older than N days.
- daysToKeep: integer >= 1 (default PLUGIN_HISTORY_DAYS)
Returns: number of rows deleted.
*/
function prunePluginHourlyStats(daysToKeep = PLUGIN_HISTORY_DAYS) {
    if (!Number.isInteger(daysToKeep) || daysToKeep < 1) {
        throw new Error("daysToKeep must be an integer >= 1");
    }

    const stmt = db.prepare(`
        DELETE FROM plugin_stats_hourly
        WHERE hour_start < datetime('now', ?)
    `);
    const result = stmt.run(`-${daysToKeep} days`);
    return result.changes;
}

/*
Compatibility alias for older call sites.
*/
function prunePluginDailyStats(daysToKeep = PLUGIN_HISTORY_DAYS) {
    return prunePluginHourlyStats(daysToKeep);
}

export {
    upsertPluginHourlyStats,
    upsertPluginDailyStats,
    getPluginHourlyStats,
    getPluginDailyStats,
    getPluginHourlyStatsLastDays,
    getPluginDailyStatsLastDays,
    prunePluginHourlyStats,
    prunePluginDailyStats
};
