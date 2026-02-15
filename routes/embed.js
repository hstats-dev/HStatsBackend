import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPlugin } from "../databases/plugindb.js";
import { getServersUsingPlugin } from "../databases/serversdb.js";

const router = express.Router();
const TARGET_URL = "https://hstats.dev";

const routeDir = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.resolve(routeDir, "../assets/logo.svg");

const LAYOUT_SIZE_PRESETS = {
    compact: {
        sm: { width: 520, height: 146 },
        md: { width: 620, height: 170 },
        lg: { width: 760, height: 210 }
    },
    stacked: {
        sm: { width: 420, height: 180 },
        md: { width: 500, height: 220 },
        lg: { width: 620, height: 260 }
    }
};

const THEMES = {
    light: {
        bg: "#ffffff",
        text: "#0f0f10",
        muted: "rgba(15,15,16,0.68)",
        border: "#111111",
        divider: "rgba(17,17,17,0.16)",
        panel: "#ffffff",
        panelBorder: "rgba(17,17,17,0.22)",
        logoFallbackBg: "#111111",
        logoFallbackText: "#ffffff"
    },
    dark: {
        bg: "#101319",
        text: "#f8f9fb",
        muted: "rgba(248,249,251,0.72)",
        border: "#f8f9fb",
        divider: "rgba(248,249,251,0.22)",
        panel: "#151a23",
        panelBorder: "rgba(248,249,251,0.26)",
        logoFallbackBg: "#f8f9fb",
        logoFallbackText: "#101319"
    }
};

function parsePositiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

const EMBED_CACHE_TTL_MS = parsePositiveIntEnv("EMBED_CACHE_TTL_MS", 60_000);
const EMBED_CACHE_MAX_ENTRIES = parsePositiveIntEnv("EMBED_CACHE_MAX_ENTRIES", 500);
const embedCache = new Map();

function getCachedSvg(cacheKey) {
    const cached = embedCache.get(cacheKey);
    if (!cached) {
        return null;
    }

    if (cached.expiresAt <= Date.now()) {
        embedCache.delete(cacheKey);
        return null;
    }

    // keep entries hot in insertion order (simple LRU behavior)
    embedCache.delete(cacheKey);
    embedCache.set(cacheKey, cached);
    return cached.svg;
}

function setCachedSvg(cacheKey, svg) {
    if (EMBED_CACHE_MAX_ENTRIES < 1) {
        return;
    }

    embedCache.delete(cacheKey);
    embedCache.set(cacheKey, {
        svg,
        expiresAt: Date.now() + EMBED_CACHE_TTL_MS
    });

    while (embedCache.size > EMBED_CACHE_MAX_ENTRIES) {
        const oldestKey = embedCache.keys().next().value;
        embedCache.delete(oldestKey);
    }
}

function loadLogoDataUri() {
    try {
        const logoSvg = fs.readFileSync(logoPath, "utf8");
        const encoded = Buffer.from(logoSvg, "utf8").toString("base64");
        return `data:image/svg+xml;base64,${encoded}`;
    } catch (error) {
        console.warn(`Could not read logo file at ${logoPath}. Using text fallback.`);
        return null;
    }
}

const logoDataUri = loadLogoDataUri();
const numFmt = new Intl.NumberFormat("en-US");

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function truncateText(value, maxLength) {
    const text = String(value || "");
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
}

function formatNumber(value) {
    return numFmt.format(value);
}

function parseBool(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }
    return fallback;
}

