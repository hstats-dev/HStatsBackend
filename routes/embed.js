import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPlugin, getPluginByPublicUUID } from "../databases/plugindb.js";
import { getAccountById, getPluginsAccess } from "../databases/accountsdb.js";
import { getServersUsingPlugin } from "../databases/serversdb.js";
import { getPluginAllTimePeak, getPluginDailyStatsLastDays } from "../databases/pluginstatsdb.js";
import { embedGetRateLimiter } from "../middleware/rateLimiters.js";

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
    },
    history: {
        sm: { width: 620, height: 220 },
        md: { width: 760, height: 280 },
        lg: { width: 920, height: 340 }
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
        chartBg: "#fbfdff",
        chartGrid: "rgba(15,15,16,0.14)",
        chartAxis: "rgba(15,15,16,0.34)",
        serversLine: "#dc2626",
        serversFill: "rgba(220,38,38,0.16)",
        playersLine: "#16a34a",
        playersFill: "rgba(22,163,74,0.16)",
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
        chartBg: "#131925",
        chartGrid: "rgba(248,249,251,0.16)",
        chartAxis: "rgba(248,249,251,0.34)",
        serversLine: "#f87171",
        serversFill: "rgba(248,113,113,0.2)",
        playersLine: "#4ade80",
        playersFill: "rgba(74,222,128,0.2)",
        logoFallbackBg: "#f8f9fb",
        logoFallbackText: "#101319"
    },
    github: {
        bg: "#0d1117",
        text: "#f0f6fc",
        muted: "rgba(240,246,252,0.72)",
        border: "#30363d",
        divider: "rgba(240,246,252,0.18)",
        panel: "#161b22",
        panelBorder: "rgba(240,246,252,0.2)",
        chartBg: "#0d1117",
        chartGrid: "rgba(240,246,252,0.14)",
        chartAxis: "rgba(240,246,252,0.34)",
        serversLine: "#ff7b72",
        serversFill: "rgba(255,123,114,0.18)",
        playersLine: "#3fb950",
        playersFill: "rgba(63,185,80,0.18)",
        logoFallbackBg: "#f0f6fc",
        logoFallbackText: "#0d1117"
    },
    terminal: {
        bg: "#050807",
        text: "#d7ffe8",
        muted: "rgba(215,255,232,0.66)",
        border: "#35f08a",
        divider: "rgba(53,240,138,0.22)",
        panel: "#08120d",
        panelBorder: "rgba(53,240,138,0.28)",
        chartBg: "#020403",
        chartGrid: "rgba(53,240,138,0.16)",
        chartAxis: "rgba(53,240,138,0.36)",
        serversLine: "#facc15",
        serversFill: "rgba(250,204,21,0.16)",
        playersLine: "#35f08a",
        playersFill: "rgba(53,240,138,0.18)",
        logoFallbackBg: "#35f08a",
        logoFallbackText: "#050807"
    },
    forest: {
        bg: "#f7faf4",
        text: "#172319",
        muted: "rgba(23,35,25,0.66)",
        border: "#49633f",
        divider: "rgba(73,99,63,0.22)",
        panel: "#ffffff",
        panelBorder: "rgba(73,99,63,0.28)",
        chartBg: "#eef5eb",
        chartGrid: "rgba(23,35,25,0.14)",
        chartAxis: "rgba(23,35,25,0.34)",
        serversLine: "#b45309",
        serversFill: "rgba(180,83,9,0.16)",
        playersLine: "#15803d",
        playersFill: "rgba(21,128,61,0.18)",
        logoFallbackBg: "#172319",
        logoFallbackText: "#ffffff"
    },
    ember: {
        bg: "#180f0b",
        text: "#fff7ed",
        muted: "rgba(255,247,237,0.72)",
        border: "#f97316",
        divider: "rgba(249,115,22,0.24)",
        panel: "#23130d",
        panelBorder: "rgba(249,115,22,0.34)",
        chartBg: "#1f120d",
        chartGrid: "rgba(255,247,237,0.14)",
        chartAxis: "rgba(255,247,237,0.34)",
        serversLine: "#fb7185",
        serversFill: "rgba(251,113,133,0.2)",
        playersLine: "#facc15",
        playersFill: "rgba(250,204,21,0.18)",
        logoFallbackBg: "#fff7ed",
        logoFallbackText: "#180f0b"
    }
};

