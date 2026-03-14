import express from 'express';
import crypto from 'crypto';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { getServersUsingPlugin } from '../databases/serversdb.js';
import {
    addOrUpdatePlugin,
    deletePlugin,
    getAllPlugins,
    getPlugin,
    getPluginByAnyUUID,
    getPluginByPublicUUID,
    setPluginLinks,
    toPublicPlugin
} from '../databases/plugindb.js';
import requireSession from '../middleware/requireSession.js';
import { addPluginToUser, getAccountThatOwnsPlugin, getPluginsAccess } from '../databases/accountsdb.js';
import { getPluginAllTimePeak, getPluginDailyStatsLastDays } from '../databases/pluginstatsdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { MAX_PLUGINS_PER_USER } from '../config.js';
import { heavyGetRateLimiter } from '../middleware/rateLimiters.js';

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

function getUniquePluginUUIDsForServer(pluginsValue) {
    if (typeof pluginsValue !== "string" || !pluginsValue.trim()) {
        return [];
    }

    const uniquePluginUUIDs = new Set();
    pluginsValue.split(",").forEach((entryRaw) => {
        const entry = String(entryRaw || "").trim();
        if (!entry) {
            return;
        }
        const [entryPluginUUID] = entry.split("@");
        const normalizedUUID = (entryPluginUUID || "").trim();
        if (normalizedUUID) {
            uniquePluginUUIDs.add(normalizedUUID);
        }
    });

    return Array.from(uniquePluginUUIDs);
}

function validateOptionalPluginLink(value, kind) {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    if (typeof value !== "string") {
        return { ok: false, error: `Invalid ${kind} link` };
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return { ok: true, value: "" };
    }

    if (kind === "github" && !trimmed.startsWith("https://github.com/")) {
        return { ok: false, error: "Invalid GitHub link" };
    }
    if (kind === "curseforge") {
        let parsedUrl = null;
        try {
            parsedUrl = new URL(trimmed);
        } catch (error) {
            return { ok: false, error: "Invalid CurseForge link" };
        }

        const host = parsedUrl.hostname.toLowerCase();
        const pathname = parsedUrl.pathname;
        const isAllowedHost = host === "www.curseforge.com" || host === "curseforge.com";
        const hasValidPathPrefix = /^\/hytale\/mods\/[^/]+/i.test(pathname);
        if (!isAllowedHost || !hasValidPathPrefix) {
            return { ok: false, error: "Invalid CurseForge mod link. Expected https://www.curseforge.com/hytale/mods/<mod-name>" };
        }
    }

    return { ok: true, value: trimmed };
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

    let privatePluginUUID = crypto.randomUUID();
    while (getPlugin(privatePluginUUID) !== undefined) {
        privatePluginUUID = crypto.randomUUID();
    }

    addOrUpdatePlugin(privatePluginUUID, pluginName);
    const createdPlugin = getPlugin(privatePluginUUID);
    const publicPlugin = toPublicPlugin(createdPlugin, { includePrivate: true });
    if (!publicPlugin) {
        return res.status(500).json({ error: "Failed to create plugin" });
    }
    addPluginToUser(req.account.id, privatePluginUUID);
    addToRecentActivity(MessageType.MOD_REGISTERED, {
        mod_name: pluginName,
    });
    res.status(201).json({
        plugin_uuid: publicPlugin.uuid,
        private_plugin_uuid: publicPlugin.private_uuid
    });
});

