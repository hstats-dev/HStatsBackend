import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import {
    AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS,
    EMBED_GET_RATE_LIMIT_MAX,
    EMBED_GET_RATE_LIMIT_WINDOW_MS,
    HEAVY_GET_RATE_LIMIT_MAX,
    HEAVY_GET_RATE_LIMIT_WINDOW_MS,
    PUBLIC_GET_RATE_LIMIT_MAX,
    PUBLIC_GET_RATE_LIMIT_WINDOW_MS,
    SERVER_INGEST_IP_RATE_LIMIT_MAX,
    SERVER_INGEST_RATE_LIMIT_MAX,
    SERVER_INGEST_RATE_LIMIT_WINDOW_MS
} from "../config.js";
import { queueSecurityAlert } from "../utils/siteSecurityAlerts.js";

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

function createJsonRateLimit({ windowMs, max, message, keyGenerator, onLimitReached }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
        handler: (req, res) => {
            const resetAt = req.rateLimit?.resetTime?.getTime();
            const retryAfterSeconds = resetAt
                ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
                : undefined;

            if (typeof onLimitReached === "function") {
                const alertPayload = onLimitReached(req, retryAfterSeconds);
                if (alertPayload) {
                    queueSecurityAlert(alertPayload);
                }
            }

            return res.status(429).json({
                error: message,
                retry_after_seconds: retryAfterSeconds
            });
        }
    });
}

const authRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("AUTH_RATE_LIMIT_WINDOW_MS", AUTH_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("AUTH_RATE_LIMIT_MAX", AUTH_RATE_LIMIT_MAX),
    message: "Too many authentication attempts. Try again later."
});

const publicGetRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("PUBLIC_GET_RATE_LIMIT_WINDOW_MS", PUBLIC_GET_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("PUBLIC_GET_RATE_LIMIT_MAX", PUBLIC_GET_RATE_LIMIT_MAX),
    message: "Too many requests. Try again later.",
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || "")}`
});

const heavyGetRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("HEAVY_GET_RATE_LIMIT_WINDOW_MS", HEAVY_GET_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("HEAVY_GET_RATE_LIMIT_MAX", HEAVY_GET_RATE_LIMIT_MAX),
    message: "Too many heavy requests. Try again later.",
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || "")}`
});

const embedGetRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("EMBED_GET_RATE_LIMIT_WINDOW_MS", EMBED_GET_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("EMBED_GET_RATE_LIMIT_MAX", EMBED_GET_RATE_LIMIT_MAX),
    message: "Too many embed requests. Try again later.",
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || "")}`
});

const serverIngestRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_WINDOW_MS", SERVER_INGEST_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_MAX", SERVER_INGEST_RATE_LIMIT_MAX),
    message: "Too many server update requests. Try again later.",
    keyGenerator: (req) => {
        const serverUuid = typeof req.body?.server_uuid === "string"
            ? req.body.server_uuid.trim()
            : "";
        if (serverUuid) {
            return `server:${serverUuid}`;
        }
        return `ip:${ipKeyGenerator(req.ip || "")}`;
    },
    onLimitReached: (req, retryAfterSeconds) => ({
        title: "Server UUID Ingest Rate Limit Triggered",
        description: "A server ingest rate limiter blocked requests for a single server UUID or fallback IP key.",
        severity: "medium",
        dedupeKey: `rate-limit-server-ingest:${typeof req.body?.server_uuid === "string" ? req.body.server_uuid.trim() : req.ip || "unknown"}`,
        fields: [
            { name: "Route", value: req.originalUrl || req.path || "unknown", inline: false },
            { name: "Server UUID", value: typeof req.body?.server_uuid === "string" ? req.body.server_uuid.trim() || "missing" : "missing", inline: true },
            { name: "Reporter IP", value: req.ip || "unknown", inline: true },
            { name: "Retry After", value: retryAfterSeconds ? `${retryAfterSeconds}s` : "unknown", inline: true }
        ]
    })
});

const serverIngestIpRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_WINDOW_MS", SERVER_INGEST_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("SERVER_INGEST_IP_RATE_LIMIT_MAX", SERVER_INGEST_IP_RATE_LIMIT_MAX),
    message: "Too many server update requests from this IP. Try again later.",
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || "")}`,
    onLimitReached: (req, retryAfterSeconds) => ({
        title: "Reporter IP Ingest Rate Limit Triggered",
        description: "The reporter IP exceeded the allowed ingest request rate.",
        severity: "high",
        dedupeKey: `rate-limit-server-ip:${req.ip || "unknown"}`,
        fields: [
            { name: "Route", value: req.originalUrl || req.path || "unknown", inline: false },
            { name: "Reporter IP", value: req.ip || "unknown", inline: true },
            { name: "Server UUID", value: typeof req.body?.server_uuid === "string" ? req.body.server_uuid.trim() || "missing" : "missing", inline: true },
            { name: "Retry After", value: retryAfterSeconds ? `${retryAfterSeconds}s` : "unknown", inline: true }
        ]
    })
});

export {
    authRateLimiter,
    publicGetRateLimiter,
    heavyGetRateLimiter,
    embedGetRateLimiter,
    serverIngestRateLimiter,
    serverIngestIpRateLimiter
};