const FONT_FAMILIES = {
    arial: "Arial, sans-serif",
    system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    verdana: "Verdana, Geneva, sans-serif",
    georgia: "Georgia, serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
};

const COLOR_OPTION_MAP = [
    { query: "bg", themeKey: "bg", allowTransparent: true },
    { query: "backgroundColor", themeKey: "bg", allowTransparent: true },
    { query: "text", themeKey: "text" },
    { query: "muted", themeKey: "muted" },
    { query: "border", themeKey: "border" },
    { query: "divider", themeKey: "divider" },
    { query: "panel", themeKey: "panel", allowTransparent: true },
    { query: "panelBorder", themeKey: "panelBorder" },
    { query: "chartBg", themeKey: "chartBg", allowTransparent: true },
    { query: "chartGrid", themeKey: "chartGrid" },
    { query: "chartAxis", themeKey: "chartAxis" },
    { query: "serversColor", themeKey: "serversLine", fillKey: "serversFill", fillAlpha: 0.18 },
    { query: "playersColor", themeKey: "playersLine", fillKey: "playersFill", fillAlpha: 0.18 }
];

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

function getFirstQueryValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function hasQueryValue(value) {
    const raw = getFirstQueryValue(value);
    return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

function parseSvgColor(value, { allowTransparent = false } = {}) {
    const rawValue = getFirstQueryValue(value);
    if (rawValue === undefined || rawValue === null || rawValue === "") {
        return null;
    }

    const raw = String(rawValue).trim();
    if (allowTransparent && raw.toLowerCase() === "transparent") {
        return "transparent";
    }

    const normalized = raw.startsWith("#") ? raw.slice(1) : raw;
    if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
        return `#${normalized.split("").map((char) => char + char).join("").toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return `#${normalized.toLowerCase()}`;
    }
    return null;
}

