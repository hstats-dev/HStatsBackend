import express from 'express';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { addOrUpdateServer, addPluginToServer, getServer } from '../databases/serversdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { getPlugin } from '../databases/plugindb.js';
import { serverIngestIpRateLimiter, serverIngestRateLimiter } from '../middleware/rateLimiters.js';
import { MAX_PLAYERS_ONLINE_PER_SERVER } from '../config.js';

const router = express.Router();
const badwords = new BadWordsNext({ data: en });

function stripPluginEntryDelimiters(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[,@]/g, "").trim();
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
    if (playersOnline === null || playersOnline > MAX_PLAYERS_ONLINE_PER_SERVER)
        return res.status(400).json({ error: "players_online must be an integer" });
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

    const ip = req.clientIp;

    await addOrUpdateServer(
        req.body.server_uuid,
        ip,
        playersOnline,
        req.body.os_name,
        req.body.os_version,
        req.body.java_version,
        coreCount
    );

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
        return res.status(404).json({ error: "Plugin not found" });
    }
    const pluginVersionInput = typeof req.body.plugin_version === "string" && req.body.plugin_version.trim()
        ? stripPluginEntryDelimiters(req.body.plugin_version)
        : "Unknown";
    const pluginVersion = badwords.filter(pluginVersionInput || "Unknown");

    if (getServer(req.body.server_uuid) === undefined) {
        console.log("Server not found: " + req.body.server_uuid);
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
