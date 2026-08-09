import express from 'express';
import crypto from 'crypto';
import BadWordsNext from 'bad-words-next';
import en from 'bad-words-next/lib/en';
import { getServersUsingPlugin, removePluginFromAllServers, replacePluginUuidInAllServers } from '../databases/serversdb.js';
import {
    addOrUpdatePlugin,
    deletePlugin,
    getAllPlugins,
    getPlugin,
    getPluginByAnyUUID,
    getPluginByPublicUUID,
    isAnyPluginUuidTaken,
    rotatePluginPrivateUuid,
    setPluginLinks,
    setPluginName,
    setPluginVisibility,
    toPublicPlugin
} from '../databases/plugindb.js';
import requireSession from '../middleware/requireSession.js';
import optionalSession from '../middleware/optionalSession.js';
import { addPluginToUser, getAccountThatOwnsPlugin, getPluginsAccess, removePluginFromAllAccounts, replacePluginAccessUuid } from '../databases/accountsdb.js';
import { deletePluginStats, getPluginAllTimePeak, getPluginDailyStatsLastDays, replacePluginStatsUuid } from '../databases/pluginstatsdb.js';
import { addToRecentActivity, MessageType } from '../databases/liveActivity.js';
import { MAX_PLUGINS_PER_USER, PLUGIN_HISTORY_DAYS, PLUGIN_PRIVATE_UUID_REFRESH_COOLDOWN_SECONDS } from '../config.js';
import { heavyGetRateLimiter } from '../middleware/rateLimiters.js';
import { getMarketplaceDownloadCounts } from '../utils/marketplaceDownloads.js';

const router = express.Router();
const badwords = new BadWordsNext({ data: en });
const PLUGIN_NAME_MAX_LENGTH = 32;
const LIST_PLUGIN_SORTS = new Set(["popular", "players", "newest", "name"]);
const LIST_PLUGIN_LINK_FILTERS = new Set(["any", "with_any", "github", "curseforge", "modtale", "modifold", "none"]);

function validatePluginName(name) {
    if (typeof name !== "string" || !name.trim()) {
        return { ok: false, error: "Missing name field" };
    }

    const pluginName = name.trim();
    if (pluginName.length > PLUGIN_NAME_MAX_LENGTH) {
        return {
            ok: false,
            status: 400,
            error: "Plugin name must be 32 characters or fewer",
            error_code: "name_too_long",
            field: "name",
            max_length: PLUGIN_NAME_MAX_LENGTH
        };
    }
    if (badwords.check(pluginName)) {
        return {
            ok: false,
            status: 400,
            error: "Plugin name contains inappropriate language",
            error_code: "inappropriate_language",
            field: "name"
        };
    }

    return { ok: true, name: pluginName };
}

function parseNonNegativeIntegerQuery(value, field) {
    if (value === undefined) {
        return { ok: true, value: null };
    }

    const normalized = String(value).trim();
    if (!/^\d+$/.test(normalized)) {
        return { ok: false, error: `${field} must be a non-negative integer` };
    }
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, error: `${field} must be a non-negative integer` };
    }

    return { ok: true, value: parsed };
}

function parseListPluginFilters(query = {}) {
    const sort = typeof query.sort === "string" ? query.sort : "popular";
    const links = typeof query.links === "string" ? query.links : "any";
    const developerUuid = typeof query.developer_uuid === "string" ? query.developer_uuid.trim() : "";
    const minServers = parseNonNegativeIntegerQuery(query.min_servers, "min_servers");
    const maxServers = parseNonNegativeIntegerQuery(query.max_servers, "max_servers");
    const minPlayers = parseNonNegativeIntegerQuery(query.min_players, "min_players");
    const maxPlayers = parseNonNegativeIntegerQuery(query.max_players, "max_players");

    if (!LIST_PLUGIN_SORTS.has(sort)) {
        return { ok: false, error: "sort must be one of: popular, players, newest, name" };
    }
    if (!LIST_PLUGIN_LINK_FILTERS.has(links)) {
        return { ok: false, error: "links must be one of: any, with_any, github, curseforge, modtale, modifold, none" };
    }

    const invalidRange = [minServers, maxServers, minPlayers, maxPlayers].find((result) => !result.ok);
    if (invalidRange) {
        return { ok: false, error: invalidRange.error };
    }
    if (developerUuid && !isCanonicalUuid(developerUuid)) {
        return { ok: false, error: "developer_uuid must be a valid UUID" };
    }
    if (minServers.value !== null && maxServers.value !== null && minServers.value > maxServers.value) {
        return { ok: false, error: "min_servers cannot be greater than max_servers" };
    }
    if (minPlayers.value !== null && maxPlayers.value !== null && minPlayers.value > maxPlayers.value) {
        return { ok: false, error: "min_players cannot be greater than max_players" };
    }

    return {
        ok: true,
        filters: {
            sort,
            links,
            developer_uuid: developerUuid,
            min_servers: minServers.value,
            max_servers: maxServers.value,
            min_players: minPlayers.value,
            max_players: maxPlayers.value
        }
    };
}