function hexToRgba(hexColor, alpha) {
    const normalized = parseSvgColor(hexColor);
    if (!normalized) {
        return null;
    }

    const hex = normalized.slice(1);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function parseIntegerRange(value, min, max) {
    if (!hasQueryValue(value)) {
        return null;
    }

    const parsed = Number.parseInt(String(getFirstQueryValue(value)).trim(), 10);
    if (!Number.isInteger(parsed)) {
        return null;
    }
    return Math.min(max, Math.max(min, parsed));
}

function getEmbedOptions(query = {}) {
    const layout = parseEnum(query.layout, ["compact", "stacked", "history"], "compact");
    const size = parseEnum(query.size, ["sm", "md", "lg"], "md");

    let theme = parseEnum(query.theme, Object.keys(THEMES), "light");
    if (parseBool(query.dark, false)) {
        theme = "dark";
    }

    const font = parseEnum(query.font, Object.keys(FONT_FAMILIES), "arial");
    const background = parseEnum(query.background, ["solid", "transparent"], "solid");
    const radius = parseIntegerRange(query.radius, 0, 24);
    const borderWidth = parseIntegerRange(query.borderWidth, 0, 4);
    const colorOverrides = {};
    const styleKeyParts = [];

    if (hasQueryValue(query.font) && font !== "arial") {
        styleKeyParts.push(`font:${font}`);
    }
    if (background === "transparent") {
        styleKeyParts.push("background:transparent");
    }
    if (radius !== null) {
        styleKeyParts.push(`radius:${radius}`);
    }
    if (borderWidth !== null) {
        styleKeyParts.push(`borderWidth:${borderWidth}`);
    }

    COLOR_OPTION_MAP.forEach((option) => {
        const parsedColor = parseSvgColor(query[option.query], { allowTransparent: option.allowTransparent });
        if (!parsedColor) {
            return;
        }
        colorOverrides[option.themeKey] = parsedColor;
        styleKeyParts.push(`${option.query}:${parsedColor}`);
        if (option.fillKey && parsedColor !== "transparent") {
            const fillColor = hexToRgba(parsedColor, option.fillAlpha);
            if (fillColor) {
                colorOverrides[option.fillKey] = fillColor;
            }
        }
    });

    return {
        layout,
        size,
        theme,
        font,
        background,
        radius,
        borderWidth,
        colorOverrides,
        styleKey: styleKeyParts.join("|")
    };
}

function resolveCardTheme(options) {
    const theme = {
        ...THEMES[options.theme],
        ...options.colorOverrides
    };

    if (options.background === "transparent") {
        theme.bg = "transparent";
    }

    const customRadius = options.radius !== null;
    theme.fontFamily = FONT_FAMILIES[options.font] || FONT_FAMILIES.arial;
    theme.cardRadius = customRadius ? options.radius : 14;
    theme.compactPanelRadius = customRadius ? Math.max(0, Math.min(20, options.radius)) : 8;
    theme.stackedPanelRadius = customRadius ? Math.max(0, Math.min(20, options.radius)) : 10;
    theme.chartPanelRadius = customRadius ? Math.max(0, Math.min(20, options.radius)) : 10;
    theme.borderWidth = options.borderWidth !== null ? options.borderWidth : 2;

    return theme;
}

function buildEmbedCacheKey(...parts) {
    return parts.filter((part) => part !== undefined && part !== null && part !== "").join("|");
}

function renderLogo({ x, y, size, theme }) {
    if (logoDataUri) {
        return `<image href="${logoDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
    }

    const textX = x + (size / 2);
    const textY = y + (size * 0.62);
    return `
        <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.16)}" fill="${theme.logoFallbackBg}"/>
        <text x="${textX}" y="${textY}" fill="${theme.logoFallbackText}" font-family="${theme.fontFamily}" font-size="${Math.round(size * 0.38)}" font-weight="700" text-anchor="middle">H</text>
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

function getUtcTodayDayString() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function formatDayLabel(day) {
    const dayText = String(day || "");
    const isoHourMatch = dayText.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}Z$/);
    if (isoHourMatch) {
        const month = Number(isoHourMatch[2]);
        const date = Number(isoHourMatch[3]);
        const hour24 = Number(isoHourMatch[4]);
        if (Number.isInteger(month) && Number.isInteger(date) && Number.isInteger(hour24)) {
            const hour12 = ((hour24 + 11) % 12) + 1;
            const amPm = hour24 >= 12 ? "PM" : "AM";
            return `${month}/${date} @ ${hour12}${amPm}`;
        }
        return dayText;
    }

    const sqlHourMatch = dayText.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):\d{2}:\d{2}$/);
    if (sqlHourMatch) {
        const month = Number(sqlHourMatch[2]);
        const date = Number(sqlHourMatch[3]);
        const hour24 = Number(sqlHourMatch[4]);
        if (Number.isInteger(month) && Number.isInteger(date) && Number.isInteger(hour24)) {
            const hour12 = ((hour24 + 11) % 12) + 1;
            const amPm = hour24 >= 12 ? "PM" : "AM";
            return `${month}/${date} @ ${hour12}${amPm}`;
        }
        return dayText;
    }

    const parts = dayText.split("-");
    if (parts.length !== 3) {
        return dayText;
    }
    const month = Number(parts[1]);
    const date = Number(parts[2]);
    if (!Number.isInteger(month) || !Number.isInteger(date)) {
        return dayText;
    }
    return `${month}/${date}`;
}

function buildSeriesPaths(values, chartX, chartY, chartW, chartH, maxValue) {
    if (!Array.isArray(values) || values.length < 1) {
        return { linePath: "", areaPath: "", points: [] };
    }

    const yMax = Math.max(1, Number(maxValue) || 1);
    const stepX = values.length > 1 ? chartW / (values.length - 1) : 0;

    const points = values.map((value, index) => {
        const safeValue = Math.max(0, Number(value) || 0);
        const normalized = safeValue / yMax;
        const x = chartX + (index * stepX);
        const y = chartY + chartH - (normalized * chartH);
        return { x, y };
    });

    const linePath = points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
        .join(" ");

    const lastPoint = points[points.length - 1];
    const firstPoint = points[0];
    const areaPath = `${linePath} L${lastPoint.x.toFixed(2)} ${(chartY + chartH).toFixed(2)} L${firstPoint.x.toFixed(2)} ${(chartY + chartH).toFixed(2)} Z`;

    return { linePath, areaPath, points };
}

