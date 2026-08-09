import betterSQL from "better-sqlite3";
import crypto from "crypto";
import { configDotenv } from "dotenv";
configDotenv();

// Plugin Format: pluginUUID@version seperated by a comma (version is optional)
const db = betterSQL(process.env.PLUGIN_DB);
db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
        uuid TEXT PRIMARY KEY,
        public_uuid TEXT,
        versions TEXT,
        name TEXT,
        github_link TEXT DEFAULT '',
        curseforge_link TEXT DEFAULT '',
        modtale_link TEXT DEFAULT '',
        modifold_link TEXT DEFAULT '',
        is_unlisted INTEGER DEFAULT 0,
        last_private_uuid_refresh_at INTEGER DEFAULT 0,
        added_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

function isCanonicalUuid(value) {
    if (typeof value !== "string") {
        return false;
    }
    const uuid = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
}

function isAnyPluginUuidTaken(candidateUuid, { excludePrivateUuid = null } = {}) {
    const normalized = typeof candidateUuid === "string" ? candidateUuid.trim() : "";
    if (!isCanonicalUuid(normalized)) {
        return false;
    }

    const privateMatch = db.prepare(`
        SELECT uuid
        FROM plugins
        WHERE uuid = ?
          AND (? IS NULL OR uuid <> ?)
        LIMIT 1
    `).get(normalized, excludePrivateUuid, excludePrivateUuid);

    if (privateMatch) {
        return true;
    }

    const publicMatch = db.prepare(`
        SELECT uuid
        FROM plugins
        WHERE public_uuid = ?
        LIMIT 1
    `).get(normalized);

    return !!publicMatch;
}

function generateUniquePublicUUID(existing = new Set()) {
    let candidate = crypto.randomUUID();
    while (existing.has(candidate) || isAnyPluginUuidTaken(candidate)) {
        candidate = crypto.randomUUID();
    }
    return candidate;
}

function normalizePublicUuids() {
    const rows = db.prepare("SELECT uuid, public_uuid FROM plugins").all();
    const updateStmt = db.prepare("UPDATE plugins SET public_uuid = ? WHERE uuid = ?");
    const used = new Set();

    rows.forEach((row) => {
        const normalized = typeof row.public_uuid === "string" ? row.public_uuid.trim() : "";
        if (isCanonicalUuid(normalized) && !used.has(normalized)) {
            used.add(normalized);
            return;
        }
        const nextPublicUuid = generateUniquePublicUUID(used);
        used.add(nextPublicUuid);
        updateStmt.run(nextPublicUuid, row.uuid);
    });
}

ensureColumn("plugins", "public_uuid", "TEXT");
ensureColumn("plugins", "github_link", "TEXT DEFAULT ''");
ensureColumn("plugins", "curseforge_link", "TEXT DEFAULT ''");
ensureColumn("plugins", "modtale_link", "TEXT DEFAULT ''");
ensureColumn("plugins", "modifold_link", "TEXT DEFAULT ''");
ensureColumn("plugins", "is_unlisted", "INTEGER DEFAULT 0");
ensureColumn("plugins", "last_private_uuid_refresh_at", "INTEGER DEFAULT 0");
normalizePublicUuids();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_public_uuid ON plugins(public_uuid)");

function resolvePublicUuid(requestedPublicUuid, existingPrivateUuid = null) {
    const normalized = typeof requestedPublicUuid === "string" ? requestedPublicUuid.trim() : "";
    if (isCanonicalUuid(normalized)) {
        const existing = db.prepare("SELECT uuid FROM plugins WHERE public_uuid = ?").get(normalized);
        if (!existing || existing.uuid === existingPrivateUuid) {
            return normalized;
        }
    }
    return generateUniquePublicUUID();
}

function addOrUpdatePlugin(uuid, name, publicUuid = null) {
    const getStmt = db.prepare("SELECT * FROM plugins WHERE uuid = ?");
    const row = getStmt.get(uuid);
    if (row) {
        const updatedVersions = typeof row.versions === "string" ? row.versions : "";
        const resolvedPublicUuid = resolvePublicUuid(publicUuid || row.public_uuid, uuid);
        const updateStmt = db.prepare("UPDATE plugins SET versions = ?, name = ?, public_uuid = ? WHERE uuid = ?");
        updateStmt.run(updatedVersions, name, resolvedPublicUuid, uuid);
    } else {
        const resolvedPublicUuid = resolvePublicUuid(publicUuid, null);
        const insertStmt = db.prepare("INSERT INTO plugins (uuid, public_uuid, versions, name) VALUES (?, ?, ?, ?)");
        insertStmt.run(uuid, resolvedPublicUuid, "", name);
    }
}

