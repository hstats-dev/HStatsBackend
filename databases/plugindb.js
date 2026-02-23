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

function getListOfPlugins(searchTerm = "", maxResults = 50, page = 1) {
    let stmt;
    if (searchTerm) {
        stmt = db.prepare("SELECT * FROM plugins WHERE name LIKE ? ORDER BY added_on DESC LIMIT ? OFFSET ?");
        return stmt.all(`%${searchTerm}%`, maxResults, (page - 1) * maxResults);
    } else {
        stmt = db.prepare("SELECT * FROM plugins ORDER BY added_on DESC LIMIT ? OFFSET ?");
        return stmt.all(maxResults, (page - 1) * maxResults);
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

function getTotalPlugins(searchTerm = "") {
    if (searchTerm) {
        const row = db.prepare("SELECT COUNT(*) AS count FROM plugins WHERE name LIKE ?").get(`%${searchTerm}%`);
        return row ? row.count : 0;
    }

    const row = db.prepare("SELECT COUNT(*) AS count FROM plugins").get();
    return row ? row.count : 0;
}

function getAllPlugins(searchTerm = "") {
    if (searchTerm) {
        const stmt = db.prepare("SELECT * FROM plugins WHERE name LIKE ? ORDER BY added_on DESC");
        return stmt.all(`%${searchTerm}%`);
    }

    const stmt = db.prepare("SELECT * FROM plugins ORDER BY added_on DESC");
    return stmt.all();
}

export {
    addOrUpdatePlugin,
    deletePlugin,
    getPlugin,
    getTotalPlugins,
    getListOfPlugins,
    getAllPlugins
}