function wrapCardContent(content, targetUrl = TARGET_URL) {
    return `
    <a href="${targetUrl}" target="_blank" rel="noopener noreferrer" style="cursor:pointer;">
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
    const statsY = Math.round(height * 0.57);
    const statH = Math.round(height * 0.27);
    const gap = Math.max(10, Math.round(width * 0.018));
    const statW = Math.floor((contentWidth - gap) / 2);

    const nameFontSize = getNameFontSize(data.name.length, height);
    const kickerText = escapeXml(data.kicker || "PLUGIN METRICS");
    const subtitleText = escapeXml(data.subtitle || "");

    const logoBlock = `
        ${renderLogo({ x: logoX, y: logoY, size: logoSize, theme })}
        <text x="${watermarkX}" y="${logoY + logoSize + Math.round(height * 0.14)}" fill="${theme.text}" fill-opacity="0.88" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.09)}" font-weight="800" text-anchor="middle">hstats.dev</text>
        <text x="${watermarkX}" y="${logoY + logoSize + Math.round(height * 0.24)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.06)}" font-weight="600" text-anchor="middle">Live Plugin Stats</text>`;

    const main = `
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${theme.cardRadius}" fill="${theme.bg}" stroke="${theme.border}" stroke-width="${theme.borderWidth}"/>
        <line x1="${padding + leftColWidth}" y1="${Math.round(height * 0.08)}" x2="${padding + leftColWidth}" y2="${Math.round(height * 0.92)}" stroke="${theme.divider}"/>
        ${logoBlock}

        <text x="${contentX}" y="${titleY}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.07)}" font-weight="700" letter-spacing="0.8">${kickerText}</text>
        <text x="${contentX}" y="${nameY}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${nameFontSize}" font-weight="800">${data.name}</text>
        ${subtitleText ? `<text x="${contentX}" y="${nameY + Math.round(height * 0.11)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.06)}" font-weight="600">${subtitleText}</text>` : ""}

        <g transform="translate(${contentX} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.compactPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="14" y="${Math.round(statH * 0.37)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.6">SERVERS</text>
            <text x="14" y="${Math.round(statH * 0.78)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.12)}" font-weight="800">${data.servers}</text>
        </g>

        <g transform="translate(${contentX + statW + gap} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.compactPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="14" y="${Math.round(statH * 0.37)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.6">PLAYERS</text>
            <text x="14" y="${Math.round(statH * 0.78)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.12)}" font-weight="800">${data.players}</text>
        </g>`;

    return wrapCardContent(main, data.targetUrl);
}

function renderHistoryLayout(data, options, theme, width, height) {
    const padding = Math.round(width * 0.04);
    const headerHeight = Math.round(height * 0.35);
    const chartPanelY = padding + headerHeight;
    const chartPanelH = height - chartPanelY - padding;
    const chartPanelW = width - (padding * 2);
    const chartPanelX = padding;

    const logoSize = Math.round(headerHeight * 0.54);
    const logoX = padding;
    const logoY = padding + Math.round(headerHeight * 0.04);
    const titleX = logoX + logoSize + Math.round(width * 0.018);
    const titleY = logoY + Math.round(headerHeight * 0.12);
    const nameY = titleY + Math.round(headerHeight * 0.36);
    const subtitleY = nameY + Math.round(headerHeight * 0.22);
    const subtitleY2 = subtitleY + Math.round(headerHeight * 0.22);

    const statW = Math.round(width * 0.15);
    const statH = Math.round(headerHeight * 0.56);
    const statGap = Math.round(width * 0.014);
    const statsX = width - padding - statW;
    const statsX2 = statsX - statW - statGap;
    const statsY = padding + Math.round(headerHeight * 0.06);

    const chartInsetX = Math.round(chartPanelW * 0.05);
    const chartInsetTop = Math.round(chartPanelH * 0.14);
    const chartInsetBottom = Math.round(chartPanelH * 0.24);
    const plotX = chartPanelX + chartInsetX;
    const plotY = chartPanelY + chartInsetTop;
    const plotW = chartPanelW - (chartInsetX * 2);
    const plotH = chartPanelH - chartInsetTop - chartInsetBottom;

    const historyPoints = Array.isArray(data.history) ? data.history : [];
    const yMax = Math.max(
        1,
        ...historyPoints.map((point) => Math.max(point.serversCount, point.playersCount))
    );

    const serverValues = historyPoints.map((point) => point.serversCount);
    const playerValues = historyPoints.map((point) => point.playersCount);
    const serversSeries = buildSeriesPaths(serverValues, plotX, plotY, plotW, plotH, yMax);
    const playersSeries = buildSeriesPaths(playerValues, plotX, plotY, plotW, plotH, yMax);

    const latestServers = serverValues.length > 0 ? serverValues[serverValues.length - 1] : 0;
    const latestPlayers = playerValues.length > 0 ? playerValues[playerValues.length - 1] : 0;
    const peakServers = serverValues.length > 0 ? Math.max(...serverValues) : 0;
    const peakPlayers = playerValues.length > 0 ? Math.max(...playerValues) : 0;
    const latestServersPoint = serversSeries.points[serversSeries.points.length - 1];
    const latestPlayersPoint = playersSeries.points[playersSeries.points.length - 1];
    const kickerText = escapeXml(data.historyKicker || "PLUGIN HISTORY (HOURLY PEAKS)");
    const isLegacyColorSubtitle = ["light", "dark"].includes(options.theme) && !options.styleKey;
    const defaultSubtitle = isLegacyColorSubtitle
        ? "30-day hourly trend (UTC). Red = servers, green = players."
        : "30-day hourly trend (UTC). Servers and players shown below.";
    const rawSubtitle = data.historySubtitle || defaultSubtitle;
    const subtitleText = escapeXml(isLegacyColorSubtitle
        ? rawSubtitle
        : rawSubtitle.replace("Red = servers, green = players.", "Servers and players shown below."));
    const peakSummaryLabel = escapeXml(data.peakSummaryLabel || "All-time");

    const gridLines = [0, 1, 2, 3].map((index) => {
        const ratio = index / 3;
        const y = plotY + (plotH * ratio);
        const value = Math.round(yMax * (1 - ratio));
        return `
            <line x1="${plotX}" y1="${y.toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${theme.chartGrid}" />
            <text x="${(plotX - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.036)}">${formatNumber(value)}</text>
        `;
    }).join("");

    const firstDay = historyPoints.length > 0 ? formatDayLabel(historyPoints[0].day) : formatDayLabel(getUtcTodayDayString());
    const lastDay = historyPoints.length > 0 ? formatDayLabel(historyPoints[historyPoints.length - 1].day) : formatDayLabel(getUtcTodayDayString());

    const noDataText = data.historySourceRows === 0
        ? `<text x="${(plotX + (plotW / 2)).toFixed(2)}" y="${(plotY + (plotH / 2)).toFixed(2)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.045)}" text-anchor="middle">No history yet. Showing current snapshot.</text>`
        : "";

    const allTimePeakText = `${peakSummaryLabel}: ${data.allTimePeakServers} servers | ${data.allTimePeakPlayers} players`;

    const main = `
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${theme.cardRadius}" fill="${theme.bg}" stroke="${theme.border}" stroke-width="${theme.borderWidth}"/>
        ${renderLogo({ x: logoX, y: logoY, size: logoSize, theme })}
        <text x="${titleX}" y="${titleY}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.036)}" font-weight="700" letter-spacing="0.8">${kickerText}</text>
        <text x="${titleX}" y="${nameY}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.075)}" font-weight="800">${data.name}</text>
        <text x="${titleX}" y="${subtitleY}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.036)}" font-weight="600">${subtitleText}</text>
        <text x="${titleX}" y="${subtitleY2}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.034)}" font-weight="600">${allTimePeakText}</text>
        <text x="${width - padding}" y="${padding + Math.round(height * 0.055)}" text-anchor="end" fill="${theme.text}" fill-opacity="0.86" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.05)}" font-weight="800">hstats.dev</text>

        <g transform="translate(${statsX2} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.compactPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="10" y="${Math.round(statH * 0.34)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.035)}" font-weight="700">SERVERS</text>
            <text x="10" y="${Math.round(statH * 0.73)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.058)}" font-weight="800">${data.servers}</text>
        </g>
        <g transform="translate(${statsX} ${statsY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.compactPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="10" y="${Math.round(statH * 0.34)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.035)}" font-weight="700">PLAYERS</text>
            <text x="10" y="${Math.round(statH * 0.73)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.058)}" font-weight="800">${data.players}</text>
        </g>

        <g>
            <rect x="${chartPanelX}" y="${chartPanelY}" width="${chartPanelW}" height="${chartPanelH}" rx="${theme.chartPanelRadius}" fill="${theme.chartBg}" stroke="${theme.panelBorder}" />
            ${gridLines}
            <line x1="${plotX}" y1="${(plotY + plotH).toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="${theme.chartAxis}" />
            <path d="${serversSeries.areaPath}" fill="${theme.serversFill}" />
            <path d="${playersSeries.areaPath}" fill="${theme.playersFill}" />
            <path d="${serversSeries.linePath}" fill="none" stroke="${theme.serversLine}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            <path d="${playersSeries.linePath}" fill="none" stroke="${theme.playersLine}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            ${latestServersPoint ? `<circle cx="${latestServersPoint.x.toFixed(2)}" cy="${latestServersPoint.y.toFixed(2)}" r="${Math.max(2, Math.round(height * 0.008))}" fill="${theme.serversLine}"/>` : ""}
            ${latestPlayersPoint ? `<circle cx="${latestPlayersPoint.x.toFixed(2)}" cy="${latestPlayersPoint.y.toFixed(2)}" r="${Math.max(2, Math.round(height * 0.008))}" fill="${theme.playersLine}"/>` : ""}
            <text x="${plotX}" y="${(plotY + plotH + Math.round(height * 0.085)).toFixed(2)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.036)}">${firstDay}</text>
            <text x="${(plotX + plotW).toFixed(2)}" y="${(plotY + plotH + Math.round(height * 0.085)).toFixed(2)}" text-anchor="end" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.036)}">${lastDay} UTC</text>
            <g transform="translate(${plotX} ${chartPanelY + Math.round(chartPanelH * 0.08)})">
                <circle cx="0" cy="0" r="${Math.max(2, Math.round(height * 0.007))}" fill="${theme.serversLine}" />
                <text x="${Math.round(width * 0.012)}" y="${Math.round(height * 0.012)}" fill="${theme.serversLine}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.034)}" font-weight="700">Servers: now ${formatNumber(latestServers)}, peak ${formatNumber(peakServers)}</text>
            </g>
            <g transform="translate(${plotX + Math.round(width * 0.39)} ${chartPanelY + Math.round(chartPanelH * 0.08)})">
                <circle cx="0" cy="0" r="${Math.max(2, Math.round(height * 0.007))}" fill="${theme.playersLine}" />
                <text x="${Math.round(width * 0.012)}" y="${Math.round(height * 0.012)}" fill="${theme.playersLine}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.034)}" font-weight="700">Players: now ${formatNumber(latestPlayers)}, peak ${formatNumber(peakPlayers)}</text>
            </g>
            ${noDataText}
        </g>
    `;

    return wrapCardContent(main, data.targetUrl);
}

function renderStackedLayout(data, options, theme, width, height) {
    const padding = Math.round(width * 0.05);
    const topRowHeight = Math.round(height * 0.5);
    const logoSize = Math.round(height * 0.24);

    const logoX = padding;
    const logoY = padding;

    const headerX = logoX + logoSize + Math.round(width * 0.03);
    const titleY = padding + Math.round(height * 0.09);
    const nameY = titleY + Math.round(height * 0.17);

    const watermarkX = width - padding;
    const watermarkY = padding + Math.round(height * 0.1);

    const gap = Math.round(width * 0.03);
    const statY = topRowHeight;
    const statH = height - statY - padding;
    const statW = Math.floor((width - (padding * 2) - gap) / 2);

    const nameFontSize = getNameFontSize(data.name.length, height);
    const kickerText = escapeXml(data.kicker || "PLUGIN METRICS");
    const subtitleText = escapeXml(data.subtitle || "");

    const main = `
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${theme.cardRadius}" fill="${theme.bg}" stroke="${theme.border}" stroke-width="${theme.borderWidth}"/>
        ${renderLogo({ x: logoX, y: logoY, size: logoSize, theme })}
        <text x="${watermarkX}" y="${watermarkY}" fill="${theme.text}" fill-opacity="0.85" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.08)}" font-weight="800" text-anchor="end">hstats.dev</text>

        <text x="${headerX}" y="${titleY}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.06)}" font-weight="700" letter-spacing="0.8">${kickerText}</text>
        <text x="${headerX}" y="${nameY}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${nameFontSize}" font-weight="800">${data.name}</text>
        ${subtitleText ? `<text x="${headerX}" y="${nameY + Math.round(height * 0.11)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.055)}" font-weight="600">${subtitleText}</text>` : ""}

        <g transform="translate(${padding} ${statY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.stackedPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="16" y="${Math.round(statH * 0.36)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.055)}" font-weight="700">SERVERS</text>
            <text x="16" y="${Math.round(statH * 0.75)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.11)}" font-weight="800">${data.servers}</text>
        </g>

        <g transform="translate(${padding + statW + gap} ${statY})">
            <rect x="0" y="0" width="${statW}" height="${statH}" rx="${theme.stackedPanelRadius}" fill="${theme.panel}" stroke="${theme.panelBorder}"/>
            <text x="16" y="${Math.round(statH * 0.36)}" fill="${theme.muted}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.055)}" font-weight="700">PLAYERS</text>
            <text x="16" y="${Math.round(statH * 0.75)}" fill="${theme.text}" font-family="${theme.fontFamily}" font-size="${Math.round(height * 0.11)}" font-weight="800">${data.players}</text>
        </g>`;

    return wrapCardContent(main, data.targetUrl);
}

function renderCardSvg(data, options) {
    const dims = LAYOUT_SIZE_PRESETS[options.layout][options.size];
    const width = dims.width;
    const height = dims.height;
    const theme = resolveCardTheme(options);

    let cardContent;
    if (options.layout === "stacked") {
        cardContent = renderStackedLayout(data, options, theme, width, height);
    } else if (options.layout === "history") {
        cardContent = renderHistoryLayout(data, options, theme, width, height);
    } else {
        cardContent = renderCompactLayout(data, options, theme, width, height);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${data.name} usage card">
    ${cardContent}
</svg>`;
}

