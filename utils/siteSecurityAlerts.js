import { configDotenv } from "dotenv";
import { SECURITY_ALERT_DEDUPE_MS } from "../config.js";

configDotenv();

const SITE_LOGS_WEBHOOK = typeof process.env.SITE_LOGS_WEBHOOK === "string"
    ? process.env.SITE_LOGS_WEBHOOK.trim()
    : "";

const recentAlerts = new Map();

function pruneRecentAlerts(now = Date.now()) {
    for (const [key, expiresAt] of recentAlerts.entries()) {
        if (expiresAt <= now) {
            recentAlerts.delete(key);
        }
    }
}

function toAlertColor(severity) {
    switch (severity) {
        case "high":
            return 0xdc2626;
        case "medium":
            return 0xf59e0b;
        default:
            return 0x2563eb;
    }
}

function sanitizeValue(value, maxLength = 900) {
    const normalized = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return "n/a";
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 3)}...`;
}

async function sendSecurityAlert({
    title,
    description,
    severity = "medium",
    dedupeKey = "",
    fields = []
} = {}) {
    if (!SITE_LOGS_WEBHOOK) {
        return false;
    }

    const now = Date.now();
    const effectiveDedupeKey = sanitizeValue(dedupeKey || `${title}|${description}`, 256);
    pruneRecentAlerts(now);

    const existingExpiry = recentAlerts.get(effectiveDedupeKey);
    if (existingExpiry && existingExpiry > now) {
        return false;
    }
    recentAlerts.set(effectiveDedupeKey, now + SECURITY_ALERT_DEDUPE_MS);

    const embed = {
        title: sanitizeValue(title || "Security Alert", 256),
        description: sanitizeValue(description || "", 2048),
        color: toAlertColor(severity),
        timestamp: new Date(now).toISOString(),
        fields: fields
            .filter((field) => field && field.name !== undefined && field.value !== undefined)
            .slice(0, 12)
            .map((field) => ({
                name: sanitizeValue(field.name, 256),
                value: sanitizeValue(field.value, 1024),
                inline: !!field.inline
            }))
    };

    const response = await fetch(SITE_LOGS_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: "HStats Security",
            embeds: [embed]
        })
    });

    if (!response.ok) {
        throw new Error(`Webhook responded with ${response.status}`);
    }

    return true;
}

function queueSecurityAlert(payload) {
    void sendSecurityAlert(payload).catch((error) => {
        console.error(`Failed to send site security alert: ${error?.message || error}`);
    });
}

export {
    sendSecurityAlert,
    queueSecurityAlert
};
