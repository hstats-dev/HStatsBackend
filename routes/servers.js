import express from 'express';
import { addOrUpdateServer, addPluginToServer, getServer } from '../databases/serversdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { getPlugin } from '../databases/plugindb.js';
import { serverIngestRateLimiter } from '../middleware/rateLimiters.js';

const router = express.Router();

// Endpoint to add a new server, this is called when a server first comes online
router.post("/update-server", serverIngestRateLimiter, async (req, res) => {
    if (!req.body.server_uuid)
        return res.status(400).json({ error: "Missing server_uuid parameter" });
    if (req.body.players_online === undefined || req.body.players_online === null || isNaN(req.body.players_online) || parseInt(req.body.players_online) < 0 || parseInt(req.body.players_online) > 600)
        return res.status(400).json({ error: "Missing players_online parameter" });
    if (req.body.os_name === undefined || req.body.os_name === null)
        return res.status(400).json({ error: "Missing os_name parameter" });
    if (req.body.os_version === undefined || req.body.os_version === null)
        return res.status(400).json({ error: "Missing os_version parameter" });
    if (req.body.java_version === undefined || req.body.java_version === null)
        return res.status(400).json({ error: "Missing java_version parameter" });
    if (req.body.cores === undefined || req.body.cores === null)
        return res.status(400).json({ error: "Missing cores parameter" });

    const ip = req.clientIp;

    await addOrUpdateServer(req.body.server_uuid, ip, req.body.players_online, req.body.os_name, req.body.os_version, req.body.java_version, parseInt(req.body.cores));
    addToRecentActivity(MessageType.SERVER_HEARTBEAT, {
        // player count, server uuid
        player_count: req.body.players_online,
        server_uuid: req.body.server_uuid.substring(0, 6)
    });
    res.status(200).json({ status: "success" });
});

// Endpoint sent by the server to add a plugin to its list
router.post("/add-plugin", serverIngestRateLimiter, (req, res) => {
    console.log(JSON.stringify(req.body));

    if (!req.body.server_uuid)
        return res.status(400).json({ error: "Missing server_uuid parameter" });
    if (!req.body.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });
    if (!req.body.plugin_version)
        req.body.plugin_version = "Unknown";

    if (getServer(req.body.server_uuid) === undefined) {
        console.log("Server not found: " + req.body.server_uuid);
        return res.status(404).json({ error: "Server not found" });
    }

    if (addPluginToServer(req.body.server_uuid, req.body.plugin_uuid, req.body.plugin_version)) {
        console.log("Added plugin " + req.body.plugin_uuid + " to server " + req.body.server_uuid + " with version " + req.body.plugin_version);
        addToRecentActivity(MessageType.MOD_REGISTERED_TO_SERVER, {
            mod_name: getPlugin(req.body.plugin_uuid)?.name || req.body.plugin_uuid.substring(0, 6),
            server_uuid: req.body.server_uuid.substring(0, 6)
        });
        res.json({ status: "success" });
    } else {
        console.log("Plugin " + req.body.plugin_uuid + " already added to server " + req.body.server_uuid);
        res.status(400).json({ error: "Plugin already added" });
    }
});

export default router;