function aggregateDeveloperLiveTotals(privatePluginUUIDs) {
    const uniqueServers = new Map();

    privatePluginUUIDs.forEach((pluginUUID) => {
        getServersUsingPlugin(pluginUUID).forEach((server) => {
            const serverUUID = String(server.uuid || "").trim();
            if (!serverUUID) {
                return;
            }

            const playersOnline = Math.max(0, Number(server.players_online) || 0);
            const existing = uniqueServers.get(serverUUID);
            if (!existing || playersOnline > existing.players_online) {
                uniqueServers.set(serverUUID, {
                    players_online: playersOnline
                });
            }
        });
    });

    let totalPlayers = 0;
    uniqueServers.forEach((server) => {
        totalPlayers += server.players_online;
    });

    return {
        serversCount: uniqueServers.size,
        playersCount: totalPlayers
    };
}

function aggregateDeveloperHistory(privatePluginUUIDs) {
    const byHour = new Map();

    privatePluginUUIDs.forEach((pluginUUID) => {
        const historyRows = getPluginDailyStatsLastDays(pluginUUID);
        historyRows.forEach((row) => {
            const hourKey = String(row.hour_start || row.day || "").trim();
            if (!hourKey) {
                return;
            }

            const current = byHour.get(hourKey) || {
                day: hourKey,
                serversCount: 0,
                playersCount: 0
            };
            current.serversCount += Math.max(0, Number(row.servers_count) || 0);
            current.playersCount += Math.max(0, Number(row.players_count) || 0);
            byHour.set(hourKey, current);
        });
    });

    return Array.from(byHour.values())
        .sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

function buildDeveloperEmbedData(developerUUID) {
    const account = getAccountById(developerUUID);
    if (!account || account.is_disabled) {
        return null;
    }

    const privatePluginUUIDs = Array.from(new Set(
        getPluginsAccess(account.id)
            .map((value) => String(value || "").trim())
            .filter(Boolean)
            .filter((pluginUUID) => !!getPlugin(pluginUUID))
    ));

    const liveTotals = aggregateDeveloperLiveTotals(privatePluginUUIDs);
    const history = aggregateDeveloperHistory(privatePluginUUIDs);
    const historyWithFallback = history.length > 0
        ? history
        : [{
            day: getUtcTodayDayString(),
            serversCount: liveTotals.serversCount,
            playersCount: liveTotals.playersCount
        }];

    const peakServersCount = historyWithFallback.reduce(
        (maxValue, point) => Math.max(maxValue, point.serversCount),
        liveTotals.serversCount
    );
    const peakPlayersCount = historyWithFallback.reduce(
        (maxValue, point) => Math.max(maxValue, point.playersCount),
        liveTotals.playersCount
    );

    return {
        name: escapeXml(truncateText(account.username?.trim() || "No Name", 36)),
        servers: formatNumber(liveTotals.serversCount),
        players: formatNumber(liveTotals.playersCount),
        allTimePeakServers: formatNumber(peakServersCount),
        allTimePeakPlayers: formatNumber(peakPlayersCount),
        history: historyWithFallback,
        historySourceRows: history.length,
        kicker: "DEVELOPER METRICS",
        subtitle: `${formatNumber(privatePluginUUIDs.length)} mods combined`,
        historyKicker: "DEVELOPER HISTORY (30-DAY AGGREGATE)",
        historySubtitle: "30-day combined plugin trend (UTC). Red = servers, green = players.",
        peakSummaryLabel: "30-day aggregate peak",
        targetUrl: `${TARGET_URL}/developer/${encodeURIComponent(account.id)}`
    };
}

router.get("/developer/:developer_uuid/card.svg", embedGetRateLimiter, (req, res) => {
    const developerUUID = typeof req.params?.developer_uuid === "string"
        ? req.params.developer_uuid.trim()
        : "";
    if (!developerUUID) {
        return res.status(400).json({ error: "Invalid developer identifier" });
    }

    const options = getEmbedOptions(req.query || {});
    const cacheKey = buildEmbedCacheKey("developer", developerUUID, options.layout, options.size, options.theme, options.styleKey);
    const cachedSvg = getCachedSvg(cacheKey);
    if (cachedSvg) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("X-Embed-Cache", "HIT");
        res.send(cachedSvg);
        return;
    }

    const data = buildDeveloperEmbedData(developerUUID);
    if (!data) {
        return res.status(404).json({ error: "Developer not found" });
    }

    const svg = renderCardSvg(data, options);
    setCachedSvg(cacheKey, svg);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("X-Embed-Cache", "MISS");
    res.send(svg);
});

