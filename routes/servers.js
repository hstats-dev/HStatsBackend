import express from 'express';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { addOrUpdateServer, addPluginToServer, getServer } from '../databases/serversdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { getPlugin } from '../databases/plugindb.js';
import { serverIngestIpRateLimiter, serverIngestRateLimiter } from '../middleware/rateLimiters.js';
import { MAX_PLAYERS_ONLINE_PER_SERVER } from '../config.js';
import { queueSecurityAlert } from '../utils/siteSecurityAlerts.js';

const router = express.Router();
const badwords = new BadWordsNext({ data: en });

function resolveRequestIp(req) {
    const candidates = [
        req.ip,
        req.socket?.remoteAddress
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }

    return "";
}

function stripPluginEntryDelimiters(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[,@]/g, "").trim();
}

function formatPluginEntriesForAlert(pluginsValue) {
    if (typeof pluginsValue !== "string" || !pluginsValue.trim()) {
        return "none";
    }

    return pluginsValue
        .split(",")
        .map((entryRaw) => String(entryRaw || "").trim())
        .filter(Boolean)
        .map((entry) => {
            const [pluginUuidRaw, pluginVersionRaw] = entry.split("@");
            const pluginUuid = String(pluginUuidRaw || "").trim();
            const pluginVersion = String(pluginVersionRaw || "").trim() || "Unknown";
            const plugin = pluginUuid ? getPlugin(pluginUuid) : null;
            const pluginLabel = plugin?.name ? `${plugin.name} (${pluginUuid})` : (pluginUuid || "unknown");
            return `${pluginLabel} @ ${pluginVersion}`;
        })
        .join("\n");
}

function parseStrictNonNegativeInt(value) {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            return null;
        }
        return value;
    }

    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed)) {
        return null;
    }
    return parsed;
}

