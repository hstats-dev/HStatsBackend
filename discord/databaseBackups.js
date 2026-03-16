import betterSQL from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDotenv } from "dotenv";

configDotenv();

const WEBHOOK_MAX_FILES_PER_MESSAGE = 10;
const WEBHOOK_UPLOAD_TIMEOUT_MS = (() => {
    const raw = process.env.DISCORD_BACKUP_WEBHOOK_TIMEOUT_MS;
    const parsed = Number.parseInt(String(raw || ""), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
})();

function resolvePathFromProject(relativeOrAbsolutePath) {
    if (typeof relativeOrAbsolutePath !== "string" || !relativeOrAbsolutePath.trim()) {
        return "";
    }

    return path.isAbsolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : path.resolve(process.cwd(), relativeOrAbsolutePath);
}

function getTimestampSlug(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-");
}

function getDatabaseSources() {
    return [
        {
            name: "accounts",
            sourcePath: resolvePathFromProject(process.env.ACCOUNTS_DB),
            required: true
        },
        {
            name: "plugins",
            sourcePath: resolvePathFromProject(process.env.PLUGIN_DB),
            required: true
        },
        {
            name: "servers",
            sourcePath: resolvePathFromProject(process.env.SERVERS_DB),
            required: true
        },
        {
            name: "plugin_stats",
            sourcePath: resolvePathFromProject(process.env.PLUGIN_STATS_DB),
            required: true
        },
        {
            name: "sessions",
            sourcePath: path.resolve(
                process.cwd(),
                process.env.SESSIONS_DIR || "databases",
                "sessions.db"
            ),
            required: false
        }
    ];
}

async function backupSingleDatabase(sourcePath, destinationPath) {
    const sourceDb = betterSQL(sourcePath, { fileMustExist: true });
    try {
        await sourceDb.backup(destinationPath);
    } finally {
        sourceDb.close();
    }
}

async function createDatabaseBackupFiles(reason = "manual") {
    const timestampSlug = getTimestampSlug();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hstats-db-backup-"));
    const backupDir = path.join(tempRoot, timestampSlug);
    try {
        fs.mkdirSync(backupDir, { recursive: true });

        const createdFiles = [];
        const skipped = [];

        for (const source of getDatabaseSources()) {
            if (!source.sourcePath) {
                if (source.required) {
                    throw new Error(`Missing configured path for ${source.name} database`);
                }
                skipped.push({
                    name: source.name,
                    reason: "missing_path"
                });
                continue;
            }

            if (!fs.existsSync(source.sourcePath)) {
                if (source.required) {
                    throw new Error(`Database file not found: ${source.sourcePath}`);
                }
                skipped.push({
                    name: source.name,
                    reason: "missing_file"
                });
                continue;
            }

            const filename = `${source.name}-${timestampSlug}.sqlite`;
            const destinationPath = path.join(backupDir, filename);
            await backupSingleDatabase(source.sourcePath, destinationPath);
            const stats = fs.statSync(destinationPath);
            createdFiles.push({
                name: source.name,
                filename,
                path: destinationPath,
                sizeBytes: stats.size
            });
        }

        return {
            reason,
            timestamp: new Date().toISOString(),
            tempRoot,
            backupDir,
            files: createdFiles,
            skipped
        };
    } catch (error) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        throw error;
    }
}

async function postBackupBatch(webhookUrl, content, files) {
    const form = new FormData();
    form.append("content", content);

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const buffer = fs.readFileSync(file.path);
        form.append(`files[${index}]`, new Blob([buffer]), file.filename);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), WEBHOOK_UPLOAD_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(webhookUrl, {
            method: "POST",
            body: form,
            signal: abortController.signal
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Webhook upload timed out after ${WEBHOOK_UPLOAD_TIMEOUT_MS}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Webhook upload failed with ${response.status}${bodyText ? `: ${bodyText}` : ""}`);
    }
}

async function uploadDatabaseBackupsToWebhook(backupResult, webhookUrl, {
    reason = backupResult.reason || "manual"
} = {}) {
    const trimmedWebhookUrl = typeof webhookUrl === "string" ? webhookUrl.trim() : "";
    if (!trimmedWebhookUrl) {
        throw new Error("DISCORD_BACKUP_WEBHOOK is not configured");
    }

    const batches = [];
    for (let index = 0; index < backupResult.files.length; index += WEBHOOK_MAX_FILES_PER_MESSAGE) {
        batches.push(backupResult.files.slice(index, index + WEBHOOK_MAX_FILES_PER_MESSAGE));
    }

    const skippedText = backupResult.skipped.length > 0
        ? ` | skipped=${backupResult.skipped.map((entry) => `${entry.name}:${entry.reason}`).join(",")}`
        : "";

    for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const content = [
            `HStats database backup`,
            `reason=${reason}`,
            `timestamp=${backupResult.timestamp}`,
            `batch=${index + 1}/${batches.length}`,
            skippedText ? skippedText.slice(3) : null
        ].filter(Boolean).join(" | ");

        await postBackupBatch(trimmedWebhookUrl, content, batch);
    }
}

function cleanupDatabaseBackupFiles(backupResult) {
    if (!backupResult?.tempRoot) {
        return;
    }
    fs.rmSync(backupResult.tempRoot, { recursive: true, force: true });
}

async function createAndUploadDatabaseBackups({
    webhookUrl = process.env.DISCORD_BACKUP_WEBHOOK,
    reason = "manual"
} = {}) {
    const backupResult = await createDatabaseBackupFiles(reason);
    try {
        await uploadDatabaseBackupsToWebhook(backupResult, webhookUrl, { reason });
        return backupResult;
    } finally {
        cleanupDatabaseBackupFiles(backupResult);
    }
}

export {
    cleanupDatabaseBackupFiles,
    createAndUploadDatabaseBackups,
    createDatabaseBackupFiles,
    uploadDatabaseBackupsToWebhook
};
