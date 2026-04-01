import betterSQL from "better-sqlite3";
import { configDotenv } from "dotenv";

configDotenv();

const dbPath = process.env.IMPORTANT_DATES_DB || "databases/important_dates.db";
const db = betterSQL(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS important_date_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marker_at TEXT NOT NULL,
        marker_unix INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_important_date_markers_marker_unix ON important_date_markers(marker_unix)");

function pad2(value) {
    return String(value).padStart(2, "0");
}

function toUtcIsoStringFromParts(year, month, day, hours = 0, minutes = 0, seconds = 0) {
    const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, 0));
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date");
    }
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== hours ||
        date.getUTCMinutes() !== minutes ||
        date.getUTCSeconds() !== seconds
    ) {
        throw new Error("Invalid date");
    }
    return date.toISOString();
}

function parseTimeInput(rawTime) {
    const value = typeof rawTime === "string" ? rawTime.trim().toLowerCase() : "";
    if (!value) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    let match = value.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)$/i);
    if (match) {
        let hours = Number.parseInt(match[1], 10);
        const minutes = Number.parseInt(match[2] || "0", 10);
        const seconds = Number.parseInt(match[3] || "0", 10);
        const amPm = match[4].toLowerCase();

        if (hours < 1 || hours > 12 || minutes > 59 || seconds > 59) {
            throw new Error("Invalid time");
        }
        if (amPm === "am") {
            hours = hours === 12 ? 0 : hours;
        } else {
            hours = hours === 12 ? 12 : hours + 12;
        }
        return { hours, minutes, seconds };
    }

    match = value.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
    if (match) {
        const hours = Number.parseInt(match[1], 10);
        const minutes = Number.parseInt(match[2] || "0", 10);
        const seconds = Number.parseInt(match[3] || "0", 10);
        if (hours > 23 || minutes > 59 || seconds > 59) {
            throw new Error("Invalid time");
        }
        return { hours, minutes, seconds };
    }

    throw new Error("Invalid time format");
}

function getRelativeUtcDate(baseDate, dayOffset) {
    const date = new Date(Date.UTC(
        baseDate.getUTCFullYear(),
        baseDate.getUTCMonth(),
        baseDate.getUTCDate() + dayOffset,
        0,
        0,
        0,
        0
    ));
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate()
    };
}

function normalizeImportantDateInput(dateInput, timeInput = "") {
    const rawDate = typeof dateInput === "string" ? dateInput.trim() : "";
    if (!rawDate) {
        throw new Error("Date is required");
    }

    const rawTime = typeof timeInput === "string" ? timeInput.trim() : "";
    const relativeKeyword = rawDate.toLowerCase();
    const now = new Date();
    let year;
    let month;
    let day;
    let parsedTime = parseTimeInput(rawTime);

    if (relativeKeyword === "today" || relativeKeyword === "tomorrow" || relativeKeyword === "yesterday") {
        const offset = relativeKeyword === "tomorrow"
            ? 1
            : (relativeKeyword === "yesterday" ? -1 : 0);
        const relativeDate = getRelativeUtcDate(now, offset);
        year = relativeDate.year;
        month = relativeDate.month;
        day = relativeDate.day;
    } else {
        let match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|am|pm))?))?$/);
        if (match) {
            year = Number.parseInt(match[1], 10);
            month = Number.parseInt(match[2], 10);
            day = Number.parseInt(match[3], 10);
            if (match[4] && !rawTime) {
                parsedTime = parseTimeInput(match[4]);
            }
        } else {
            match = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:AM|PM|am|pm)?))?$/);
            if (match) {
                month = Number.parseInt(match[1], 10);
                day = Number.parseInt(match[2], 10);
                year = Number.parseInt(match[3], 10);
                if (match[4] && !rawTime) {
                    parsedTime = parseTimeInput(match[4]);
                }
            } else {
                const parsedDate = new Date(rawDate);
                if (Number.isNaN(parsedDate.getTime())) {
                    throw new Error("Unsupported date format");
                }

                if (!rawTime && /t/i.test(rawDate)) {
                    return {
                        marker_at: parsedDate.toISOString(),
                        marker_unix: Math.floor(parsedDate.getTime() / 1000)
                    };
                }

                year = parsedDate.getUTCFullYear();
                month = parsedDate.getUTCMonth() + 1;
                day = parsedDate.getUTCDate();
            }
        }
    }

    if (
        !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
        month < 1 || month > 12 || day < 1 || day > 31
    ) {
        throw new Error("Invalid date");
    }

    const markerAt = toUtcIsoStringFromParts(
        year,
        month,
        day,
        parsedTime.hours,
        parsedTime.minutes,
        parsedTime.seconds
    );

    return {
        marker_at: markerAt,
        marker_unix: Math.floor(Date.parse(markerAt) / 1000)
    };
}

function mapMarkerRow(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        date: row.marker_at,
        unix: row.marker_unix,
        label: row.label
    };
}

function addImportantDateMarker({ markerAt, label }) {
    const normalizedLabel = typeof label === "string" ? label.trim() : "";
    if (!normalizedLabel) {
        throw new Error("Label is required");
    }
    if (normalizedLabel.length > 140) {
        throw new Error("Label must be 140 characters or fewer");
    }

    const parsedMs = Date.parse(markerAt);
    if (Number.isNaN(parsedMs)) {
        throw new Error("Invalid markerAt timestamp");
    }

    const now = Math.floor(Date.now() / 1000);
    const markerUnix = Math.floor(parsedMs / 1000);
    const result = db.prepare(`
        INSERT INTO important_date_markers (marker_at, marker_unix, label, created_at)
        VALUES (?, ?, ?, ?)
    `).run(new Date(parsedMs).toISOString(), markerUnix, normalizedLabel, now);

    return getImportantDateMarkerById(result.lastInsertRowid);
}

function getImportantDateMarkerById(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1) {
        return null;
    }
    const row = db.prepare(`
        SELECT id, marker_at, marker_unix, label
        FROM important_date_markers
        WHERE id = ?
    `).get(numericId);

    return mapMarkerRow(row);
}

function listImportantDateMarkers({ limit = null, fromUnix = null, toUnix = null } = {}) {
    const params = [];
    const conditions = [];

    if (Number.isInteger(fromUnix) && fromUnix > 0) {
        conditions.push("marker_unix >= ?");
        params.push(fromUnix);
    }
    if (Number.isInteger(toUnix) && toUnix > 0) {
        conditions.push("marker_unix <= ?");
        params.push(toUnix);
    }

    let sql = `
        SELECT id, marker_at, marker_unix, label
        FROM important_date_markers
    `;
    if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY marker_unix ASC, id ASC";

    if (Number.isInteger(limit) && limit > 0) {
        sql += " LIMIT ?";
        params.push(limit);
    }

    return db.prepare(sql).all(...params).map(mapMarkerRow);
}

function removeImportantDateMarker(id) {
    const marker = getImportantDateMarkerById(id);
    if (!marker) {
        return null;
    }

    db.prepare("DELETE FROM important_date_markers WHERE id = ?").run(marker.id);
    return marker;
}

export {
    addImportantDateMarker,
    getImportantDateMarkerById,
    listImportantDateMarkers,
    normalizeImportantDateInput,
    removeImportantDateMarker
};
