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

function createJsonRateLimit({ windowMs, max, message, keyGenerator }) {
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
    }
});

const serverIngestIpRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_WINDOW_MS", SERVER_INGEST_RATE_LIMIT_WINDOW_MS),
    max: parsePositiveIntEnv("SERVER_INGEST_IP_RATE_LIMIT_MAX", SERVER_INGEST_IP_RATE_LIMIT_MAX),
    message: "Too many server update requests from this IP. Try again later.",
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || "")}`
});

export {
    authRateLimiter,
    publicGetRateLimiter,
    heavyGetRateLimiter,
    embedGetRateLimiter,
    serverIngestRateLimiter,
    serverIngestIpRateLimiter
};
