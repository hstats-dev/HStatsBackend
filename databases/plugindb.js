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
        added_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

function addOrUpdatePlugin(uuid, name) {
    const getStmt = db.prepare("SELECT * FROM plugins WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        const updatedVersions = typeof row.versions === "string" ? row.versions : "";
        const updateStmt = db.prepare("UPDATE plugins SET versions = ?, name = ? WHERE uuid = ?");
        updateStmt.run(updatedVersions, name, uuid);
    } else {
        const insertStmt = db.prepare("INSERT INTO plugins (uuid, versions, name) VALUES (?, ?, ?)");
        insertStmt.run(uuid, "", name);
    }
}

function getListOfPlugins(searchTerm = "") {
    let stmt;
    if (searchTerm) {
        stmt = db.prepare("SELECT * FROM plugins WHERE name LIKE ? ORDER BY added_on DESC");
        return stmt.all(`%${searchTerm}%`);
    } else {
        stmt = db.prepare("SELECT * FROM plugins ORDER BY added_on DESC");
        return stmt.all();
    }
}

function deletePlugin(uuid) {
    const deleteStmt = db.prepare("DELETE FROM plugins WHERE uuid = ?");
    deleteStmt.run(uuid);
}

function getPlugin(uuid) {
    const stmt = db.prepare("SELECT * FROM plugins WHERE uuid = ?");
    return stmt.get(uuid);
}

function getTotalPlugins() {
    const row = db.prepare("SELECT COUNT(*) AS count FROM plugins").get();
    return row ? row.count : 0;
}

export {
    addOrUpdatePlugin,
    deletePlugin,
    getPlugin,
    getTotalPlugins,
    getListOfPlugins
}