router.get("/:mod/card.svg", embedGetRateLimiter, (req, res) => {
    const { mod } = req.params || {};
    if (typeof mod !== "string" || !mod.trim()) {
        return res.status(400).json({ error: "Invalid mod identifier" });
    }

    const options = getEmbedOptions(req.query || {});

    const modId = mod.trim();
    const cacheKey = buildEmbedCacheKey(modId, options.layout, options.size, options.theme, options.styleKey);
    const cachedSvg = getCachedSvg(cacheKey);
    if (cachedSvg) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("X-Embed-Cache", "HIT");
        res.send(cachedSvg);
        return;
    }

    const plugin = getPluginByPublicUUID(modId);
    if (!plugin) {
        return res.status(404).json({ error: "Plugin not found" });
    }
    const privatePluginUUID = plugin.uuid;
    const servers = getServersUsingPlugin(privatePluginUUID);

    let playerCount = 0;
    servers.forEach((server) => {
        const players = Number(server.players_online) || 0;
        playerCount += players;
    });

    const rawHistoryRows = getPluginDailyStatsLastDays(privatePluginUUID);
    const allTimePeak = getPluginAllTimePeak(privatePluginUUID);
    const history = Array.isArray(rawHistoryRows)
        ? rawHistoryRows
            .map((row) => ({
                day: String(row.hour_start || row.day || ""),
                serversCount: Math.max(0, Number(row.servers_count) || 0),
                playersCount: Math.max(0, Number(row.players_count) || 0)
            }))
            .filter((point) => point.day.length > 0)
        : [];
    const historyWithFallback = history.length > 0
        ? history
        : [{
            day: getUtcTodayDayString(),
            serversCount: servers.length,
            playersCount: playerCount
        }];

    const pluginDisplayName = truncateText(plugin?.name || "Unknown Plugin", 36);

    const data = {
        name: escapeXml(pluginDisplayName),
        servers: formatNumber(servers.length),
        players: formatNumber(playerCount),
        allTimePeakServers: formatNumber(allTimePeak?.servers?.count || 0),
        allTimePeakPlayers: formatNumber(allTimePeak?.players?.count || 0),
        history: historyWithFallback,
        historySourceRows: history.length
    };

    const svg = renderCardSvg(data, options);
    setCachedSvg(cacheKey, svg);

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("X-Embed-Cache", "MISS");
    res.send(svg);
});

export default router;
