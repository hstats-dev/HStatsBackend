import express from 'express';
import {v4 as uuidv4} from 'uuid';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { getServersUsingPlugin } from '../databases/serversdb.js';
import { addOrUpdatePlugin, deletePlugin, getAllPlugins, getPlugin } from '../databases/plugindb.js';
import requireSession from '../middleware/requireSession.js';
import { addPluginToUser, getAccountThatOwnsPlugin, getPluginsAccess } from '../databases/accountsdb.js';
import { getPluginAllTimePeak, getPluginDailyStatsLastDays } from '../databases/pluginstatsdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { MAX_PLUGINS_PER_USER } from '../config.js';

const router = express.Router();
const badwords = new BadWordsNext({ data: en });

function getLatestPluginVersionForServer(pluginsValue, pluginUUID) {
    if (typeof pluginsValue !== "string" || !pluginsValue.trim()) {
        return null;
    }

    let latestVersion = null;
    pluginsValue.split(",").forEach((entryRaw) => {
        const entry = String(entryRaw || "").trim();
        if (!entry) {
            return;
        }

        const [entryPluginUUID, entryVersion] = entry.split("@");
        if ((entryPluginUUID || "").trim() !== pluginUUID) {
            return;
        }

        const normalizedVersion = (entryVersion || "").trim() || "Unknown";
        latestVersion = normalizedVersion;
    });

    return latestVersion;
}

// Endpoint when a user adds a new plugin to the database
router.post("/add-plugin", requireSession, (req, res) => {
    const { name } = req.body;

    if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Missing name field" });
    }

    const pluginName = name.trim();
    if (pluginName.length > 32) {
        return res.status(400).json({
            error: "Plugin name must be 32 characters or fewer",
            error_code: "name_too_long",
            field: "name",
            max_length: 32
        });
    }
    if (badwords.check(pluginName)) {
        return res.status(400).json({
            error: "Plugin name contains inappropriate language",
            error_code: "inappropriate_language",
            field: "name"
        });
    }

    const ownedPlugins = getPluginsAccess(req.account.id)
        .filter(pluginId => typeof pluginId === "string" && pluginId.trim().length > 0);
    if (ownedPlugins.length >= MAX_PLUGINS_PER_USER) {
        return res.status(403).json({
            error: "Plugin limit reached",
            error_code: "plugin_limit_reached",
            max_plugins: MAX_PLUGINS_PER_USER
        });
    }

    let pluginUUID = uuidv4();
    while (getPlugin(pluginUUID) !== undefined) {
        pluginUUID = uuidv4();
    }

    addOrUpdatePlugin(pluginUUID, pluginName);
    addPluginToUser(req.account.id, pluginUUID);
    addToRecentActivity(MessageType.MOD_REGISTERED, {
        mod_name: pluginName,
    });
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

router.get("/list-plugins", (req, res) => {
    const searchTerm = typeof req.query.search === "string" ? req.query.search : "";
    const maxResults = Math.max(1, Math.min(parseInt(req.query.max, 10) || 50, 50));
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const allPlugins = getAllPlugins(searchTerm);

    const pluginRows = allPlugins.map((plugin) => {
        const serversUsing = getServersUsingPlugin(plugin.uuid);
        return {
            plugin,
            serversUsingCount: serversUsing.length,
            totalPlayers: serversUsing.reduce((sum, server) => sum + server.players_online, 0)
        };
    });

    // Global ranking by usage before pagination.
    pluginRows.sort((a, b) => {
        if (b.serversUsingCount !== a.serversUsingCount) {
            return b.serversUsingCount - a.serversUsingCount;
        }

        // Stable tie-breaker for deterministic ordering.
        return String(a.plugin.name || "").localeCompare(String(b.plugin.name || ""));
    });

    const totalPlugins = pluginRows.length;
    const totalPages = Math.ceil(totalPlugins / maxResults);
    const pageOffset = (page - 1) * maxResults;
    const pageRows = pluginRows.slice(pageOffset, pageOffset + maxResults);

    const response = {};
    pageRows.forEach(({ plugin, serversUsingCount, totalPlayers }) => {
        response[plugin.uuid] = {
            plugin_info: plugin,
            servers_using: serversUsingCount,
            total_players: totalPlayers,
            daily_stats: getPluginDailyStatsLastDays(plugin.uuid),
            developer_info: (() => {
                const account = getAccountThatOwnsPlugin(plugin.uuid);
                if (account) {
                    return {
                        github_link: account.github_link || "",
                        curseforge_link: account.curseforge_link || ""
                    };
                } else {
                    return null;
                }
            })(),
            pages: totalPages
        };
    });
    res.status(200).json({ plugins: response });
});

router.get("/plugin-info/:plugin_uuid", (req, res) => {
    if (!req.params.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });

    const plugin = getPlugin(req.params.plugin_uuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }
    const servers = getServersUsingPlugin(req.params.plugin_uuid);

    let totalServers = servers.length;
    let totalPlayers = 0;
    let versions = {};
    let countries = {};
    let javaVersions = {};
    let osNames = {};
    let osVersions = {};
    let coreCounts = {};

    servers.forEach(server => {
        totalPlayers += server.players_online;
        const version = getLatestPluginVersionForServer(server.plugins, req.params.plugin_uuid);
        if (version) {
            if (!(version in versions)) {
                versions[version] = 0;
            }
            versions[version]++;
        }
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
        name: plugin.name,
        total_servers: totalServers,
        total_players: totalPlayers,
        history: getPluginDailyStatsLastDays(req.params.plugin_uuid),
        all_time_peak: getPluginAllTimePeak(req.params.plugin_uuid),
        versions: versions,
        countries: countries,
        java_versions: javaVersions,
        os_names: osNames,
        os_versions: osVersions,
        core_counts: coreCounts
    });
});

export default router;
