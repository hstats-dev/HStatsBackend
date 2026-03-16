import betterSQL from "better-sqlite3";
import { configDotenv } from "dotenv";
import {
    MAX_PLAYERS_ONLINE_PER_SERVER,
    PLUGIN_HISTORY_DAYS,
    PLUGIN_HISTORY_RESIDUAL_SPIKE_MULTIPLIER,
    PLUGIN_HISTORY_SPIKE_MIN_PLAYERS_DELTA,
    PLUGIN_HISTORY_SPIKE_MIN_SERVERS_DELTA,
    PLUGIN_HISTORY_SPIKE_MULTIPLIER
} from "../config.js";
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

db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_all_time_peaks (
        plugin_uuid TEXT PRIMARY KEY,
        peak_servers_count INTEGER NOT NULL DEFAULT 0,
        peak_servers_at TEXT,
        peak_players_count INTEGER NOT NULL DEFAULT 0,
        peak_players_at TEXT,
        updated_at INTEGER NOT NULL
    );
`);

// Backfill all-time peaks for existing installs where hourly history already exists.
db.exec(`
    INSERT OR IGNORE INTO plugin_all_time_peaks (
        plugin_uuid,
        peak_servers_count,
        peak_servers_at,
        peak_players_count,
        peak_players_at,
        updated_at
    )
    SELECT
        p.plugin_uuid,
        COALESCE((
            SELECT h1.servers_count
            FROM plugin_stats_hourly h1
            WHERE h1.plugin_uuid = p.plugin_uuid
            ORDER BY h1.servers_count DESC, h1.hour_start ASC
            LIMIT 1
        ), 0),
        (
            SELECT h2.hour_start
            FROM plugin_stats_hourly h2
            WHERE h2.plugin_uuid = p.plugin_uuid
            ORDER BY h2.servers_count DESC, h2.hour_start ASC
            LIMIT 1
        ),
        COALESCE((
            SELECT h3.players_count
            FROM plugin_stats_hourly h3
            WHERE h3.plugin_uuid = p.plugin_uuid
            ORDER BY h3.players_count DESC, h3.hour_start ASC
            LIMIT 1
        ), 0),
        (
            SELECT h4.hour_start
            FROM plugin_stats_hourly h4
            WHERE h4.plugin_uuid = p.plugin_uuid
            ORDER BY h4.players_count DESC, h4.hour_start ASC
            LIMIT 1
        ),
        CAST(strftime('%s', 'now') AS INTEGER)
    FROM (SELECT DISTINCT plugin_uuid FROM plugin_stats_hourly) p
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

function toSafeNonNegativeInt(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
    }
    return Math.floor(numeric);
}

function smoothHourlySpikeRows(rows) {
    if (!Array.isArray(rows) || rows.length < 3) {
        return rows || [];
    }

    const smoothed = rows.map((row) => ({ ...row }));
    const source = rows.map((row) => ({
        servers_count: Math.max(0, Number(row.servers_count) || 0),
        players_count: Math.max(0, Number(row.players_count) || 0)
    }));

    const smoothFieldAtIndex = (index, field, minDelta) => {
        const prev = source[index - 1][field];
        const curr = source[index][field];
        const next = source[index + 1][field];

        // Need both neighboring points to form a local "normal" baseline.
        if (prev <= 0 || next <= 0) {
            return;
        }

        const neighborAvg = (prev + next) / 2;
        const isExtremeRelativeToNeighbors = curr >= (prev * PLUGIN_HISTORY_SPIKE_MULTIPLIER)
            && curr >= (next * PLUGIN_HISTORY_SPIKE_MULTIPLIER);
        const isResidualSpikeRelativeToNeighbors = curr >= (prev * PLUGIN_HISTORY_RESIDUAL_SPIKE_MULTIPLIER)
            && curr >= (next * PLUGIN_HISTORY_RESIDUAL_SPIKE_MULTIPLIER);
        const isLargeAbsoluteGap = (curr - neighborAvg) >= minDelta;

        if ((!isExtremeRelativeToNeighbors && !isResidualSpikeRelativeToNeighbors) || !isLargeAbsoluteGap) {
            return;
        }

        smoothed[index][field] = Math.max(0, Math.round(neighborAvg));
    };

    for (let index = 1; index < rows.length - 1; index += 1) {
        smoothFieldAtIndex(index, "servers_count", PLUGIN_HISTORY_SPIKE_MIN_SERVERS_DELTA);
        smoothFieldAtIndex(index, "players_count", PLUGIN_HISTORY_SPIKE_MIN_PLAYERS_DELTA);
    }

    return smoothed;
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

    const peakStmt = db.prepare(`
        INSERT INTO plugin_all_time_peaks (
            plugin_uuid,
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid) DO UPDATE SET
            peak_servers_count = CASE
                WHEN excluded.peak_servers_count > plugin_all_time_peaks.peak_servers_count
                THEN excluded.peak_servers_count
                ELSE plugin_all_time_peaks.peak_servers_count
            END,
            peak_servers_at = CASE
                WHEN excluded.peak_servers_count > plugin_all_time_peaks.peak_servers_count
                THEN excluded.peak_servers_at
                ELSE plugin_all_time_peaks.peak_servers_at
            END,
            peak_players_count = CASE
                WHEN excluded.peak_players_count > plugin_all_time_peaks.peak_players_count
                THEN excluded.peak_players_count
                ELSE plugin_all_time_peaks.peak_players_count
            END,
            peak_players_at = CASE
                WHEN excluded.peak_players_count > plugin_all_time_peaks.peak_players_count
                THEN excluded.peak_players_at
                ELSE plugin_all_time_peaks.peak_players_at
            END,
            updated_at = CASE
                WHEN excluded.peak_servers_count > plugin_all_time_peaks.peak_servers_count
                  OR excluded.peak_players_count > plugin_all_time_peaks.peak_players_count
                THEN excluded.updated_at
                ELSE plugin_all_time_peaks.updated_at
            END
    `);
    peakStmt.run(pluginUUID, serversCount, bucket, playersCount, bucket, now);
    return { plugin_uuid: pluginUUID, hour_start: bucket };
}