function isCanonicalUuid(value) {
    if (typeof value !== "string") {
        return false;
    }
    const uuid = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

// Endpoint to add a new server, this is called when a server first comes online
router.post("/update-server", serverIngestIpRateLimiter, serverIngestRateLimiter, async (req, res) => {
    if (!req.body.server_uuid || !isCanonicalUuid(req.body.server_uuid))
        return res.status(400).json({ error: "server_uuid must be a valid UUID" });
    const playersOnline = parseStrictNonNegativeInt(req.body.players_online);
    if (playersOnline === null || playersOnline > MAX_PLAYERS_ONLINE_PER_SERVER) {
        const attemptedPlayers = typeof req.body?.players_online === "string" || typeof req.body?.players_online === "number"
            ? String(req.body.players_online)
            : "invalid";
        if (/^\d+$/.test(attemptedPlayers) && Number.parseInt(attemptedPlayers, 10) > MAX_PLAYERS_ONLINE_PER_SERVER) {
            const existingServer = getServer(req.body.server_uuid);
            queueSecurityAlert({
                title: "Rejected Over-Max Player Count",
                description: "A server heartbeat tried to submit a player count above the configured per-server maximum.",
                severity: "high",
                dedupeKey: `update-server-over-max:${req.body.server_uuid}`,
                fields: [
                    { name: "Server UUID", value: req.body.server_uuid, inline: false },
                    { name: "Reporter IP", value: resolveRequestIp(req) || "unknown", inline: true },
                    { name: "Attempted Players", value: attemptedPlayers, inline: true },
                    { name: "Max Allowed", value: String(MAX_PLAYERS_ONLINE_PER_SERVER), inline: true },
                    { name: "Current Plugin Entries", value: formatPluginEntriesForAlert(existingServer?.plugins), inline: false }
                ]
            });
        }
        return res.status(400).json({ error: "players_online must be an integer" });
    }
    if (req.body.os_name === undefined || req.body.os_name === null)
        return res.status(400).json({ error: "Missing os_name parameter" });
    if (req.body.os_version === undefined || req.body.os_version === null)
        return res.status(400).json({ error: "Missing os_version parameter" });
    if (req.body.java_version === undefined || req.body.java_version === null)
        return res.status(400).json({ error: "Missing java_version parameter" });
    if (req.body.cores === undefined || req.body.cores === null)
        return res.status(400).json({ error: "Missing cores parameter" });

    const coreCount = parseStrictNonNegativeInt(req.body.cores);
    if (coreCount === null) {
        return res.status(400).json({ error: "cores must be a non-negative integer" });
    }

    const ip = resolveRequestIp(req);

    const updateResult = await addOrUpdateServer(
        req.body.server_uuid,
        ip,
        playersOnline,
        req.body.os_name,
        req.body.os_version,
        req.body.java_version,
        coreCount
    );

    if (updateResult?.rejected && updateResult.reason === "ip_limit") {
        queueSecurityAlert({
            title: "Rejected Server Registration Due To IP Limit",
            description: "A new server heartbeat was rejected because the reporter IP already has too many active server UUIDs.",
            severity: "high",
            dedupeKey: `update-server-ip-limit:${ip}`,
            fields: [
                { name: "Reporter IP", value: ip || "unknown", inline: true },
                { name: "Server UUID", value: req.body.server_uuid, inline: true },
                { name: "Players", value: String(playersOnline), inline: true },
                { name: "Active Servers From IP", value: String(updateResult.activeServerCount || "unknown"), inline: true },
                { name: "IP Limit", value: String(updateResult.ipLimit || "unknown"), inline: true }
            ]
        });
        return res.status(429).json({
            error: "Too many active servers are already registered from this IP"
        });
    }

    addToRecentActivity(MessageType.SERVER_HEARTBEAT, {
        // player count, server uuid
        player_count: playersOnline,
        server_uuid: req.body.server_uuid.substring(0, 6)
    });
    res.sendStatus(204);
});

// Endpoint sent by the server to add a plugin to its list
router.post("/add-plugin", serverIngestIpRateLimiter, serverIngestRateLimiter, (req, res) => {
    if (!req.body.server_uuid || !isCanonicalUuid(req.body.server_uuid))
        return res.status(400).json({ error: "server_uuid must be a valid UUID" });
    const pluginUuid = stripPluginEntryDelimiters(req.body.plugin_uuid);
    if (!pluginUuid || !isCanonicalUuid(pluginUuid))
        return res.status(400).json({ error: "plugin_uuid must be a valid UUID" });
    const plugin = getPlugin(pluginUuid);
    if (!plugin) {
        queueSecurityAlert({
            title: "Unknown Private Plugin UUID On Ingest",
            description: "A server tried to attach a plugin UUID that does not exist in the private plugin registry.",
            severity: "high",
            dedupeKey: `add-plugin-unknown-plugin:${pluginUuid}`,
            fields: [
                { name: "Server UUID", value: req.body.server_uuid, inline: true },
                { name: "Reporter IP", value: resolveRequestIp(req) || "unknown", inline: true },
                { name: "Plugin UUID", value: pluginUuid, inline: false },
                { name: "Version", value: String(req.body.plugin_version || "Unknown"), inline: true }
            ]
        });
        return res.status(404).json({ error: "Plugin not found" });
    }
    const pluginVersionInput = typeof req.body.plugin_version === "string" && req.body.plugin_version.trim()
        ? stripPluginEntryDelimiters(req.body.plugin_version)
        : "Unknown";
    const pluginVersion = badwords.filter(pluginVersionInput || "Unknown");

    if (getServer(req.body.server_uuid) === undefined) {
        console.log("Server not found: " + req.body.server_uuid);
        queueSecurityAlert({
            title: "Plugin Attach For Missing Server UUID",
            description: "A plugin attach request referenced a server UUID that does not exist in the active servers table.",
            severity: "medium",
            dedupeKey: `add-plugin-missing-server:${req.body.server_uuid}`,
            fields: [
                { name: "Server UUID", value: req.body.server_uuid, inline: true },
                { name: "Reporter IP", value: resolveRequestIp(req) || "unknown", inline: true },
                { name: "Plugin UUID", value: pluginUuid, inline: false },
                { name: "Version", value: pluginVersion, inline: true }
            ]
        });
        return res.status(404).json({ error: "Server not found" });
    }

    if (addPluginToServer(req.body.server_uuid, pluginUuid, pluginVersion)) {
        console.log("Added plugin " + pluginUuid + " to server " + req.body.server_uuid + " with version " + pluginVersion);
        addToRecentActivity(MessageType.MOD_REGISTERED_TO_SERVER, {
            mod_name: plugin.name || pluginUuid.substring(0, 6),
            server_uuid: req.body.server_uuid.substring(0, 6)
        });
        res.json({ status: "success" });
    } else {
        console.log("Plugin " + pluginUuid + " already added to server " + req.body.server_uuid);
        res.status(200).json({ error: "Plugin already added" });
    }
});

export default router;
