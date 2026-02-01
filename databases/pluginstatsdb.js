import betterSQL from "better-sqlite3";
import { configDotenv } from "dotenv";
configDotenv();

/*
Plugin daily stats storage.

Purpose:
- Store daily snapshots per plugin: number of servers using the plugin and the total
  players on those servers.
- Keep a rolling window (e.g., last 90 days) for charting.

Database location:
- Uses PLUGIN_STATS_DB if set.
- Falls back to "databases/plugin_stats.db".

Expected input format:
- day is a string in "YYYY-MM-DD" (UTC). If omitted, today (UTC) is used.

Typical usage (server-side aggregation):
1) Aggregate counts from the servers table for each plugin UUID.
2) Call upsertPluginDailyStats(pluginUUID, serversCount, playersCount, day).
3) Periodically prune old rows with prunePluginDailyStats(90).
*/

const dbPath = process.env.PLUGIN_STATS_DB || "databases/plugin_stats.db";
const db = betterSQL(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_stats_daily (
        plugin_uuid TEXT NOT NULL,
        day TEXT NOT NULL,
        servers_count INTEGER NOT NULL,
        players_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_uuid, day)
    );
`);

function toUtcDayString(value) {
    if (!value) {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    if (typeof value !== "string") {
        throw new Error("day must be a string in YYYY-MM-DD");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error("day must be in YYYY-MM-DD format");
    }
    return value;
}

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
}

/*
Upsert a daily snapshot for one plugin.
- pluginUUID: plugin UUID (string).
- serversCount: number of servers using the plugin (integer >= 0).
- playersCount: total players on those servers (integer >= 0).
- day: "YYYY-MM-DD" UTC; optional (defaults to today UTC).

Behavior:
- Keeps the largest values seen for that day (per field).
- This allows you to call it every few minutes and retain the daily peak.

Returns: { plugin_uuid, day }
*/
function upsertPluginDailyStats(pluginUUID, serversCount, playersCount, day = null) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    assertPositiveInt("serversCount", serversCount);
    assertPositiveInt("playersCount", playersCount);
    const dayStr = toUtcDayString(day);
    const now = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
        INSERT INTO plugin_stats_daily (plugin_uuid, day, servers_count, players_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid, day) DO UPDATE SET
            servers_count = CASE
                WHEN excluded.servers_count > plugin_stats_daily.servers_count
                THEN excluded.servers_count
                ELSE plugin_stats_daily.servers_count
            END,
            players_count = CASE
                WHEN excluded.players_count > plugin_stats_daily.players_count
                THEN excluded.players_count
                ELSE plugin_stats_daily.players_count
            END,
            updated_at = CASE
                WHEN excluded.servers_count > plugin_stats_daily.servers_count
                  OR excluded.players_count > plugin_stats_daily.players_count
                THEN excluded.updated_at
                ELSE plugin_stats_daily.updated_at
            END
    `);
    stmt.run(pluginUUID, dayStr, serversCount, playersCount, now);
    return { plugin_uuid: pluginUUID, day: dayStr };
}

/*
Fetch stats for a plugin between two dates (inclusive).
- fromDay / toDay: "YYYY-MM-DD"
Returns: [{ day, servers_count, players_count }]
*/
function getPluginDailyStats(pluginUUID, fromDay, toDay) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    const fromStr = toUtcDayString(fromDay);
    const toStr = toUtcDayString(toDay);

    const stmt = db.prepare(`
        SELECT day, servers_count, players_count
        FROM plugin_stats_daily
        WHERE plugin_uuid = ? AND day >= ? AND day <= ?
        ORDER BY day ASC
    `);
    return stmt.all(pluginUUID, fromStr, toStr);
}

/*
Fetch stats for the last N days (inclusive of today).
- days: integer >= 1, defaults to 90.
Returns: [{ day, servers_count, players_count }]
*/
function getPluginDailyStatsLastDays(pluginUUID, days = 90) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    if (!Number.isInteger(days) || days < 1) {
        throw new Error("days must be an integer >= 1");
    }
    const stmt = db.prepare(`
        SELECT day, servers_count, players_count
        FROM plugin_stats_daily
        WHERE plugin_uuid = ? AND day >= date('now', ?)
        ORDER BY day ASC
    `);
    return stmt.all(pluginUUID, `-${days - 1} days`);
}

/*
Delete rows older than N days. Use this to keep only the last 90 days.
- daysToKeep: integer >= 1 (default 90)
Returns: number of rows deleted.
*/
function prunePluginDailyStats(daysToKeep = 90) {
    if (!Number.isInteger(daysToKeep) || daysToKeep < 1) {
        throw new Error("daysToKeep must be an integer >= 1");
    }
    const stmt = db.prepare(`
        DELETE FROM plugin_stats_daily
        WHERE day < date('now', ?)
    `);
    const result = stmt.run(`-${daysToKeep} days`);
    return result.changes;
}

export {
    upsertPluginDailyStats,
    getPluginDailyStats,
    getPluginDailyStatsLastDays,
    prunePluginDailyStats
};