function setPluginHourlyStatsExact(pluginUUID, hourStart, serversCount, playersCount) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }

    assertPositiveInt("serversCount", serversCount);
    assertPositiveInt("playersCount", playersCount);
    const bucket = toUtcHourString(hourStart);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO plugin_stats_hourly (plugin_uuid, hour_start, servers_count, players_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid, hour_start) DO UPDATE SET
            servers_count = excluded.servers_count,
            players_count = excluded.players_count,
            updated_at = excluded.updated_at
    `).run(pluginUUID, bucket, serversCount, playersCount, now);

    rebuildPluginAllTimePeak(pluginUUID);
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

    const rows = stmt.all(pluginUUID, fromStr, toStr);
    const sanitizedRows = smoothHourlySpikeRows(rows);
    return sanitizedRows.map(row => ({
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

    const rows = stmt.all(pluginUUID, `-${days} days`);
    const sanitizedRows = smoothHourlySpikeRows(rows);
    return sanitizedRows.map(row => ({
        day: toUtcHourIsoString(row.hour_start),
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

/*
Fetch all-time peak values for one plugin.
Returns:
{
  servers: { count, at },
  players: { count, at }
}
*/
function getPluginAllTimePeak(pluginUUID) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }

    const allTimePeakRow = db.prepare(`
        SELECT
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at
        FROM plugin_all_time_peaks
        WHERE plugin_uuid = ?
    `).get(pluginUUID);

    if (allTimePeakRow) {
        return {
            servers: {
                count: allTimePeakRow.peak_servers_count || 0,
                at: allTimePeakRow.peak_servers_at ? toUtcHourIsoString(allTimePeakRow.peak_servers_at) : null
            },
            players: {
                count: allTimePeakRow.peak_players_count || 0,
                at: allTimePeakRow.peak_players_at ? toUtcHourIsoString(allTimePeakRow.peak_players_at) : null
            }
        };
    }

    const counts = db.prepare(`
        SELECT
            COALESCE(MAX(servers_count), 0) AS peak_servers,
            COALESCE(MAX(players_count), 0) AS peak_players
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ?
    `).get(pluginUUID);

    const peakServersAt = db.prepare(`
        SELECT hour_start
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ?
        ORDER BY servers_count DESC, hour_start ASC
        LIMIT 1
    `).get(pluginUUID);

    const peakPlayersAt = db.prepare(`
        SELECT hour_start
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ?
        ORDER BY players_count DESC, hour_start ASC
        LIMIT 1
    `).get(pluginUUID);

    return {
        servers: {
            count: counts?.peak_servers || 0,
            at: peakServersAt?.hour_start ? toUtcHourIsoString(peakServersAt.hour_start) : null
        },
        players: {
            count: counts?.peak_players || 0,
            at: peakPlayersAt?.hour_start ? toUtcHourIsoString(peakPlayersAt.hour_start) : null
        }
    };
}

function setPluginAllTimePeak(pluginUUID, {
    serversCount,
    serversAt,
    playersCount,
    playersAt
} = {}) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }

    const existing = db.prepare(`
        SELECT
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at
        FROM plugin_all_time_peaks
        WHERE plugin_uuid = ?
    `).get(pluginUUID) || {
        peak_servers_count: 0,
        peak_servers_at: null,
        peak_players_count: 0,
        peak_players_at: null
    };

    const nextServersCount = serversCount === undefined
        ? toSafeNonNegativeInt(existing.peak_servers_count)
        : toSafeNonNegativeInt(serversCount);
    const nextPlayersCount = playersCount === undefined
        ? toSafeNonNegativeInt(existing.peak_players_count)
        : toSafeNonNegativeInt(playersCount);

    const normalizePeakHour = (value, fallback) => {
        if (value === undefined) {
            return fallback;
        }
        if (value === null || value === "") {
            return null;
        }
        return toUtcHourString(String(value));
    };

    const nextServersAt = normalizePeakHour(serversAt, existing.peak_servers_at);
    const nextPlayersAt = normalizePeakHour(playersAt, existing.peak_players_at);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO plugin_all_time_peaks (
            plugin_uuid,
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid) DO UPDATE SET
            peak_servers_count = excluded.peak_servers_count,
            peak_servers_at = excluded.peak_servers_at,
            peak_players_count = excluded.peak_players_count,
            peak_players_at = excluded.peak_players_at,
            updated_at = excluded.updated_at
    `).run(pluginUUID, nextServersCount, nextServersAt, nextPlayersCount, nextPlayersAt, now);

    return getPluginAllTimePeak(pluginUUID);
}