function parseEnum(value, allowed, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

function getEmbedOptions(query = {}) {
    const layout = parseEnum(query.layout, ["compact", "stacked"], "compact");
    const size = parseEnum(query.size, ["sm", "md", "lg"], "md");

    let theme = parseEnum(query.theme, ["light", "dark"], "light");
    if (parseBool(query.dark, false)) {
        theme = "dark";
    }

    return {
        layout,
        size,
        theme,
        showId: parseBool(query.show_id, true)
    };
}

function renderLogo({ x, y, size, theme }) {
    if (logoDataUri) {
        return `<image href="${logoDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
    }

    const textX = x + (size / 2);
    const textY = y + (size * 0.62);
    return `
        <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.16)}" fill="${theme.logoFallbackBg}"/>
        <text x="${textX}" y="${textY}" fill="${theme.logoFallbackText}" font-family="Arial, sans-serif" font-size="${Math.round(size * 0.38)}" font-weight="700" text-anchor="middle">H</text>
    `;
}

function getNameFontSize(textLength, height) {
    if (textLength <= 20) {
        return Math.round(height * 0.18);
    }
    if (textLength <= 28) {
        return Math.round(height * 0.155);
    }
    if (textLength <= 34) {
        return Math.round(height * 0.14);
    }
    return Math.round(height * 0.125);
}

function wrapCardContent(content) {
    return `
    <a href="${TARGET_URL}" target="_blank" rel="noopener noreferrer" style="cursor:pointer;">
        ${content}
    </a>`;
}

function renderCompactLayout(data, options, theme, width, height) {
    const padding = Math.round(width * 0.03);
    const leftColWidth = Math.round(width * 0.19);
    const contentX = padding + leftColWidth + Math.round(width * 0.01);
    const rightEdge = width - padding;
    const contentWidth = rightEdge - contentX;

    const logoSize = Math.round(height * 0.34);
    const logoX = padding + Math.round((leftColWidth - logoSize) / 2);
    const logoY = Math.round(height * 0.12);
    const watermarkX = padding + Math.round(leftColWidth / 2);

    const titleY = Math.round(height * 0.2);
    const nameY = Math.round(height * 0.4);
    const idY = Math.round(height * 0.53);
    const statsY = options.showId ? Math.round(height * 0.62) : Math.round(height * 0.57);
    const statH = Math.round(height * 0.27);
    const gap = Math.max(10, Math.round(width * 0.018));
    const statW = Math.floor((contentWidth - gap) / 2);

    const nameFontSize = getNameFontSize(data.name.length, height);

    const logoBlock = `
        ${renderLogo({ x: logoX, y: logoY, size: logoSize, theme })}
        <text x="${watermarkX}" y="${logoY + logoSize + Math.round(height * 0.14)}" fill="${theme.text}" fill-opacity="0.88" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.09)}" font-weight="800" text-anchor="middle">hstats.dev</text>
        <text x="${watermarkX}" y="${logoY + logoSize + Math.round(height * 0.24)}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.06)}" font-weight="600" text-anchor="middle">Live Plugin Stats</text>`;

    const main = `
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" fill="${theme.bg}" stroke="${theme.border}" stroke-width="2"/>
        <line x1="${padding + leftColWidth}" y1="${Math.round(height * 0.08)}" x2="${padding + leftColWidth}" y2="${Math.round(height * 0.92)}" stroke="${theme.divider}"/>
        ${logoBlock}

        <text x="${contentX}" y="${titleY}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.07)}" font-weight="700" letter-spacing="0.8">PLUGIN METRICS</text>
        <text x="${contentX}" y="${nameY}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${nameFontSize}" font-weight="800">${data.name}</text>

        <g transform="translate(${contentX} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="8" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="14" y="${Math.round(statH * 0.37)}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.6">SERVERS</text>
            <text x="14" y="${Math.round(statH * 0.78)}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.12)}" font-weight="800">${data.servers}</text>
        </g>

        <g transform="translate(${contentX + statW + gap} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="8" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="14" y="${Math.round(statH * 0.37)}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.6">PLAYERS</text>
            <text x="14" y="${Math.round(statH * 0.78)}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.12)}" font-weight="800">${data.players}</text>
        </g>`;

    return wrapCardContent(main);
}

function renderStackedLayout(data, options, theme, width, height) {
    const padding = Math.round(width * 0.05);
    const topRowHeight = options.showId ? Math.round(height * 0.56) : Math.round(height * 0.5);
    const logoSize = Math.round(height * 0.24);

    const logoX = padding;
    const logoY = padding;

    const headerX = logoX + logoSize + Math.round(width * 0.03);
    const titleY = padding + Math.round(height * 0.09);
    const nameY = titleY + Math.round(height * 0.17);
    const idY = nameY + Math.round(height * 0.11);

    const watermarkX = width - padding;
    const watermarkY = padding + Math.round(height * 0.1);

    const gap = Math.round(width * 0.03);
    const statY = topRowHeight;
    const statH = height - statY - padding;
    const statW = Math.floor((width - (padding * 2) - gap) / 2);

    const nameFontSize = getNameFontSize(data.name.length, height);
    const idText = options.showId
        ? `<text x="${headerX}" y="${idY}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.055)}" font-weight="600">MOD ID: ${data.modId}</text>`
        : "";

    const main = `
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" fill="${theme.bg}" stroke="${theme.border}" stroke-width="2"/>
        ${renderLogo({ x: logoX, y: logoY, size: logoSize, theme })}
        <text x="${watermarkX}" y="${watermarkY}" fill="${theme.text}" fill-opacity="0.85" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.08)}" font-weight="800" text-anchor="end">hstats.dev</text>

        <text x="${headerX}" y="${titleY}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.8">PLUGIN METRICS</text>
        <text x="${headerX}" y="${nameY}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${nameFontSize}" font-weight="800">${data.name}</text>
        ${idText}

        <g transform="translate(${padding} ${statY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="10" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="16" y="${Math.round(statH * 0.36)}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.055)}" font-weight="700">SERVERS</text>
            <text x="16" y="${Math.round(statH * 0.75)}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.11)}" font-weight="800">${data.servers}</text>
        </g>

        <g transform="translate(${padding + statW + gap} ${statY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="10" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="16" y="${Math.round(statH * 0.36)}" fill="${theme.muted}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.055)}" font-weight="700">PLAYERS</text>
            <text x="16" y="${Math.round(statH * 0.75)}" fill="${theme.text}" font-family="Arial, sans-serif" font-size="${Math.round(height * 0.11)}" font-weight="800">${data.players}</text>
        </g>`;

    return wrapCardContent(main);
}

function renderCardSvg(data, options) {
    const dims = LAYOUT_SIZE_PRESETS[options.layout][options.size];
    const width = dims.width;
    const height = dims.height;
    const theme = THEMES[options.theme];

    const cardContent = options.layout === "stacked"
        ? renderStackedLayout(data, options, theme, width, height)
        : renderCompactLayout(data, options, theme, width, height);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${data.name} usage card">
    ${cardContent}
</svg>`;
}

