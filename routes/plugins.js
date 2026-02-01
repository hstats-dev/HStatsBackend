import express from 'express';
import {v4 as uuidv4} from 'uuid';
import { getServersUsingPlugin } from '../databases/serversdb.js';
import { addOrUpdatePlugin, deletePlugin, getPlugin } from '../databases/plugindb.js';
import requireSession from '../middleware/requireSession.js';
import { addPluginToUser, getPluginsAccess } from '../databases/accountsdb.js';
import { getPluginDailyStatsLastDays } from '../databases/pluginstatsdb.js';

const router = express.Router();

// Endpoint when a user adds a new plugin to the database
router.post("/add-plugin", requireSession, (req, res) => {
    const { name, version } = req.body;

    if (!name || !version) {
        return res.status(400).json({ error: "Missing name or version field" });
    }

    let pluginUUID = uuidv4();
    while (getPlugin(pluginUUID) !== undefined) {
        pluginUUID = uuidv4();
    }

    addOrUpdatePlugin(pluginUUID, name, version);
    addPluginToUser(req.account.id, pluginUUID);
    res.status(201).json({ plugin_uuid: pluginUUID });
});

router.post("/delete-plugin", requireSession, (req, res) => {
    const { uuid } = req.body;

    if (!uuid) {
        return res.status(400).json({ error: "Missing uuid field" });
    }

    const plugin = getPlugin(uuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const account = req.account;
    const pluginAccess = getPluginsAccess(account.id);
    if (!pluginAccess.includes(uuid)) {
        return res.status(403).json({ error: "Cannot delete a plugin you do not have access to" });
    }

    deletePlugin(uuid);
    res.status(200).json({ message: "Plugin deleted successfully" });
});

router.get("/plugin-info/:plugin_uuid", (req, res) => {
    if (!req.params.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });

    const servers = getServersUsingPlugin(req.params.plugin_uuid);

    let totalServers = servers.length;
    let totalPlayers = 0;
    let versions = new Set();
    let countries = {};
    let javaVersions = {};
    let osNames = {};
    let osVersions = {};
    let coreCounts = {};

    servers.forEach(server => {
        totalPlayers += server.players_online;
        const pluginEntries = server.plugins ? server.plugins.split(",") : [];
        pluginEntries.forEach(entry => {
            const [pluginUUID, version] = entry.split("@");
            if (pluginUUID === req.params.plugin_uuid && version) {
                versions.add(version);
            }
        });
        if (server.country) {
            if (!(server.country in countries)) {
                countries[server.country] = 0;
            }
            countries[server.country]++;
        }
        if (server.java_version) {
            if (!(server.java_version in javaVersions)) {
                javaVersions[server.java_version] = 0;
            }
            javaVersions[server.java_version]++;
        }
        if (server.os_name) {
            if (!(server.os_name in osNames)) {
                osNames[server.os_name] = 0;
            }
            osNames[server.os_name]++;
        }
        if (server.os_version) {
            if (!(server.os_version in osVersions)) {
                osVersions[server.os_version] = 0;
            }
            osVersions[server.os_version]++;
        }
        if (server.core_count !== undefined) {
            if (!(server.core_count in coreCounts)) {
                coreCounts[server.core_count] = 0;
            }
            coreCounts[server.core_count]++;
        }
    });

    res.status(200).json({
        total_servers: totalServers,
        total_players: totalPlayers,
        history: getPluginDailyStatsLastDays(req.params.plugin_uuid),
        versions: Array.from(versions),
        countries: countries,
        java_versions: javaVersions,
        os_names: osNames,
        os_versions: osVersions,
        core_counts: coreCounts
    });
});

export default router;
