import express from 'express';
import { getServersUsingPlugin } from '../databases/serversdb';

const router = express.Router();

router.post("/add-plugin", (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
});

router.get("/plugin-info/:plugin_uuid", (req, res) => {
    if (!req.params.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });

    const servers = getServersUsingPlugin(req.params.plugin_uuid);

    let totalServers = servers.length;
    let totalPlayers = 0;
    let versions = new Set();
    let countries = {};

    servers.forEach(server => {
        totalPlayers += server.players_online;
        const pluginData = JSON.parse(server.plugins || "{}");
        if (pluginData[req.params.plugin_uuid]) {
            versions.add(pluginData[req.params.plugin_uuid]);
        }
        if (server.country) {
            if (!(server.country in countries)) {
                countries[server.country] = 0;
            }
            countries[server.country]++;
        }
    });

    res.status(200).json({
        total_servers: totalServers,
        total_players: totalPlayers,
        versions: Array.from(versions),
        countries: countries
    });
});

export default router;