function isCanonicalUuid(value) {
    if (typeof value !== "string") {
        return false;
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

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
        const hasValidPath = /^\/hytale\/mods\/[^/]+\/?$/i.test(pathname);
        if (parsedUrl.protocol !== "https:" || !isAllowedHost || !hasValidPath) {
            return { ok: false, error: "Invalid CurseForge mod link. Expected https://www.curseforge.com/hytale/mods/<mod-name>" };
        }
    }
    if (kind === "modtale" || kind === "modifold") {
        let parsedUrl = null;
        try {
            parsedUrl = new URL(trimmed);
        } catch {
            return { ok: false, error: `Invalid ${kind === "modtale" ? "Modtale" : "Modifold"} link` };
        }

        const expectedHost = kind === "modtale" ? "modtale.net" : "modifold.com";
        const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
        const hasValidPath = /^\/mod\/[^/]+\/?$/i.test(parsedUrl.pathname);
        if (parsedUrl.protocol !== "https:" || host !== expectedHost || !hasValidPath) {
            const platform = kind === "modtale" ? "Modtale" : "Modifold";
            return { ok: false, error: `Invalid ${platform} mod link. Expected https://${expectedHost}/mod/<mod-name>` };
        }
    }

    return { ok: true, value: trimmed };
}

function generateUniquePrivatePluginUUID() {
    let privatePluginUUID = crypto.randomUUID();
    while (isAnyPluginUuidTaken(privatePluginUUID)) {
        privatePluginUUID = crypto.randomUUID();
    }
    return privatePluginUUID;
}

function canViewerSeePlugin(plugin, viewerPrivatePluginAccess = []) {
    const isUnlisted = Number(plugin?.is_unlisted) === 1;
    return !isUnlisted || viewerPrivatePluginAccess.includes(plugin.uuid);
}

// Endpoint when a user adds a new plugin to the database
router.post("/add-plugin", requireSession, (req, res) => {
    const { name } = req.body;
    const initialIsUnlisted = req.body?.is_unlisted === undefined
        ? false
        : req.body.is_unlisted;

    if (typeof initialIsUnlisted !== "boolean") {
        return res.status(400).json({ error: "is_unlisted must be a boolean" });
    }

    const nameValidation = validatePluginName(name);
    if (!nameValidation.ok) {
        return res.status(nameValidation.status || 400).json({
            error: nameValidation.error,
            error_code: nameValidation.error_code,
            field: nameValidation.field,
            max_length: nameValidation.max_length
        });
    }
    const pluginName = nameValidation.name;

    const ownedPlugins = getPluginsAccess(req.account.id)
        .filter(pluginId => typeof pluginId === "string" && pluginId.trim().length > 0);
    if (ownedPlugins.length >= MAX_PLUGINS_PER_USER) {
        return res.status(403).json({
            error: "Plugin limit reached",
            error_code: "plugin_limit_reached",
            max_plugins: MAX_PLUGINS_PER_USER
        });
    }

    const privatePluginUUID = generateUniquePrivatePluginUUID();

    addOrUpdatePlugin(privatePluginUUID, pluginName);
    if (initialIsUnlisted) {
        setPluginVisibility(privatePluginUUID, true);
    }
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
        private_plugin_uuid: publicPlugin.private_uuid,
        is_unlisted: publicPlugin.is_unlisted
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

    removePluginFromAllAccounts(plugin.uuid);
    removePluginFromAllServers(plugin.uuid);
    deletePluginStats(plugin.uuid);
    deletePlugin(plugin.uuid);
    res.status(200).json({ message: "Plugin deleted successfully" });
});

