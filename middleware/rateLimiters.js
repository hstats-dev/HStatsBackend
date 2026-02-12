import { ipKeyGenerator, rateLimit } from "express-rate-limit";

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
    windowMs: parsePositiveIntEnv("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    max: parsePositiveIntEnv("AUTH_RATE_LIMIT_MAX", 10),
    message: "Too many authentication attempts. Try again later."
});

const serverIngestRateLimiter = createJsonRateLimit({
    windowMs: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_WINDOW_MS", 60 * 1000),
    max: parsePositiveIntEnv("SERVER_INGEST_RATE_LIMIT_MAX", 240),
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

export {
    authRateLimiter,
    serverIngestRateLimiter
};
