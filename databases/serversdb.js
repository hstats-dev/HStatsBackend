import betterSQL from "better-sqlite3";
import axios from "axios";
import { configDotenv } from "dotenv";
import { prunePluginDailyStats, upsertPluginDailyStats } from "./pluginstatsdb.js";
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

// Initial request to add an online server
async function addOrUpdateServer(uuid, ip, playerCount, osName = "", osVersion = "", javaVersion = "", coreCount = 0) {
    const getStmt = db.prepare("SELECT * FROM servers WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        const updateStmt = db.prepare("UPDATE servers SET players_online = ?, last_updated = CURRENT_TIMESTAMP WHERE uuid = ?");
        return updateStmt.run(playerCount, uuid).changes > 0;
    }

    let country = "Unknown";
    await axios.get(`https://api.ipgeolocation.io/v2/ipgeo?apiKey=${process.env.IP_API_KEY}&ip=${ip}`)
        .then(response => {
            country = response.data.location.country_code2 || "Unknown";
        })
        .catch(error => {
            console.warn("Error fetching geolocation data for server (" + error?.response?.data?.message + ") Using 'Unknown' as country.");
        }).finally(() => {
            console.log(`Adding new server: ${uuid} with IP: ${ip} (${country})`);
            const insertStmt = db.prepare("INSERT INTO servers (uuid, players_online, os_name, os_version, java_version, core_count, country) VALUES (?, ?, ?, ?, ?, ?, ?)");
            insertStmt.run(uuid, playerCount, osName, osVersion, javaVersion, coreCount, country);
        });
    return true;
}

// Add a plugin to the server's list of plugins, this is called when a server starts
// incase each plugin is using HStats
function addPluginToServer(uuid, pluginUUID, version = "Unknown") {
    const getStmt = db.prepare("SELECT plugins FROM servers WHERE uuid = ?");
    const row = getStmt.get(uuid);
    let plugins = row ? row.plugins ? row.plugins.split(",") : [] : [];
    if (!plugins.includes(pluginUUID + (version ? `@${version}` : ""))) {
        plugins.push(pluginUUID + (version ? `@${version}` : ""));
        const updatedPlugins = plugins.join(",");
        const updateStmt = db.prepare("UPDATE servers SET plugins = ? WHERE uuid = ?");
        const result = updateStmt.run(updatedPlugins, uuid);
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
    const pluginUsage = new Map();
    servers.forEach(server => {
        const playersOnline = Number(server.players_online) || 0;
        const pluginUUIDs = getPluginUUIDsForServer(server.plugins);
        pluginUUIDs.forEach(pluginUUID => {
            const existing = pluginUsage.get(pluginUUID) || { serversCount: 0, playersCount: 0 };
            existing.serversCount += 1;
            existing.playersCount += playersOnline;
            pluginUsage.set(pluginUUID, existing);
        });
    });

    pluginUsage.forEach((usage, pluginUUID) => {
        upsertPluginDailyStats(pluginUUID, usage.serversCount, usage.playersCount);
    });

    // remove plugin stat data thats older than 90d
    prunePluginDailyStats();
    return removedServers;
}


function getTotalPlayersOnline() {
    const stmt = db.prepare("SELECT SUM(players_online) as total FROM servers");
    const row = stmt.get();
    return row.total ?? 0;
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
const validOSNames = ["Windows 10", "Windows 11", "Windows 95", "Windows 98", "Windows ME", "Windows NT", "Windows 2000", "Windows XP", "Windows 2003", "Windows CE", "Windows Vista", "Windows 7", "Windows 8", "Windows 8.1", "Linux", "macOS"];
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
        if (!validOSNames.includes(name) && os[name] < 5) {
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
const validJavaVersions = ["8", "11", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"];
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
        if (!validJavaVersions.includes(version) && versions[version] < 5) {
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
    return countries;
}

function getServersUsingPlugin(pluginUUID) {
    if (!pluginUUID) {
        return [];
    }

    const stmt = db.prepare("SELECT * FROM servers WHERE plugins LIKE ?");
    const rows = stmt.all(`%${pluginUUID}%`);
    return rows.filter(row => getPluginUUIDsForServer(row.plugins).has(pluginUUID));
}

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
    getServersUsingPlugin
};
