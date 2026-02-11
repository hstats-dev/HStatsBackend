import betterSQL from "better-sqlite3";
import crypto from "crypto";
import { configDotenv } from "dotenv";
configDotenv();

const db = betterSQL(process.env.ACCOUNTS_DB);

db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email_enc TEXT,
        email_hash TEXT UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        plugin_access TEXT DEFAULT '',
        is_disabled INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        last_login INTEGER,
        github_link TEXT DEFAULT '',
        curseforge_link TEXT DEFAULT ''
    );
`);

function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (!columns.includes(column)) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
}

ensureColumn("accounts", "plugin_access", "TEXT DEFAULT ''");
ensureColumn("accounts", "github_link", "TEXT");
ensureColumn("accounts", "curseforge_link", "TEXT");

function getEnvKey(name, bytes) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    let buf = null;
    if (/^[0-9a-fA-F]+$/.test(value) && value.length === bytes * 2) {
        buf = Buffer.from(value, "hex");
    } else {
        buf = Buffer.from(value, "base64");
    }
    if (buf.length !== bytes) {
        throw new Error(`Invalid ${name} length, expected ${bytes} bytes`);
    }
    return buf;
}

const ENC_KEY = getEnvKey("ACCOUNT_DATA_KEY", 32);
const HMAC_KEY = getEnvKey("ACCOUNT_DATA_HMAC_KEY", 32);
const PASSWORD_PEPPER = process.env.ACCOUNT_PASSWORD_PEPPER || "";
const SESSION_TTL_DAYS = parseInt(process.env.ACCOUNT_SESSION_TTL_DAYS || "14", 10);

function normalizeEmail(email) {
    return email.trim().toLowerCase();
}

function hmacLookup(value) {
    return crypto.createHmac("sha256", HMAC_KEY).update(value).digest("hex");
}

function encryptString(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptString(payload) {
    const data = Buffer.from(payload, "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password + PASSWORD_PEPPER, salt, 64).toString("hex");
}

function safeEqual(a, b) {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function createAccount({ email, password }) {
    const emailNorm = normalizeEmail(email);
    const emailHash = hmacLookup(emailNorm);

    const existing = db.prepare("SELECT id FROM accounts WHERE email_hash = ?").get(emailHash);
    if (existing) {
        return { error: "Account already exists" };
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    const insertStmt = db.prepare(`
        INSERT INTO accounts (id, email_enc, email_hash, password_hash, password_salt, plugin_access, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(id, encryptString(emailNorm), emailHash, passwordHash, salt, "", now, now);

    return getAccountById(id);
}

function addPluginToUser(accountId, pluginUUID) {
    const row = db.prepare("SELECT plugin_access FROM accounts WHERE id = ?").get(accountId);
    let access = row.plugin_access ? row.plugin_access.split(",") : [];
    if (!access.includes(pluginUUID)) {
        access.push(pluginUUID);
        const updatedAccess = access.join(",");
        const updateStmt = db.prepare("UPDATE accounts SET plugin_access = ? WHERE id = ?");
        updateStmt.run(updatedAccess, accountId);
    }
}

function getPluginsAccess(accountId) {
    const row = db.prepare("SELECT plugin_access FROM accounts WHERE id = ?").get(accountId);
    if (!row || !row.plugin_access) {
        return [];
    }
    return row.plugin_access.split(",");
}

function setGithubLink(accountId, githubLink) {
    const updateStmt = db.prepare("UPDATE accounts SET github_link = ? WHERE id = ?");
    updateStmt.run(githubLink, accountId);
}

function setCurseforgeLink(accountId, curseforgeLink) {
    const updateStmt = db.prepare("UPDATE accounts SET curseforge_link = ? WHERE id = ?");
    updateStmt.run(curseforgeLink, accountId);
}

function getAccountThatOwnsPlugin(pluginUUID) {
    const stmt = db.prepare("SELECT * FROM accounts WHERE plugin_access LIKE ?");
    const likePattern = `%${pluginUUID}%`;
    return stmt.get(likePattern);
}

function getAccountById(id) {
    return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function getAccountByEmail(email) {
    const emailHash = hmacLookup(normalizeEmail(email));
    return db.prepare("SELECT * FROM accounts WHERE email_hash = ?").get(emailHash);
}

function verifyPassword(accountRow, password) {
    const hash = hashPassword(password, accountRow.password_salt);
    return safeEqual(hash, accountRow.password_hash);
}

function updatePassword(accountId, newPassword) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(newPassword, salt);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE accounts SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, salt, now, accountId);
}

function getTotalAccounts() {
    const row = db.prepare("SELECT COUNT(*) AS count FROM accounts").get();
    return row ? row.count : 0;
}

function getSessionMaxAgeMs() {
    return SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function touchLastLogin(accountId) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE accounts SET last_login = ?, updated_at = ? WHERE id = ?").run(now, now, accountId);
}

function toSafeAccount(accountRow) {
    if (!accountRow)
        return null;
    return {
        id: accountRow.id,
        email: accountRow.email_enc ? decryptString(accountRow.email_enc) : "",
        plugin_access: accountRow.plugin_access,
        created_at: accountRow.created_at,
        updated_at: accountRow.updated_at,
        last_login: accountRow.last_login,
        github_link: accountRow.github_link || "",
        curseforge_link: accountRow.curseforge_link || ""
    };
}

function toPublicAccount(accountRow) {
    if (!accountRow)
        return null;
    return {
        id: accountRow.id,
        github_link: accountRow.github_link || "",
        curseforge_link: accountRow.curseforge_link || ""
    };
}

export {
    createAccount,
    addPluginToUser,
    getAccountById,
    getAccountByEmail,
    verifyPassword,
    updatePassword,
    getSessionMaxAgeMs,
    touchLastLogin,
    getTotalAccounts,
    toSafeAccount,
    toPublicAccount,
    getPluginsAccess,
    setGithubLink,
    setCurseforgeLink,
    getAccountThatOwnsPlugin
};
