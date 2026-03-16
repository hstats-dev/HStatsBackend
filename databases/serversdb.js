import betterSQL from "better-sqlite3";
import axios from "axios";
import { configDotenv } from "dotenv";
import { prunePluginHourlyStats, upsertPluginHourlyStats } from "./pluginstatsdb.js";
import {
    AMOUNT_NEEDED_TO_DISPLAY,
    MAX_ACTIVE_SERVERS_PER_IP,
    MAX_PLAYERS_ONLINE_PER_SERVER,
    PLUGIN_HISTORY_SPIKE_MIN_PLAYERS_DELTA,
    PLUGIN_HISTORY_SPIKE_MIN_SERVERS_DELTA,
    PLUGIN_HISTORY_SPIKE_MULTIPLIER,
    SERVER_PLAYER_SPIKE_BURST,
    SERVER_PLAYER_SPIKE_PER_MINUTE,
    SERVER_SPIKE_GUARD_WINDOW_MINUTES,
    VALID_JAVA_VERSIONS,
    VALID_OS_NAMES
} from "../config.js";
configDotenv();

// Plugin Format: pluginUUID@version (version is optional)
const db = betterSQL(process.env.SERVERS_DB);

db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
        uuid TEXT PRIMARY KEY,
        players_online INTEGER,
        plugins TEXT,
        reporter_ip TEXT DEFAULT '',
        os_name TEXT,
        os_version TEXT,
        java_version TEXT,
        core_count INTEGER,
        country TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS global_all_time_peaks (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        peak_servers_count INTEGER NOT NULL DEFAULT 0,
        peak_servers_at TEXT,
        peak_players_count INTEGER NOT NULL DEFAULT 0,
        peak_players_at TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS global_stats_hourly (
        hour_start TEXT PRIMARY KEY,
        servers_count INTEGER NOT NULL,
        players_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
`);

db.prepare(`
    INSERT OR IGNORE INTO global_all_time_peaks (
        id,
        peak_servers_count,
        peak_servers_at,
        peak_players_count,
        peak_players_at,
        updated_at
    )
    VALUES (1, 0, NULL, 0, NULL, 0)
`).run();

function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
}

ensureColumn("servers", "reporter_ip", "TEXT DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_servers_reporter_ip ON servers(reporter_ip)");

function parsePlayerCountStrict(value) {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error("players_online must be an integer");
        }
        if (value < 0 || value > MAX_PLAYERS_ONLINE_PER_SERVER) {
            throw new Error("players_online must be a normal integer");
        }
        return value;
    }

    if (typeof value !== "string") {
        throw new Error("players_online must be a number or numeric string");
    }

    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error("players_online must be a whole number string");
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error("players_online must be a safe integer");
    }
    if (parsed < 0 || parsed > MAX_PLAYERS_ONLINE_PER_SERVER) {
        throw new Error("players_online must be a normal integer");
    }

    return parsed;
}

function clampPlayerCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
    }
    if (numeric >= MAX_PLAYERS_ONLINE_PER_SERVER) {
        return MAX_PLAYERS_ONLINE_PER_SERVER;
    }
    return Math.floor(numeric);
}

function toSafeNonNegativeInt(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
    }
    return Math.floor(numeric);
}

function smoothHourlySpikeRows(rows, {
    serversField = "servers_count",
    playersField = "players_count"
} = {}) {
    if (!Array.isArray(rows) || rows.length < 3) {
        return rows || [];
    }

    const smoothed = rows.map((row) => ({ ...row }));
    const source = rows.map((row) => ({
        [serversField]: Math.max(0, Number(row[serversField]) || 0),
        [playersField]: Math.max(0, Number(row[playersField]) || 0)
    }));

    const smoothFieldAtIndex = (index, field, minDelta) => {
        const prev = source[index - 1][field];
        const curr = source[index][field];
        const next = source[index + 1][field];

        if (prev <= 0 || next <= 0) {
            return;
        }

        const neighborAvg = (prev + next) / 2;
        const isExtremeRelativeToNeighbors = curr >= (prev * PLUGIN_HISTORY_SPIKE_MULTIPLIER)
            && curr >= (next * PLUGIN_HISTORY_SPIKE_MULTIPLIER);
        const isLargeAbsoluteGap = (curr - neighborAvg) >= minDelta;

        if (!isExtremeRelativeToNeighbors || !isLargeAbsoluteGap) {
            return;
        }

        smoothed[index][field] = Math.max(0, Math.round(neighborAvg));
    };

    for (let index = 1; index < rows.length - 1; index += 1) {
        smoothFieldAtIndex(index, serversField, PLUGIN_HISTORY_SPIKE_MIN_SERVERS_DELTA);
        smoothFieldAtIndex(index, playersField, PLUGIN_HISTORY_SPIKE_MIN_PLAYERS_DELTA);
    }

    return smoothed;
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

function parseSqliteTimestampToMs(sqliteTimestamp) {
    if (!sqliteTimestamp || typeof sqliteTimestamp !== "string") {
        return null;
    }

    const normalized = sqliteTimestamp.includes("T")
        ? sqliteTimestamp
        : sqliteTimestamp.replace(" ", "T");
    const withTimezone = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
    const parsedMs = Date.parse(withTimezone);
    if (Number.isNaN(parsedMs)) {
        return null;
    }
    return parsedMs;
}

function applyPerServerPlayerSpikeGuard(previousCount, previousUpdatedAt, incomingCount) {
    const previousPlayers = clampPlayerCount(previousCount);
    const incomingPlayers = clampPlayerCount(incomingCount);
    if (incomingPlayers <= previousPlayers) {
        return incomingPlayers;
    }

    const previousUpdatedMs = parseSqliteTimestampToMs(previousUpdatedAt);
    if (!Number.isFinite(previousUpdatedMs)) {
        return incomingPlayers;
    }

    const elapsedMinutes = Math.max(0, (Date.now() - previousUpdatedMs) / 60000);
    if (elapsedMinutes > SERVER_SPIKE_GUARD_WINDOW_MINUTES) {
        return incomingPlayers;
    }

    const allowedIncrease = SERVER_PLAYER_SPIKE_BURST + (elapsedMinutes * SERVER_PLAYER_SPIKE_PER_MINUTE);
    const maxAllowed = Math.min(
        MAX_PLAYERS_ONLINE_PER_SERVER,
        previousPlayers + Math.max(0, Math.floor(allowedIncrease))
    );

    if (incomingPlayers > maxAllowed) {
        return maxAllowed;
    }

    return incomingPlayers;
}

function normalizeStoredPlayerCounts() {
    const stmt = db.prepare(`
        UPDATE servers
        SET players_online = CASE
            WHEN players_online IS NULL THEN 0
            WHEN CAST(players_online AS REAL) < 0 THEN 0
            WHEN CAST(players_online AS REAL) > ? THEN ?
            ELSE CAST(players_online AS INTEGER)
        END
        WHERE players_online IS NULL
           OR CAST(players_online AS REAL) < 0
           OR CAST(players_online AS REAL) > ?
           OR players_online != CAST(players_online AS INTEGER)
    `);
    const result = stmt.run(MAX_PLAYERS_ONLINE_PER_SERVER, MAX_PLAYERS_ONLINE_PER_SERVER, MAX_PLAYERS_ONLINE_PER_SERVER);
    if (result.changes > 0) {
        console.warn(`Normalized ${result.changes} spoofed/invalid players_online values in servers table.`);
    }
}

function getGlobalCountableServerRows() {
    const timeoutMinutes = getServerAliveTimeoutMinutes();
    return db.prepare(`
        SELECT *
        FROM servers
        WHERE plugins IS NOT NULL
          AND TRIM(plugins) <> ''
          AND last_updated >= datetime('now', ?)
    `).all(`-${timeoutMinutes} minutes`);
}

function countActiveServersForIp(ipAddress) {
    const normalizedIp = typeof ipAddress === "string" ? ipAddress.trim() : "";
    if (!normalizedIp) {
        return 0;
    }

    const timeoutMinutes = getServerAliveTimeoutMinutes();
    const row = db.prepare(`
        SELECT COUNT(*) AS total
        FROM servers
        WHERE reporter_ip = ?
          AND last_updated >= datetime('now', ?)
    `).get(normalizedIp, `-${timeoutMinutes} minutes`);

    return row?.total || 0;
}

function enforcePerIpActiveServerLimit() {
    const timeoutMinutes = getServerAliveTimeoutMinutes();
    const rows = db.prepare(`
        SELECT uuid, reporter_ip, plugins, last_updated
        FROM servers
        WHERE reporter_ip IS NOT NULL
          AND TRIM(reporter_ip) <> ''
          AND last_updated >= datetime('now', ?)
        ORDER BY
            reporter_ip ASC,
            CASE WHEN plugins IS NOT NULL AND TRIM(plugins) <> '' THEN 0 ELSE 1 END ASC,
            last_updated ASC,
            uuid ASC
    `).all(`-${timeoutMinutes} minutes`);

    const deleteStmt = db.prepare("DELETE FROM servers WHERE uuid = ?");
    let removed = 0;
    let currentIp = null;
    let keptForIp = 0;

    rows.forEach((row) => {
        const reporterIp = String(row.reporter_ip || "").trim();
        if (!reporterIp) {
            return;
        }

        if (reporterIp !== currentIp) {
            currentIp = reporterIp;
            keptForIp = 0;
        }

        if (keptForIp < MAX_ACTIVE_SERVERS_PER_IP) {
            keptForIp += 1;
            return;
        }

        deleteStmt.run(row.uuid);
        removed += 1;
    });

    if (removed > 0) {
        console.warn(`Removed ${removed} excess active servers that exceeded the per-IP limit.`);
    }

    return removed;
}

normalizeStoredPlayerCounts();
normalizeStoredPluginEntries();
enforcePerIpActiveServerLimit();

// Initial request to add an online server
async function addOrUpdateServer(uuid, ip, playerCount, osName = "", osVersion = "", javaVersion = "", coreCount = 0) {
    const safePlayerCount = parsePlayerCountStrict(playerCount);
    const normalizedIp = typeof ip === "string" ? ip.trim() : "";

    const getStmt = db.prepare("SELECT * FROM servers WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        const guardedPlayerCount = applyPerServerPlayerSpikeGuard(row.players_online, row.last_updated, safePlayerCount);
        if (guardedPlayerCount < safePlayerCount) {
            console.warn(`Suspicious player spike clamped for server ${uuid}: ${safePlayerCount} -> ${guardedPlayerCount}`);
        }
        const updateStmt = db.prepare(`
            UPDATE servers
            SET players_online = ?, reporter_ip = ?, last_updated = CURRENT_TIMESTAMP
            WHERE uuid = ?
        `);
        return {
            accepted: updateStmt.run(guardedPlayerCount, normalizedIp, uuid).changes > 0,
            rejected: false
        };
    }

    if (normalizedIp && countActiveServersForIp(normalizedIp) >= MAX_ACTIVE_SERVERS_PER_IP) {
        console.warn(`Rejected new server ${uuid} from ${normalizedIp}: active server IP limit reached.`);
        return {
            accepted: false,
            rejected: true,
            reason: "ip_limit"
        };
    }

    let country = "Unknown";
    await axios.get(`http://ip-api.com/json/${normalizedIp}?fields=49154`)
        .then(response => {
            country = response.data.countryCode || "Unknown";
        })
        .catch(error => {
            console.warn("Error fetching geolocation data for server (" + error?.response?.data?.message + ") Using 'Unknown' as country.");
        }).finally(() => {
            console.log(`Adding new server: ${uuid} with IP: ${normalizedIp || "unknown"} (${country})`);
            const insertStmt = db.prepare(`
                INSERT INTO servers (uuid, players_online, plugins, reporter_ip, os_name, os_version, java_version, core_count, country)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            insertStmt.run(uuid, safePlayerCount, "", normalizedIp, osName, osVersion, javaVersion, coreCount, country);
        });
    return {
        accepted: true,
        rejected: false
    };
}

// Add a plugin to the server's list of plugins, this is called when a server starts
// incase each plugin is using HStats
function addPluginToServer(uuid, pluginUUID, version = "Unknown") {
    const getStmt = db.prepare("SELECT plugins FROM servers WHERE uuid = ?");
    const row = getStmt.get(uuid);
    const currentPlugins = row?.plugins || "";
    const normalizedVersion = (typeof version === "string" && version.trim()) ? version.trim() : "Unknown";
    const targetEntry = `${pluginUUID}@${normalizedVersion}`;

    const nextEntries = [];
    let found = false;
    let changed = false;

    parsePluginEntries(currentPlugins).forEach((entry) => {
        const { pluginUUID: existingUUID, version: existingVersion } = parsePluginUUIDAndVersion(entry);
        if (!existingUUID) {
            changed = true;
            return;
        }

        if (existingUUID !== pluginUUID) {
            nextEntries.push(`${existingUUID}@${existingVersion}`);
            return;
        }

        if (!found) {
            found = true;
            nextEntries.push(targetEntry);
            if (`${existingUUID}@${existingVersion}` !== targetEntry) {
                changed = true;
            }
            return;
        }

        // Duplicate entry for same plugin UUID then drop it.
        changed = true;
    });

    if (!found) {
        nextEntries.push(targetEntry);
        changed = true;
    }

    if (changed) {
        const updateStmt = db.prepare("UPDATE servers SET plugins = ? WHERE uuid = ?");
        const result = updateStmt.run(nextEntries.join(","), uuid);
        return result.changes > 0;
    }
    return false;
}

function removeServer(uuid) {
    const stmt = db.prepare("DELETE FROM servers WHERE uuid = ?");
    const result = stmt.run(uuid);
    return result.changes;
}

function getServer(uuid) {
    const stmt = db.prepare("SELECT * FROM servers WHERE uuid = ?");
    return stmt.get(uuid);
}

function parsePluginEntries(pluginsValue) {
    if (!pluginsValue || typeof pluginsValue !== "string") {
        return [];
    }
    return pluginsValue
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

function parsePluginUUID(entry) {
    if (!entry) {
        return "";
    }
    const [pluginUUID] = entry.split("@");
    return pluginUUID || "";
}

function parsePluginUUIDAndVersion(entry) {
    if (!entry || typeof entry !== "string") {
        return { pluginUUID: "", version: "Unknown" };
    }
    const [pluginUUIDRaw, versionRaw] = entry.split("@");
    const pluginUUID = (pluginUUIDRaw || "").trim();
    const version = (versionRaw || "").trim() || "Unknown";
    return { pluginUUID, version };
}

function normalizePluginEntriesValue(pluginsValue) {
    const latestVersionByUUID = new Map();
    parsePluginEntries(pluginsValue).forEach((entry) => {
        const { pluginUUID, version } = parsePluginUUIDAndVersion(entry);
        if (!pluginUUID) {
            return;
        }
        // Keep one entry per plugin UUID per server; newest mention wins.
        latestVersionByUUID.set(pluginUUID, version);
    });

    return Array.from(latestVersionByUUID.entries())
        .map(([pluginUUID, version]) => `${pluginUUID}@${version}`)
        .join(",");
}

function normalizeStoredPluginEntries() {
    const rows = db.prepare("SELECT uuid, plugins FROM servers").all();
    const updateStmt = db.prepare("UPDATE servers SET plugins = ? WHERE uuid = ?");
    let normalizedRows = 0;

    rows.forEach((row) => {
        const current = typeof row.plugins === "string" ? row.plugins.trim() : "";
        const normalized = normalizePluginEntriesValue(current);
        if (normalized !== current) {
            updateStmt.run(normalized, row.uuid);
            normalizedRows += 1;
        }
    });

    if (normalizedRows > 0) {
        console.warn(`Normalized plugin entries for ${normalizedRows} servers (deduped plugin UUID/version entries).`);
    }
}

function getPluginUUIDsForServer(pluginsValue) {
    const uuids = new Set();
    parsePluginEntries(pluginsValue).forEach(entry => {
        const pluginUUID = parsePluginUUID(entry);
        if (pluginUUID) {
            uuids.add(pluginUUID);
        }
    });
    return uuids;
}

function getServerAliveTimeoutMinutes() {
    const parsed = Number.parseFloat(process.env.SERVER_ALIVE_TIMEOUT || "");
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    if (!getServerAliveTimeoutMinutes.warnedInvalid) {
        console.warn("SERVER_ALIVE_TIMEOUT is not set or invalid, defaulting to 10 minutes");
        getServerAliveTimeoutMinutes.warnedInvalid = true;
    }
    return 10;
}

// important function used to update data and clean up inactive servers
function checkInActiveServers() {
    const timeoutMinutes = getServerAliveTimeoutMinutes();
    const removeStmt = db.prepare("DELETE FROM servers WHERE last_updated < datetime('now', ?)");
    const removedServers = removeStmt.run(`-${timeoutMinutes} minutes`).changes;
    const removedByIpLimit = enforcePerIpActiveServerLimit();

    const servers = getGlobalCountableServerRows();
    const currentServers = servers.length;
    const currentPlayers = servers.reduce((sum, server) => sum + clampPlayerCount(server.players_online), 0);
    const pluginUsage = new Map();
    servers.forEach(server => {
        // enforce max contribution from any single server to protect history from spoofed values
        const playersOnline = clampPlayerCount(server.players_online);
        const pluginUUIDs = getPluginUUIDsForServer(server.plugins);
        pluginUUIDs.forEach(pluginUUID => {
            const existing = pluginUsage.get(pluginUUID) || { serversCount: 0, playersCount: 0 };
            existing.serversCount += 1;
            existing.playersCount += playersOnline;
            pluginUsage.set(pluginUUID, existing);
        });
    });

    pluginUsage.forEach((usage, pluginUUID) => {
        upsertPluginHourlyStats(pluginUUID, usage.serversCount, usage.playersCount);
    });

    // remove plugin stat data outside retention window
    prunePluginHourlyStats();
    upsertGlobalHourlyStats(currentServers, currentPlayers);
    updateGlobalAllTimePeaks(currentServers, currentPlayers);
    return removedServers + removedByIpLimit;
}

function upsertGlobalHourlyStats(serverCount, playerCount, hourStart = null) {
    const safeServerCount = Math.max(0, Number(serverCount) || 0);
    const safePlayerCount = Math.max(0, Number(playerCount) || 0);
    const bucket = toUtcHourString(hourStart);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO global_stats_hourly (hour_start, servers_count, players_count, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(hour_start) DO UPDATE SET
            servers_count = CASE
                WHEN excluded.servers_count > global_stats_hourly.servers_count
                THEN excluded.servers_count
                ELSE global_stats_hourly.servers_count
            END,
            players_count = CASE
                WHEN excluded.players_count > global_stats_hourly.players_count
                THEN excluded.players_count
                ELSE global_stats_hourly.players_count
            END,
            updated_at = CASE
                WHEN excluded.servers_count > global_stats_hourly.servers_count
                  OR excluded.players_count > global_stats_hourly.players_count
                THEN excluded.updated_at
                ELSE global_stats_hourly.updated_at
            END
    `).run(bucket, safeServerCount, safePlayerCount, now);
}

function updateGlobalAllTimePeaks(serverCount, playerCount, observedAt = new Date().toISOString()) {
    const safeServerCount = Math.max(0, Number(serverCount) || 0);
    const safePlayerCount = Math.max(0, Number(playerCount) || 0);
    const now = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
        UPDATE global_all_time_peaks
        SET
            peak_servers_count = CASE
                WHEN ? > peak_servers_count THEN ?
                ELSE peak_servers_count
            END,
            peak_servers_at = CASE
                WHEN ? > peak_servers_count THEN ?
                ELSE peak_servers_at
            END,
            peak_players_count = CASE
                WHEN ? > peak_players_count THEN ?
                ELSE peak_players_count
            END,
            peak_players_at = CASE
                WHEN ? > peak_players_count THEN ?
                ELSE peak_players_at
            END,
            updated_at = CASE
                WHEN ? > peak_servers_count OR ? > peak_players_count THEN ?
                ELSE updated_at
            END
        WHERE id = 1
    `);

    stmt.run(
        safeServerCount, safeServerCount,
        safeServerCount, observedAt,
        safePlayerCount, safePlayerCount,
        safePlayerCount, observedAt,
        safeServerCount, safePlayerCount, now
    );
}

function rebuildGlobalAllTimePeaks() {
    const topServers = db.prepare(`
        SELECT servers_count, hour_start
        FROM global_stats_hourly
        ORDER BY servers_count DESC, hour_start ASC
        LIMIT 1
    `).get();

    const topPlayers = db.prepare(`
        SELECT players_count, hour_start
        FROM global_stats_hourly
        ORDER BY players_count DESC, hour_start ASC
        LIMIT 1
    `).get();

    const now = Math.floor(Date.now() / 1000);
    const peakServersCount = toSafeNonNegativeInt(topServers?.servers_count || 0);
    const peakServersAt = topServers?.hour_start ? toUtcHourIsoString(topServers.hour_start) : null;
    const peakPlayersCount = toSafeNonNegativeInt(topPlayers?.players_count || 0);
    const peakPlayersAt = topPlayers?.hour_start ? toUtcHourIsoString(topPlayers.hour_start) : null;

    db.prepare(`
        UPDATE global_all_time_peaks
        SET
            peak_servers_count = ?,
            peak_servers_at = ?,
            peak_players_count = ?,
            peak_players_at = ?,
            updated_at = ?
        WHERE id = 1
    `).run(peakServersCount, peakServersAt, peakPlayersCount, peakPlayersAt, now);

    return getGlobalAllTimePeaks();
}

function setGlobalAllTimePeaksExact({
    serversCount,
    serversAt,
    playersCount,
    playersAt
} = {}) {
    const current = db.prepare(`
        SELECT
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at
        FROM global_all_time_peaks
        WHERE id = 1
    `).get() || {
        peak_servers_count: 0,
        peak_servers_at: null,
        peak_players_count: 0,
        peak_players_at: null
    };

    const toSafeInt = (value, fallback) => {
        if (value === undefined) {
            return Math.max(0, Number(fallback) || 0);
        }
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            return 0;
        }
        return Math.floor(numeric);
    };

    const nextServersCount = toSafeInt(serversCount, current.peak_servers_count);
    const nextPlayersCount = toSafeInt(playersCount, current.peak_players_count);
    const nextServersAt = serversAt === undefined ? (current.peak_servers_at || null) : (serversAt || null);
    const nextPlayersAt = playersAt === undefined ? (current.peak_players_at || null) : (playersAt || null);
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
        UPDATE global_all_time_peaks
        SET
            peak_servers_count = ?,
            peak_servers_at = ?,
            peak_players_count = ?,
            peak_players_at = ?,
            updated_at = ?
        WHERE id = 1
    `).run(nextServersCount, nextServersAt, nextPlayersCount, nextPlayersAt, now);

    return getGlobalAllTimePeaks();
}


function getTotalPlayersOnline() {
    const rows = getGlobalCountableServerRows();
    return rows.reduce((sum, row) => sum + clampPlayerCount(row.players_online), 0);
}

function getTotalServers() {
    return getGlobalCountableServerRows().length;
}

// Valid OS Names for statistics, this is for when there are not many
// servers using HStats so we dont get a huge list of random OS names
// if a OS has been used > 5 times, we allow it to be shown in stats, else
// its grouped under "Other"
function getAllOSNames() {
    let os = {};
    getGlobalCountableServerRows().forEach(row => {
        if (row.os_name && !(row.os_name in os)) {
            os[row.os_name] = 1;
        } else if (row.os_name) {
            os[row.os_name]++;
        }
    });

    // Filter out invalid OS names
    for (const name in os) {
        if (!VALID_OS_NAMES.includes(name) && os[name] < AMOUNT_NEEDED_TO_DISPLAY) {
            if (!("Other" in os)) {
                os["Other"] = 0;
            }
            os["Other"] += os[name];
            delete os[name];
        }
    }

    return os;
}

// Same idea for OS names
function getAllJavaVersions() {
    let versions = {};
    getGlobalCountableServerRows().forEach(row => {
        if (row.java_version && !(row.java_version in versions)) {
            versions[row.java_version] = 1;
        } else if (row.java_version) {
            versions[row.java_version]++;
        }
    });

    // Filter out invalid Java versions
    for (const version in versions) {
        if (!VALID_JAVA_VERSIONS.includes(version) && versions[version] < AMOUNT_NEEDED_TO_DISPLAY) {
            if (!("Other" in versions)) {
                versions["Other"] = 0;
            }
            versions["Other"] += versions[version];
            delete versions[version];
        }
    }

    return versions;
}

function getAllCountries() {
    let countries = {};
    getGlobalCountableServerRows().forEach(row => {
        if (row.country && !(row.country in countries)) {
            countries[row.country] = 1;
        } else if (row.country) {
            countries[row.country]++;
        }
    });

    // Filter out unknown/invalid countries with low counts
    for (const country in countries) {
        if (country === "Unknown" && countries[country] < AMOUNT_NEEDED_TO_DISPLAY) {
            if (!("Other" in countries)) {
                countries["Other"] = 0;
            }
            countries["Other"] += countries[country];
            delete countries[country];
        }
    }

    return countries;
}

function getCoreCounts() {
    let coreCounts = {};
    getGlobalCountableServerRows().forEach(row => {
        const cores = row.core_count || 0;
        if (cores < 0 || cores > 128) {
            return; // skip invalid core counts
        }

        if (!(cores in coreCounts)) {
            coreCounts[cores] = 1;
        } else {
            coreCounts[cores]++;
        }
    });
    return coreCounts;
}

function getServersUsingPlugin(pluginUUID) {
    if (!pluginUUID) {
        return [];
    }

    const stmt = db.prepare("SELECT * FROM servers WHERE plugins LIKE ?");
    const rows = stmt.all(`%${pluginUUID}%`);
    return rows
        .filter(row => getPluginUUIDsForServer(row.plugins).has(pluginUUID))
        .map(row => ({
            ...row,
            players_online: clampPlayerCount(row.players_online)
        }));
}

function removePluginFromAllServers(pluginUUID) {
    if (!pluginUUID || typeof pluginUUID !== "string") {
        return 0;
    }

    const rows = db.prepare("SELECT uuid, plugins FROM servers WHERE plugins LIKE ?").all(`%${pluginUUID}%`);
    const updateStmt = db.prepare("UPDATE servers SET plugins = ? WHERE uuid = ?");
    let changes = 0;

    rows.forEach((row) => {
        const filtered = parsePluginEntries(row.plugins)
            .filter((entry) => parsePluginUUID(entry) !== pluginUUID);
        const nextValue = filtered.join(",");
        if (nextValue !== (row.plugins || "")) {
            updateStmt.run(nextValue, row.uuid);
            changes += 1;
        }
    });

    return changes;
}

function getGlobalAllTimePeaks() {
    const row = db.prepare(`
        SELECT
            peak_servers_count,
            peak_servers_at,
            peak_players_count,
            peak_players_at
        FROM global_all_time_peaks
        WHERE id = 1
    `).get();

    return {
        servers: {
            count: row?.peak_servers_count || 0,
            at: row?.peak_servers_at || null
        },
        players: {
            count: row?.peak_players_count || 0,
            at: row?.peak_players_at || null
        }
    };
}

function getGlobalHourlyStats(fromHour, toHour) {
    const fromStr = toUtcHourString(fromHour, { allowDayOnly: true, dayAsEnd: false });
    const toStr = toUtcHourString(toHour, { allowDayOnly: true, dayAsEnd: true });

    const rows = db.prepare(`
        SELECT hour_start, servers_count, players_count
        FROM global_stats_hourly
        WHERE hour_start >= ? AND hour_start <= ?
        ORDER BY hour_start ASC
    `).all(fromStr, toStr);

    return rows.map((row) => ({
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

function getGlobalHourlyStatsLastDays(days = 30) {
    if (!Number.isInteger(days) || days < 1) {
        throw new Error("days must be an integer >= 1");
    }

    const rows = db.prepare(`
        SELECT hour_start, servers_count, players_count
        FROM global_stats_hourly
        WHERE hour_start >= datetime('now', ?)
        ORDER BY hour_start ASC
    `).all(`-${days} days`);

    return rows.map((row) => ({
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

function getGlobalHourlyStatsAll(limit = null) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("limit must be null or an integer >= 1");
    }

    const rows = limit === null
        ? db.prepare(`
            SELECT hour_start, servers_count, players_count
            FROM global_stats_hourly
            ORDER BY hour_start ASC
        `).all()
        : db.prepare(`
            SELECT hour_start, servers_count, players_count
            FROM global_stats_hourly
            ORDER BY hour_start DESC
            LIMIT ?
        `).all(limit).reverse();

    return rows.map((row) => ({
        hour_start: toUtcHourIsoString(row.hour_start),
        servers_count: row.servers_count,
        players_count: row.players_count
    }));
}

function repairGlobalHistory() {
    const rows = db.prepare(`
        SELECT hour_start, servers_count, players_count
        FROM global_stats_hourly
        ORDER BY hour_start ASC
    `).all();

    if (rows.length === 0) {
        const peaks = rebuildGlobalAllTimePeaks();
        return {
            rows_scanned: 0,
            rows_updated: 0,
            peaks,
            peak_rebuilt: true
        };
    }

    const smoothed = smoothHourlySpikeRows(rows);
    const updateStmt = db.prepare(`
        UPDATE global_stats_hourly
        SET servers_count = ?, players_count = ?, updated_at = ?
        WHERE hour_start = ?
    `);

    const now = Math.floor(Date.now() / 1000);
    let rowsUpdated = 0;

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
            updateStmt.run(nextServers, nextPlayers, now, before.hour_start);
            rowsUpdated += 1;
        }
    }

    const peaks = rebuildGlobalAllTimePeaks();
    return {
        rows_scanned: rows.length,
        rows_updated: rowsUpdated,
        peaks,
        peak_rebuilt: true
    };
}

function bootstrapGlobalAllTimePeaks() {
    const rows = getGlobalCountableServerRows();
    const playerCount = rows.reduce((sum, row) => sum + clampPlayerCount(row.players_online), 0);
    updateGlobalAllTimePeaks(rows.length, playerCount);
}

bootstrapGlobalAllTimePeaks();
upsertGlobalHourlyStats(getTotalServers(), getTotalPlayersOnline());

export {
    addOrUpdateServer,
    addPluginToServer,
    removeServer,
    getServer,
    getTotalPlayersOnline,
    getTotalServers,
    getAllOSNames,
    getAllJavaVersions,
    getAllCountries,
    checkInActiveServers,
    getCoreCounts,
    getServersUsingPlugin,
    getGlobalAllTimePeaks,
    repairGlobalHistory,
    setGlobalAllTimePeaksExact,
    removePluginFromAllServers,
    getGlobalHourlyStats,
    getGlobalHourlyStatsLastDays,
    getGlobalHourlyStatsAll
};
