import betterSQL from "better-sqlite3";
import axios from "axios";
import { configDotenv } from "dotenv";
import { prunePluginHourlyStats, upsertPluginHourlyStats } from "./pluginstatsdb.js";
import { MAX_PLAYERS_ONLINE_PER_SERVER, VALID_JAVA_VERSIONS, VALID_OS_NAMES, AMOUNT_NEEDED_TO_DISPLAY } from "../config.js";
configDotenv();

// Plugin Format: pluginUUID@version (version is optional)
const db = betterSQL(process.env.SERVERS_DB);

db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
        uuid TEXT PRIMARY KEY,
        players_online INTEGER,
        plugins TEXT,
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

normalizeStoredPlayerCounts();
normalizeStoredPluginEntries();

// Initial request to add an online server
async function addOrUpdateServer(uuid, ip, playerCount, osName = "", osVersion = "", javaVersion = "", coreCount = 0) {
    const safePlayerCount = parsePlayerCountStrict(playerCount);

    const getStmt = db.prepare("SELECT * FROM servers WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        const updateStmt = db.prepare("UPDATE servers SET players_online = ?, last_updated = CURRENT_TIMESTAMP WHERE uuid = ?");
        return updateStmt.run(safePlayerCount, uuid).changes > 0;
    }

    let country = "Unknown";
    await axios.get(`http://ip-api.com/json/${ip}?fields=49154`)
        .then(response => {
            country = response.data.countryCode || "Unknown";
        })
        .catch(error => {
            console.warn("Error fetching geolocation data for server (" + error?.response?.data?.message + ") Using 'Unknown' as country.");
        }).finally(() => {
            console.log(`Adding new server: ${uuid} with IP: ${ip} (${country})`);
            const insertStmt = db.prepare("INSERT INTO servers (uuid, players_online, os_name, os_version, java_version, core_count, country) VALUES (?, ?, ?, ?, ?, ?, ?)");
            insertStmt.run(uuid, safePlayerCount, osName, osVersion, javaVersion, coreCount, country);
        });
    return true;
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

        // Duplicate entry for same plugin UUID; drop it.
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
    console.warn("SERVER_ALIVE_TIMEOUT is not set or invalid, defaulting to 10 minutes");
    return 10;
}

// important function used to update data and clean up inactive servers
function checkInActiveServers() {
    const timeoutMinutes = getServerAliveTimeoutMinutes();
    const removeStmt = db.prepare("DELETE FROM servers WHERE last_updated < datetime('now', ?)");
    const removedServers = removeStmt.run(`-${timeoutMinutes} minutes`).changes;

    const servers = db.prepare("SELECT players_online, plugins FROM servers").all();
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
    updateGlobalAllTimePeaks(currentServers, currentPlayers);
    return removedServers;
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


function getTotalPlayersOnline() {
    const rows = db.prepare("SELECT players_online FROM servers").all();
    return rows.reduce((sum, row) => sum + clampPlayerCount(row.players_online), 0);
}

function getTotalServers() {
    const stmt = db.prepare("SELECT COUNT(*) as total FROM servers");
    const row = stmt.get();
    return row.total || 0;
}

// Valid OS Names for statistics, this is for when there are not many
// servers using HStats so we dont get a huge list of random OS names
// if a OS has been used > 5 times, we allow it to be shown in stats, else
// its grouped under "Other"
function getAllOSNames() {
    let os = {};
    const stmt = db.prepare("SELECT os_name FROM servers");
    stmt.all().forEach(row => {
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
    const stmt = db.prepare("SELECT java_version FROM servers");
    stmt.all().forEach(row => {
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
    const stmt = db.prepare("SELECT country FROM servers");
    stmt.all().forEach(row => {
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
    const stmt = db.prepare("SELECT core_count FROM servers");
    stmt.all().forEach(row => {
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

function bootstrapGlobalAllTimePeaks() {
    const timeoutMinutes = getServerAliveTimeoutMinutes();
    const rows = db.prepare("SELECT players_online FROM servers WHERE last_updated >= datetime('now', ?)").all(`-${timeoutMinutes} minutes`);
    const playerCount = rows.reduce((sum, row) => sum + clampPlayerCount(row.players_online), 0);
    updateGlobalAllTimePeaks(rows.length, playerCount);
}

bootstrapGlobalAllTimePeaks();

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
    getGlobalAllTimePeaks
};
