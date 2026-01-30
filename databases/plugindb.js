import betterSQL from "better-sqlite3";
import { configDotenv } from "dotenv";
configDotenv();

// Plugin Format: pluginUUID@version seperated by a comma (version is optional)
const db = betterSQL(process.env.PLUGIN_DB);
db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
        uuid TEXT PRIMARY KEY,
        versions TEXT,
        name TEXT,
        server_count INTEGER,
        player_count INTEGER,
        added_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

function addOrUpdatePlugin(uuid, name, version) {
    const getStmt = db.prepare("SELECT * FROM plugins WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        let versions = row.versions ? row.versions.split(",") : [];
        if (!versions.includes(version)) {
            versions.push(version);
        }
        const updatedVersions = versions.join(",");
        const updateStmt = db.prepare("UPDATE plugins SET versions = ?, name = ? WHERE uuid = ?");
        updateStmt.run(updatedVersions, name, uuid);
    } else {
        const insertStmt = db.prepare("INSERT INTO plugins (uuid, versions, name, server_count, player_count) VALUES (?, ?, ?, 0, 0)");
        insertStmt.run(uuid, version, name);
    }
}

function getPlugin(uuid) {
    const stmt = db.prepare("SELECT * FROM plugins WHERE uuid = ?");
    return stmt.get(uuid);
}

export {
    addOrUpdatePlugin,
    getPlugin
}