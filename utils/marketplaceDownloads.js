import axios from "axios";
import { configDotenv } from "dotenv";
import { MARKETPLACE_DOWNLOAD_CACHE_MS } from "../config.js";

configDotenv();

const downloadCache = new Map();
const pendingRequests = new Map();
const curseforgeProjectIds = new Map();
const MARKETPLACE_DOWNLOAD_FAILURE_CACHE_MS = 5 * 60 * 1000;
const CURSEFORGE_API_ROOT = "https://api.curseforge.com/v1";
const CURSEFORGE_HYTALE_GAME_ID = 70216;
const CURSEFORGE_HYTALE_MODS_CLASS_ID = 9137;

const MARKETPLACES = {
    modtale: {
        hosts: new Set(["modtale.net", "www.modtale.net"]),
        endpoint: (slug) => `https://api.modtale.net/api/v1/projects/${encodeURIComponent(slug)}`,
        headers: () => process.env.MODTALE_API_KEY
            ? { "X-MODTALE-KEY": process.env.MODTALE_API_KEY }
            : {},
        field: "downloadCount",
        pathPattern: /^\/mod\/([^/]+)\/?$/i
    },
    modifold: {
        hosts: new Set(["modifold.com", "www.modifold.com"]),
        endpoint: (slug) => `https://api.modifold.com/projects/${encodeURIComponent(slug)}`,
        headers: () => ({}),
        field: "downloads",
        pathPattern: /^\/mod\/([^/]+)\/?$/i
    },
    curseforge: {
        hosts: new Set(["curseforge.com", "www.curseforge.com"]),
        pathPattern: /^\/hytale\/mods\/([^/]+)\/?$/i
    }
};

export function extractMarketplaceSlug(link, marketplace) {
    const config = MARKETPLACES[marketplace];
    if (!config || typeof link !== "string" || !link.trim()) {
        return "";
    }

    try {
        const parsed = new URL(link.trim());
        if (parsed.protocol !== "https:" || !config.hosts.has(parsed.hostname.toLowerCase())) {
            return "";
        }
        const match = parsed.pathname.match(config.pathPattern);
        return match ? decodeURIComponent(match[1]).trim() : "";
    } catch {
        return "";
    }
}

function normalizeDownloadCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

async function fetchMarketplaceDownloadCount(marketplace, slug) {
    const config = MARKETPLACES[marketplace];
    if (!config || !slug) {
        return null;
    }

    const cacheKey = `${marketplace}:${slug}`;
    const now = Date.now();
    const cached = downloadCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    const request = axios.get(config.endpoint(slug), {
        headers: config.headers(),
        timeout: 5000,
        validateStatus: (status) => status >= 200 && status < 300
    }).then((response) => {
        const value = normalizeDownloadCount(response?.data?.[config.field]);
        downloadCache.set(cacheKey, {
            value,
            expiresAt: Date.now() + MARKETPLACE_DOWNLOAD_CACHE_MS
        });
        return value;
    }).catch((error) => {
        console.warn(`Could not fetch ${marketplace} downloads for ${slug}: ${error.message}`);
        downloadCache.set(cacheKey, {
            value: null,
            expiresAt: Date.now() + MARKETPLACE_DOWNLOAD_FAILURE_CACHE_MS
        });
        return null;
    }).finally(() => {
        pendingRequests.delete(cacheKey);
    });

    pendingRequests.set(cacheKey, request);
    return request;
}

export function findExactCurseforgeProject(projects, slug) {
    if (!Array.isArray(projects) || !slug) {
        return null;
    }
    const normalizedSlug = String(slug).trim().toLowerCase();
    return projects.find((project) => (
        Number(project?.gameId) === CURSEFORGE_HYTALE_GAME_ID
        && Number(project?.classId) === CURSEFORGE_HYTALE_MODS_CLASS_ID
        && String(project?.slug || "").trim().toLowerCase() === normalizedSlug
    )) || null;
}

async function fetchCurseforgeDownloadCount(slug) {
    if (!slug || !process.env.CURSEFORGE_API_KEY) {
        return null;
    }

    const normalizedSlug = slug.toLowerCase();
    const cacheKey = `curseforge:${normalizedSlug}`;
    const now = Date.now();
    const cached = downloadCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    const request = (async () => {
        const headers = { "x-api-key": process.env.CURSEFORGE_API_KEY };
        const cachedProjectId = curseforgeProjectIds.get(normalizedSlug);
        let project;

        if (cachedProjectId) {
            const response = await axios.get(`${CURSEFORGE_API_ROOT}/mods/${cachedProjectId}`, {
                headers,
                timeout: 5000
            });
            project = response?.data?.data;
        } else {
            const response = await axios.get(`${CURSEFORGE_API_ROOT}/mods/search`, {
                headers,
                params: {
                    gameId: CURSEFORGE_HYTALE_GAME_ID,
                    classId: CURSEFORGE_HYTALE_MODS_CLASS_ID,
                    slug,
                    pageSize: 10
                },
                timeout: 5000
            });
            project = findExactCurseforgeProject(response?.data?.data, slug);
            if (project?.id) {
                curseforgeProjectIds.set(normalizedSlug, project.id);
            }
        }

        const value = normalizeDownloadCount(project?.downloadCount);
        downloadCache.set(cacheKey, {
            value,
            expiresAt: Date.now() + MARKETPLACE_DOWNLOAD_CACHE_MS
        });
        return value;
    })().catch((error) => {
        console.warn(`Could not fetch curseforge downloads for ${slug}: ${error.message}`);
        downloadCache.set(cacheKey, {
            value: null,
            expiresAt: Date.now() + MARKETPLACE_DOWNLOAD_FAILURE_CACHE_MS
        });
        return null;
    }).finally(() => {
        pendingRequests.delete(cacheKey);
    });

    pendingRequests.set(cacheKey, request);
    return request;
}

export async function getMarketplaceDownloadCounts({ curseforgeLink = "", modtaleLink = "", modifoldLink = "" } = {}) {
    const curseforgeSlug = extractMarketplaceSlug(curseforgeLink, "curseforge");
    const modtaleSlug = extractMarketplaceSlug(modtaleLink, "modtale");
    const modifoldSlug = extractMarketplaceSlug(modifoldLink, "modifold");
    const [curseforge, modtale, modifold] = await Promise.all([
        fetchCurseforgeDownloadCount(curseforgeSlug),
        fetchMarketplaceDownloadCount("modtale", modtaleSlug),
        fetchMarketplaceDownloadCount("modifold", modifoldSlug)
    ]);

    return { curseforge, modtale, modifold };
}