function getListOfPlugins(searchTerm = "", maxResults = 51, page = 1) {
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

function getPluginByPublicUUID(publicUuid) {
    const normalized = typeof publicUuid === "string" ? publicUuid.trim() : "";
    if (!isCanonicalUuid(normalized)) {
        return undefined;
    }
    const stmt = db.prepare("SELECT * FROM plugins WHERE public_uuid = ?");
    return stmt.get(normalized);
}

function getPluginByAnyUUID(uuid) {
    const byPrivate = getPlugin(uuid);
    if (byPrivate) {
        return byPrivate;
    }
    return getPluginByPublicUUID(uuid);
}

function toPublicPlugin(pluginRow, { includePrivate = false } = {}) {
    if (!pluginRow) {
        return null;
    }

    const publicUuid = isCanonicalUuid(pluginRow.public_uuid) ? pluginRow.public_uuid : pluginRow.uuid;
    const mapped = {
        ...pluginRow,
        uuid: publicUuid,
        public_uuid: publicUuid,
        is_unlisted: Number(pluginRow.is_unlisted) === 1,
        github_link: pluginRow.github_link || "",
        curseforge_link: pluginRow.curseforge_link || "",
        modtale_link: pluginRow.modtale_link || "",
        modifold_link: pluginRow.modifold_link || ""
    };
    if (includePrivate) {
        mapped.private_uuid = pluginRow.uuid;
    } else {
        delete mapped.private_uuid;
    }
    return mapped;
}

function setPluginLinks(privateUuid, { githubLink, curseforgeLink, modtaleLink, modifoldLink } = {}) {
    const current = getPlugin(privateUuid);
    if (!current) {
        return null;
    }

    const nextGithub = githubLink === undefined
        ? (current.github_link || "")
        : (githubLink || "");
    const nextCurseforge = curseforgeLink === undefined
        ? (current.curseforge_link || "")
        : (curseforgeLink || "");
    const nextModtale = modtaleLink === undefined
        ? (current.modtale_link || "")
        : (modtaleLink || "");
    const nextModifold = modifoldLink === undefined
        ? (current.modifold_link || "")
        : (modifoldLink || "");

    db.prepare("UPDATE plugins SET github_link = ?, curseforge_link = ?, modtale_link = ?, modifold_link = ? WHERE uuid = ?")
        .run(nextGithub, nextCurseforge, nextModtale, nextModifold, privateUuid);

    return getPlugin(privateUuid);
}

function setPluginName(privateUuid, name) {
    const current = getPlugin(privateUuid);
    if (!current) {
        return null;
    }

    db.prepare("UPDATE plugins SET name = ? WHERE uuid = ?")
        .run(name, privateUuid);

    return getPlugin(privateUuid);
}

function setPluginVisibility(privateUuid, isUnlisted) {
    const current = getPlugin(privateUuid);
    if (!current) {
        return null;
    }

    db.prepare("UPDATE plugins SET is_unlisted = ? WHERE uuid = ?")
        .run(isUnlisted ? 1 : 0, privateUuid);

    return getPlugin(privateUuid);
}

function rotatePluginPrivateUuid(oldPrivateUuid, newPrivateUuid, refreshedAt) {
    const current = getPlugin(oldPrivateUuid);
    if (!current) {
        return null;
    }

    const normalizedNewPrivateUuid = typeof newPrivateUuid === "string" ? newPrivateUuid.trim() : "";
    if (!isCanonicalUuid(normalizedNewPrivateUuid)) {
        throw new Error("newPrivateUuid must be a valid UUID");
    }
    if (normalizedNewPrivateUuid !== oldPrivateUuid && isAnyPluginUuidTaken(normalizedNewPrivateUuid, { excludePrivateUuid: oldPrivateUuid })) {
        throw new Error("newPrivateUuid is already taken");
    }

    const refreshTimestamp = Number.isInteger(refreshedAt) && refreshedAt >= 0 ? refreshedAt : Math.floor(Date.now() / 1000);
    db.prepare(`
        UPDATE plugins
        SET uuid = ?, last_private_uuid_refresh_at = ?
        WHERE uuid = ?
    `).run(normalizedNewPrivateUuid, refreshTimestamp, oldPrivateUuid);

    return getPlugin(normalizedNewPrivateUuid);
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
    getPluginByPublicUUID,
    getPluginByAnyUUID,
    isAnyPluginUuidTaken,
    toPublicPlugin,
    setPluginLinks,
    setPluginName,
    setPluginVisibility,
    rotatePluginPrivateUuid,
    getTotalPlugins,
    getListOfPlugins,
    getAllPlugins
}