router.post("/delete-plugin", requireSession, (req, res) => {
    const { uuid } = req.body;

    if (!uuid) {
        return res.status(400).json({ error: "Missing uuid field" });
    }

    const plugin = getPluginByAnyUUID(uuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const account = req.account;
    const pluginAccess = getPluginsAccess(account.id);
    if (!pluginAccess.includes(plugin.uuid)) {
        return res.status(403).json({ error: "Cannot delete a plugin you do not have access to" });
    }

    deletePlugin(plugin.uuid);
    res.status(200).json({ message: "Plugin deleted successfully" });
});

router.post("/apply-plugin-links", requireSession, (req, res) => {
    const inputUuid = typeof req.body?.plugin_uuid === "string" ? req.body.plugin_uuid.trim() : "";
    if (!inputUuid) {
        return res.status(400).json({ error: "Missing plugin_uuid field" });
    }

    const plugin = getPluginByAnyUUID(inputUuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const pluginAccess = getPluginsAccess(req.account.id);
    if (!pluginAccess.includes(plugin.uuid)) {
        return res.status(403).json({ error: "Cannot edit links for a plugin you do not have access to" });
    }

    const githubResult = validateOptionalPluginLink(req.body?.github_link, "github");
    if (!githubResult.ok) {
        return res.status(400).json({ error: githubResult.error });
    }
    const curseforgeResult = validateOptionalPluginLink(req.body?.curseforge_link, "curseforge");
    if (!curseforgeResult.ok) {
        return res.status(400).json({ error: curseforgeResult.error });
    }

    if (githubResult.value === undefined && curseforgeResult.value === undefined) {
        return res.status(400).json({ error: "Provide at least one of github_link or curseforge_link" });
    }

    const updatedPlugin = setPluginLinks(plugin.uuid, {
        githubLink: githubResult.value,
        curseforgeLink: curseforgeResult.value
    });
    if (!updatedPlugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const publicPlugin = toPublicPlugin(updatedPlugin);
    return res.json({
        status: "success",
        plugin_uuid: publicPlugin.uuid,
        links: {
            github_link: publicPlugin.github_link || "",
            curseforge_link: publicPlugin.curseforge_link || ""
        }
    });
});

router.get("/list-plugins", heavyGetRateLimiter, (req, res) => {
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

        // Keep newest plugins first when server counts are tied.
        const addedA = String(a.plugin.added_on || "");
        const addedB = String(b.plugin.added_on || "");
        if (addedA !== addedB) {
            return addedB.localeCompare(addedA);
        }

        // Final deterministic tie-breaker.
        return String(a.plugin.uuid || "").localeCompare(String(b.plugin.uuid || ""));
    });

    const totalPlugins = pluginRows.length;
    const totalPages = Math.ceil(totalPlugins / maxResults);
    const pageOffset = (page - 1) * maxResults;
    const pageRows = pluginRows.slice(pageOffset, pageOffset + maxResults);

    const response = {};
    pageRows.forEach(({ plugin, serversUsingCount, totalPlayers }) => {
        const publicPlugin = toPublicPlugin(plugin);
        response[publicPlugin.uuid] = {
            plugin_info: publicPlugin,
            servers_using: serversUsingCount,
            total_players: totalPlayers,
            daily_stats: getPluginDailyStatsLastDays(plugin.uuid),
            developer_info: (() => {
                const account = getAccountThatOwnsPlugin(plugin.uuid);
                if (account) {
                    return {
                        username: account.username?.trim() || "No Name",
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

router.get("/plugin-info/:plugin_uuid", heavyGetRateLimiter, (req, res) => {
    if (!req.params.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });

    const plugin = getPluginByPublicUUID(req.params.plugin_uuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }
    const privatePluginUUID = plugin.uuid;
    const publicPlugin = toPublicPlugin(plugin);
    const servers = getServersUsingPlugin(privatePluginUUID);

    let totalServers = servers.length;
    let totalPlayers = 0;
    let versions = {};
    let countries = {};
    let javaVersions = {};
    let osNames = {};
    let osVersions = {};
    let coreCounts = {};
    let coPluginCounts = {};

    servers.forEach(server => {
        totalPlayers += server.players_online;
        const version = getLatestPluginVersionForServer(server.plugins, privatePluginUUID);
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

        const serverPluginUUIDs = getUniquePluginUUIDsForServer(server.plugins);
        serverPluginUUIDs.forEach((pluginUUID) => {
            if (pluginUUID === privatePluginUUID) {
                return;
            }

            if (!(pluginUUID in coPluginCounts)) {
                coPluginCounts[pluginUUID] = 0;
            }
            coPluginCounts[pluginUUID]++;
        });
    });

    const coPlugins = Object.entries(coPluginCounts)
        .sort((a, b) => {
            if (b[1] !== a[1]) {
                return b[1] - a[1];
            }
            return a[0].localeCompare(b[0]);
        })
        .slice(0, 50)
        .map(([pluginUUID, timesSeen]) => {
            const coPlugin = getPlugin(pluginUUID);
            if (!coPlugin) {
                return null;
            }
            const publicCoPlugin = toPublicPlugin(coPlugin);
            return {
                name: coPlugin?.name || "Unknown Plugin",
                uuid: publicCoPlugin.uuid,
                times_seen: timesSeen
            };
        })
        .filter(Boolean);

    res.status(200).json({
        uuid: publicPlugin.uuid,
        name: plugin.name,
        links: {
            github_link: publicPlugin.github_link || "",
            curseforge_link: publicPlugin.curseforge_link || ""
        },
        total_servers: totalServers,
        total_players: totalPlayers,
        history: getPluginDailyStatsLastDays(privatePluginUUID),
        all_time_peak: getPluginAllTimePeak(privatePluginUUID),
        versions: versions,
        co_plugins: coPlugins,
        countries: countries,
        java_versions: javaVersions,
        os_names: osNames,
        os_versions: osVersions,
        core_counts: coreCounts
    });
});

export default router;