router.get("/:mod/card.svg", (req, res) => {
    const { mod } = req.params || {};
    if (typeof mod !== "string" || !mod.trim()) {
        return res.status(400).json({ error: "Invalid mod identifier" });
    }

    const options = getEmbedOptions(req.query || {});

    const modId = mod.trim();
    const cacheKey = `${modId}|${options.layout}|${options.size}|${options.theme}|show_id:${options.showId ? 1 : 0}`;
    const cachedSvg = getCachedSvg(cacheKey);
    if (cachedSvg) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("X-Embed-Cache", "HIT");
        res.send(cachedSvg);
        return;
    }

    const plugin = getPlugin(modId);
    const servers = getServersUsingPlugin(modId);

    let playerCount = 0;
    servers.forEach(server => {
        const players = Number(server.players_online) || 0;
        playerCount += players;
    });

    const pluginDisplayName = truncateText(plugin?.name || "Unknown Plugin", 36);

    const data = {
        name: escapeXml(pluginDisplayName),
        modId: escapeXml(truncateText(modId, 44)),
        servers: formatNumber(servers.length),
        players: formatNumber(playerCount)
    };

    const svg = renderCardSvg(data, options);
    setCachedSvg(cacheKey, svg);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("X-Embed-Cache", "MISS");
    res.send(svg);
});

export default router;