function rebuildPluginAllTimePeak(pluginUUID) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }

    const topServers = db.prepare(`
        SELECT servers_count, hour_start
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ?
        ORDER BY servers_count DESC, hour_start ASC
        LIMIT 1
    `).get(pluginUUID);

    const topPlayers = db.prepare(`
        SELECT players_count, hour_start
        FROM plugin_stats_hourly
        WHERE plugin_uuid = ?
        ORDER BY players_count DESC, hour_start ASC
        LIMIT 1
    `).get(pluginUUID);

    const now = Math.floor(Date.now() / 1000);
    const peakServersCount = toSafeNonNegativeInt(topServers?.servers_count || 0);
    const peakServersAt = topServers?.hour_start || null;
    const peakPlayersCount = toSafeNonNegativeInt(topPlayers?.players_count || 0);
    const peakPlayersAt = topPlayers?.hour_start || null;

    db.prepare(`
        INSERT INTO plugin_all_time_peaks (
            plugin_uuid,
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_uuid) DO UPDATE SET
            peak_servers_count = excluded.peak_servers_count,
            peak_servers_at = excluded.peak_servers_at,
            peak_players_count = excluded.peak_players_count,
            peak_players_at = excluded.peak_players_at,
            updated_at = excluded.updated_at
    `).run(pluginUUID, peakServersCount, peakServersAt, peakPlayersCount, peakPlayersAt, now);

    return getPluginAllTimePeak(pluginUUID);
}

function repairPluginHistory(pluginUUID = null) {
    const pluginIds = pluginUUID
        ? [pluginUUID]
        : db.prepare("SELECT DISTINCT plugin_uuid FROM plugin_stats_hourly").all().map((row) => row.plugin_uuid);

    const updateStmt = db.prepare(`
        UPDATE plugin_stats_hourly
        SET servers_count = ?, players_count = ?, updated_at = ?
        WHERE plugin_uuid = ? AND hour_start = ?
    `);

    const now = Math.floor(Date.now() / 1000);
    let totalRowsUpdated = 0;
    let pluginsTouched = 0;

    pluginIds.forEach((id) => {
        const rows = db.prepare(`
            SELECT plugin_uuid, hour_start, servers_count, players_count
            FROM plugin_stats_hourly
            WHERE plugin_uuid = ?
            ORDER BY hour_start ASC
        `).all(id);

        if (rows.length === 0) {
            return;
        }

        const smoothed = smoothHourlySpikeRows(rows);
        let pluginChanged = false;

        for (let index = 0; index < rows.length; index += 1) {
            const before = rows[index];
            const candidate = smoothed[index];

            const nextServers = toSafeNonNegativeInt(candidate.servers_count);
            let nextPlayers = toSafeNonNegativeInt(candidate.players_count);
            const hardMaxPlayers = nextServers * MAX_PLAYERS_ONLINE_PER_SERVER;
            if (nextPlayers > hardMaxPlayers) {
                nextPlayers = hardMaxPlayers;
            }

            const beforeServers = toSafeNonNegativeInt(before.servers_count);
            const beforePlayers = toSafeNonNegativeInt(before.players_count);
            if (nextServers !== beforeServers || nextPlayers !== beforePlayers) {
                updateStmt.run(nextServers, nextPlayers, now, id, before.hour_start);
                totalRowsUpdated += 1;
                pluginChanged = true;
            }
        }

        rebuildPluginAllTimePeak(id);
        if (pluginChanged) {
            pluginsTouched += 1;
        }
    });

    return {
        plugins_scanned: pluginIds.length,
        plugins_touched: pluginsTouched,
        rows_updated: totalRowsUpdated
    };
}

function deletePluginStats(pluginUUID) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        throw new Error("pluginUUID must be a non-empty string");
    }
    const hourlyDeleted = db.prepare("DELETE FROM plugin_stats_hourly WHERE plugin_uuid = ?").run(pluginUUID).changes || 0;
    const peaksDeleted = db.prepare("DELETE FROM plugin_all_time_peaks WHERE plugin_uuid = ?").run(pluginUUID).changes || 0;
    return {
        hourly_deleted: hourlyDeleted,
        peaks_deleted: peaksDeleted
    };
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
    setPluginHourlyStatsExact,
    upsertPluginDailyStats,
    getPluginHourlyStats,
    getPluginDailyStats,
    getPluginHourlyStatsLastDays,
    getPluginAllTimePeak,
    setPluginAllTimePeak,
    rebuildPluginAllTimePeak,
    repairPluginHistory,
    deletePluginStats,
    getPluginDailyStatsLastDays,
    prunePluginHourlyStats,
    prunePluginDailyStats
};