router.post("/refresh-private-plugin-uuid", requireSession, (req, res) => {
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
        return res.status(403).json({ error: "Cannot refresh a plugin you do not have access to" });
    }

    const now = Math.floor(Date.now() / 1000);
    const lastRefreshAt = Number(plugin.last_private_uuid_refresh_at) || 0;
    const nextRefreshAt = lastRefreshAt + PLUGIN_PRIVATE_UUID_REFRESH_COOLDOWN_SECONDS;
    if (lastRefreshAt > 0 && now < nextRefreshAt) {
        return res.status(429).json({
            error: "Private plugin UUID can only be refreshed once every 24 hours",
            retry_after_seconds: nextRefreshAt - now,
            next_refresh_at: new Date(nextRefreshAt * 1000).toISOString()
        });
    }

    const oldPrivateUuid = plugin.uuid;
    const newPrivateUuid = generateUniquePrivatePluginUUID();
    let accessUpdated = false;
    let serversUpdated = false;
    let statsUpdated = false;
    let pluginUpdated = false;

    try {
        replacePluginAccessUuid(oldPrivateUuid, newPrivateUuid);
        accessUpdated = true;
        replacePluginUuidInAllServers(oldPrivateUuid, newPrivateUuid);
        serversUpdated = true;
        replacePluginStatsUuid(oldPrivateUuid, newPrivateUuid);
        statsUpdated = true;
        const updatedPlugin = rotatePluginPrivateUuid(oldPrivateUuid, newPrivateUuid, now);
        pluginUpdated = !!updatedPlugin;

        if (!updatedPlugin) {
            throw new Error("Failed to refresh plugin UUID");
        }

        const publicPlugin = toPublicPlugin(updatedPlugin, { includePrivate: true });
        return res.status(200).json({
            status: "success",
            plugin_uuid: publicPlugin.uuid,
            private_plugin_uuid: publicPlugin.private_uuid,
            last_private_uuid_refresh_at: new Date(now * 1000).toISOString(),
            next_refresh_at: new Date((now + PLUGIN_PRIVATE_UUID_REFRESH_COOLDOWN_SECONDS) * 1000).toISOString()
        });
    } catch (error) {
        console.error(`Failed to refresh private UUID for plugin ${oldPrivateUuid}:`, error);
        try {
            if (pluginUpdated) {
                rotatePluginPrivateUuid(newPrivateUuid, oldPrivateUuid, lastRefreshAt);
            }
            if (statsUpdated) {
                replacePluginStatsUuid(newPrivateUuid, oldPrivateUuid);
            }
            if (serversUpdated) {
                replacePluginUuidInAllServers(newPrivateUuid, oldPrivateUuid);
            }
            if (accessUpdated) {
                replacePluginAccessUuid(newPrivateUuid, oldPrivateUuid);
            }
        } catch (rollbackError) {
            console.error(`Rollback failed while restoring private UUID for plugin ${oldPrivateUuid}:`, rollbackError);
        }
        return res.status(500).json({ error: "Failed to refresh private plugin UUID" });
    }
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
    const modtaleResult = validateOptionalPluginLink(req.body?.modtale_link, "modtale");
    if (!modtaleResult.ok) {
        return res.status(400).json({ error: modtaleResult.error });
    }
    const modifoldResult = validateOptionalPluginLink(req.body?.modifold_link, "modifold");
    if (!modifoldResult.ok) {
        return res.status(400).json({ error: modifoldResult.error });
    }

    if ([githubResult, curseforgeResult, modtaleResult, modifoldResult].every((result) => result.value === undefined)) {
        return res.status(400).json({ error: "Provide at least one mod link" });
    }

    const updatedPlugin = setPluginLinks(plugin.uuid, {
        githubLink: githubResult.value,
        curseforgeLink: curseforgeResult.value,
        modtaleLink: modtaleResult.value,
        modifoldLink: modifoldResult.value
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
            curseforge_link: publicPlugin.curseforge_link || "",
            modtale_link: publicPlugin.modtale_link || "",
            modifold_link: publicPlugin.modifold_link || ""
        }
    });
});

