
/*
    * Configuration Constants
*/
export const MAX_PLAYERS_ONLINE_PER_SERVER = 500; // how many players can be on a server
export const MAX_PLUGINS_PER_USER = 50; // how many plugins can a user have access to (either owned or shared), this is to prevent abuse of the plugin system and database
export const PLUGIN_PRIVATE_UUID_REFRESH_COOLDOWN_SECONDS = 24 * 60 * 60; // private plugin UUID can only be rotated once during this cooldown window
export const PLUGIN_SERVER_USAGE_CACHE_MS = 15 * 1000; // briefly cache per-plugin server lookups used by public directory/detail endpoints
export const MARKETPLACE_DOWNLOAD_CACHE_MS = 30 * 60 * 1000; // avoid repeatedly calling marketplace APIs for unchanged download totals
export const SECURITY_ALERT_DEDUPE_MS = 5 * 60 * 1000; // suppress repeated alerts with the same key during this window

/*
    * Rate Limiting
*/
// Authentication Rate Limiting
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const AUTH_RATE_LIMIT_MAX = 10;

// Public GET Rate Limiting
export const PUBLIC_GET_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const PUBLIC_GET_RATE_LIMIT_MAX = 120;

// Heavy GET Rate Limiting
export const HEAVY_GET_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const HEAVY_GET_RATE_LIMIT_MAX = 45;

// Embed GET Rate Limiting
export const EMBED_GET_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const EMBED_GET_RATE_LIMIT_MAX = 240;

// Server Ingest Rate Limiting
export const SERVER_INGEST_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const SERVER_INGEST_RATE_LIMIT_MAX = 300;
export const SERVER_INGEST_IP_RATE_LIMIT_MAX = 600;
export const MAX_ACTIVE_SERVERS_PER_IP = 100; // maximum concurrently active server UUIDs allowed from one reporter IP

// Ingest anomaly guards
export const SERVER_SPIKE_GUARD_WINDOW_MINUTES = 5; // time window to check for player count spikes
export const SERVER_PLAYER_SPIKE_BURST = 40;
export const SERVER_PLAYER_SPIKE_PER_MINUTE = 100;

/*
    * Stat Constants
*/
export const VALID_OS_NAMES = ["Windows 10", "Windows 11", "Windows 95", "Windows 98", "Windows ME", "Windows NT", "Windows 2000", "Windows XP", "Windows 2003", "Windows CE", "Windows Vista", "Windows 7", "Windows 8", "Windows 8.1", "Linux", "macOS"];
export const VALID_JAVA_VERSIONS = ["8", "11", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"];
export const AMOUNT_NEEDED_TO_DISPLAY = 5; // amount of "unique" of either OS name or Java version needed to be categorized outside of "other" and in its own
export const PLUGIN_HISTORY_DAYS = 365 * 5; // keep and return plugin usage history for the last 5 years
export const PLUGIN_HISTORY_SPIKE_MULTIPLIER = 8; // value must be >= this multiple of both neighboring hours to be considered a spike
export const PLUGIN_HISTORY_RESIDUAL_SPIKE_MULTIPLIER = 1.6; // secondary smoother for post-clamp spikes that still sit far above both neighboring hours
export const PLUGIN_HISTORY_SPIKE_MIN_PLAYERS_DELTA = 750; // minimum absolute players gap from neighbor average before smoothing
export const PLUGIN_HISTORY_SPIKE_MIN_SERVERS_DELTA = 20; // minimum absolute servers gap from neighbor average before smoothing

/*
    * Account Constants
*/
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;
export const ACCOUNT_SESSION_DURATION_DAYS = 14; // how many days a session should last before expiring, this is used for setting cookie max age and for cleaning up old sessions in the database

/*
    * Other Constants
*/
export const PORT = 3000;
export const FRONTEND_URL = "https://hstats.dev";
