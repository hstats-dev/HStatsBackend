
/*
    * Configuration Constants
*/
export const MAX_PLAYERS_ONLINE_PER_SERVER = 500; // how many players can be on a server
export const MAX_PLUGINS_PER_USER = 10; // how many plugins can a user have access to (either owned or shared), this is to prevent abuse of the plugin system and database

/*
    * Rate Limiting
*/
// Authentication Rate Limiting
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const AUTH_RATE_LIMIT_MAX = 10;
// Server Ingest Rate Limiting
export const SERVER_INGEST_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const SERVER_INGEST_RATE_LIMIT_MAX = 300;

/*
    * Stat Constants
*/
export const VALID_OS_NAMES = ["Windows 10", "Windows 11", "Windows 95", "Windows 98", "Windows ME", "Windows NT", "Windows 2000", "Windows XP", "Windows 2003", "Windows CE", "Windows Vista", "Windows 7", "Windows 8", "Windows 8.1", "Linux", "macOS"];
export const VALID_JAVA_VERSIONS = ["8", "11", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"];
export const AMOUNT_NEEDED_TO_DISPLAY = 5; // amount of "unique" of either OS name or Java version needed to be categorized outside of "other" and in its own

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