import express from 'express';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { addOrUpdateServer, addPluginToServer, getServer } from '../databases/serversdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { getPlugin } from '../databases/plugindb.js';
import { serverIngestRateLimiter } from '../middleware/rateLimiters.js';

const router = express.Router();
const badwords = new BadWordsNext({ data: en });
const MAX_PLAYERS_ONLINE = 500;

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

// Endpoint to add a new server, this is called when a server first comes online
router.post("/update-server", serverIngestRateLimiter, async (req, res) => {
    if (!req.body.server_uuid)
        return res.status(400).json({ error: "Missing server_uuid parameter" });
    const playersOnline = parseStrictNonNegativeInt(req.body.players_online);
    if (playersOnline === null || playersOnline > MAX_PLAYERS_ONLINE)
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
    res.status(200).json({ status: "success" });
});

// Endpoint sent by the server to add a plugin to its list
router.post("/add-plugin", serverIngestRateLimiter, (req, res) => {
    console.log(JSON.stringify(req.body));

    if (!req.body.server_uuid || typeof req.body.server_uuid !== "string" || req.body.server_uuid.length !== 36)
        return res.status(400).json({ error: "Missing server_uuid parameter" });
    const pluginUuid = stripPluginEntryDelimiters(req.body.plugin_uuid);
    if (!pluginUuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });
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
            mod_name: getPlugin(pluginUuid)?.name || pluginUuid.substring(0, 6),
            server_uuid: req.body.server_uuid.substring(0, 6)
        });
        res.json({ status: "success" });
    } else {
        console.log("Plugin " + pluginUuid + " already added to server " + req.body.server_uuid);
        res.status(400).json({ error: "Plugin already added" });
    }
});

export default router;