router.post("/apply-plugin-name", requireSession, (req, res) => {
    const inputUuid = typeof req.body?.plugin_uuid === "string" ? req.body.plugin_uuid.trim() : "";
    if (!inputUuid) {
        return res.status(400).json({ error: "Missing plugin_uuid field" });
    }

    const nameValidation = validatePluginName(req.body?.name);
    if (!nameValidation.ok) {
        return res.status(nameValidation.status || 400).json({
            error: nameValidation.error,
            error_code: nameValidation.error_code,
            field: nameValidation.field,
            max_length: nameValidation.max_length
        });
    }

    const plugin = getPluginByAnyUUID(inputUuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const pluginAccess = getPluginsAccess(req.account.id);
    if (!pluginAccess.includes(plugin.uuid)) {
        return res.status(403).json({ error: "Cannot rename a plugin you do not have access to" });
    }

    const updatedPlugin = setPluginName(plugin.uuid, nameValidation.name);
    if (!updatedPlugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const publicPlugin = toPublicPlugin(updatedPlugin);
    return res.json({
        status: "success",
        plugin_uuid: publicPlugin.uuid,
        name: publicPlugin.name
    });
});

router.post("/apply-plugin-visibility", requireSession, (req, res) => {
    const inputUuid = typeof req.body?.plugin_uuid === "string" ? req.body.plugin_uuid.trim() : "";
    if (!inputUuid) {
        return res.status(400).json({ error: "Missing plugin_uuid field" });
    }

    if (typeof req.body?.is_unlisted !== "boolean") {
        return res.status(400).json({ error: "is_unlisted must be a boolean" });
    }

    const plugin = getPluginByAnyUUID(inputUuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const pluginAccess = getPluginsAccess(req.account.id);
    if (!pluginAccess.includes(plugin.uuid)) {
        return res.status(403).json({ error: "Cannot edit visibility for a plugin you do not have access to" });
    }

    const updatedPlugin = setPluginVisibility(plugin.uuid, req.body.is_unlisted);
    if (!updatedPlugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }

    const publicPlugin = toPublicPlugin(updatedPlugin);
    return res.json({
        status: "success",
        plugin_uuid: publicPlugin.uuid,
        is_unlisted: publicPlugin.is_unlisted
    });
});

router.get("/list-plugins", optionalSession, heavyGetRateLimiter, (req, res) => {
    const searchTerm = typeof req.query.search === "string" ? req.query.search : "";
    const maxResults = Math.max(1, Math.min(parseInt(req.query.max, 10) || 51, 51));
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const filterResult = parseListPluginFilters(req.query || {});
    if (!filterResult.ok) {
        return res.status(400).json({ error: filterResult.error });
    }
    const filters = filterResult.filters;
    const viewerPrivatePluginAccess = req.account
        ? getPluginsAccess(req.account.id)
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        : [];
    const allPlugins = getAllPlugins(searchTerm)
        .filter((plugin) => canViewerSeePlugin(plugin, viewerPrivatePluginAccess));

    let pluginRows = allPlugins.map((plugin) => {
        const serversUsing = getServersUsingPlugin(plugin.uuid);
        const owner = getAccountThatOwnsPlugin(plugin.uuid);
        return {
            plugin,
            owner,
            serversUsingCount: serversUsing.length,
            totalPlayers: serversUsing.reduce((sum, server) => sum + server.players_online, 0)
        };
    });

    pluginRows = pluginRows.filter(({ plugin, owner, serversUsingCount, totalPlayers }) => {
        const hasGithub = typeof plugin.github_link === "string" && plugin.github_link.trim();
        const hasCurseforge = typeof plugin.curseforge_link === "string" && plugin.curseforge_link.trim();
        const hasModtale = typeof plugin.modtale_link === "string" && plugin.modtale_link.trim();
        const hasModifold = typeof plugin.modifold_link === "string" && plugin.modifold_link.trim();
        const hasAnyLink = hasGithub || hasCurseforge || hasModtale || hasModifold;

        if (filters.developer_uuid && owner?.id !== filters.developer_uuid) {
            return false;
        }
        if (filters.links === "github" && !hasGithub) {
            return false;
        }
        if (filters.links === "curseforge" && !hasCurseforge) {
            return false;
        }
        if (filters.links === "modtale" && !hasModtale) {
            return false;
        }
        if (filters.links === "modifold" && !hasModifold) {
            return false;
        }
        if (filters.links === "with_any" && !hasAnyLink) {
            return false;
        }
        if (filters.links === "none" && hasAnyLink) {
            return false;
        }
        if (filters.min_servers !== null && serversUsingCount < filters.min_servers) {
            return false;
        }
        if (filters.max_servers !== null && serversUsingCount > filters.max_servers) {
            return false;
        }
        if (filters.min_players !== null && totalPlayers < filters.min_players) {
            return false;
        }
        if (filters.max_players !== null && totalPlayers > filters.max_players) {
            return false;
        }

        return true;
    });

    // Global ranking by usage before pagination.
    pluginRows.sort((a, b) => {
        if (filters.sort === "name") {
            const nameCompare = String(a.plugin.name || "").localeCompare(String(b.plugin.name || ""));
            if (nameCompare !== 0) {
                return nameCompare;
            }
        } else if (filters.sort === "newest") {
            const addedA = String(a.plugin.added_on || "");
            const addedB = String(b.plugin.added_on || "");
            if (addedA !== addedB) {
                return addedB.localeCompare(addedA);
            }
        } else if (filters.sort === "players") {
            if (b.totalPlayers !== a.totalPlayers) {
                return b.totalPlayers - a.totalPlayers;
            }
        } else if (b.serversUsingCount !== a.serversUsingCount) {
            return b.serversUsingCount - a.serversUsingCount;
        }

        // Keep newest plugins first when primary sort values are tied.
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
    pageRows.forEach(({ plugin, owner, serversUsingCount, totalPlayers }) => {
        const publicPlugin = toPublicPlugin(plugin);
        response[publicPlugin.uuid] = {
            plugin_info: publicPlugin,
            servers_using: serversUsingCount,
            total_players: totalPlayers,
            daily_stats: getPluginDailyStatsLastDays(plugin.uuid),
            developer_info: owner
                ? {
                    id: owner.id,
                    username: owner.username?.trim() || "No Name",
                    github_link: owner.github_link || "",
                    curseforge_link: owner.curseforge_link || ""
                }
                : null,
            pages: totalPages
        };
    });
    res.status(200).json({
        plugins: response,
        page,
        max: maxResults,
        total_plugins: totalPlugins,
        total_pages: totalPages,
        filters
    });
});

router.get("/plugin-info/:plugin_uuid", heavyGetRateLimiter, async (req, res) => {
    if (!req.params.plugin_uuid)
        return res.status(400).json({ error: "Missing plugin_uuid parameter" });

    const plugin = getPluginByPublicUUID(req.params.plugin_uuid);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }
    const privatePluginUUID = plugin.uuid;
    const publicPlugin = toPublicPlugin(plugin);
    const servers = getServersUsingPlugin(privatePluginUUID);
    const history = getPluginDailyStatsLastDays(privatePluginUUID);
    const marketplaceDownloads = await getMarketplaceDownloadCounts({
        curseforgeLink: publicPlugin.curseforge_link,
        modtaleLink: publicPlugin.modtale_link,
        modifoldLink: publicPlugin.modifold_link
    });

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
        .slice(0, 51)
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
        is_unlisted: publicPlugin.is_unlisted,
        links: {
            github_link: publicPlugin.github_link || "",
            curseforge_link: publicPlugin.curseforge_link || "",
            modtale_link: publicPlugin.modtale_link || "",
            modifold_link: publicPlugin.modifold_link || ""
        },
        marketplace_downloads: {
            ...(marketplaceDownloads.curseforge !== null ? { curseforge: marketplaceDownloads.curseforge } : {}),
            ...(marketplaceDownloads.modtale !== null ? { modtale: marketplaceDownloads.modtale } : {}),
            ...(marketplaceDownloads.modifold !== null ? { modifold: marketplaceDownloads.modifold } : {})
        },
        total_servers: totalServers,
        total_players: totalPlayers,
        history,
        history_retention_days: PLUGIN_HISTORY_DAYS,
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
