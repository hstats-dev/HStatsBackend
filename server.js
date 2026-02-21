import express from "express";
import session from "express-session";
import SQLiteStore from "connect-sqlite3";
import cors from "cors";
import requestIp from "request-ip";
import { configDotenv } from "dotenv";
import { checkInActiveServers, getAllCountries, getAllJavaVersions, getAllOSNames, getCoreCounts, getGlobalAllTimePeaks, getTotalPlayersOnline, getTotalServers } from "./databases/serversdb.js";
import { getSessionMaxAgeMs, getTotalAccounts } from "./databases/accountsdb.js";
import pluginRoutes from "./routes/plugins.js";
import accountRoutes from "./routes/accounts.js";
import serverRoutes from "./routes/servers.js";
import embedRoutes from "./routes/embed.js";
import { getTotalPlugins } from "./databases/plugindb.js";
import { getRecentActivity } from "./databases/liveActivity.js";
import { FRONTEND_URL, PORT } from "./config.js";
configDotenv();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(requestIp.mw());

let onlinePlayers = getTotalPlayersOnline();
let onlineServers = getTotalServers();
let osNames = getAllOSNames();
let javaVersions = getAllJavaVersions();
let countries = getAllCountries();
let userCount = getTotalAccounts();
let coreCount = getCoreCounts();
let pluginCount = getTotalPlugins();
let allTimePeak = getGlobalAllTimePeaks();

if (process.env.PRODUCTION === "true")
    app.set("trust proxy", 1);

if (!process.env.SESSION_SECRET) {
    console.warn("SESSION_SECRET is not set.");
}
const SQLiteStoreSession = SQLiteStore(session);
app.use(session({
    store: new SQLiteStoreSession({
        db: "sessions.db",
        dir: process.env.SESSIONS_DIR || "databases"
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.PRODUCTION === "true",
        maxAge: getSessionMaxAgeMs()
    }
}));

const allowedOrigin = (process.env.PRODUCTION == "true" ? FRONTEND_URL : "http://localhost:5173");
app.use(cors({
    origin: allowedOrigin,
    credentials: true
}));

app.use("/api/account", accountRoutes);
app.use("/api/plugin", pluginRoutes);
app.use("/api/server", serverRoutes);
app.use("/api/embed", embedRoutes);

// Endpoint to get current server online server data
app.get("/api/server-data", (req, res) => {
    res.status(200).json({
        online_players: onlinePlayers,
        online_servers: onlineServers,
        os_names: osNames,
        java_versions: javaVersions,
        countries: countries,
        user_count: userCount,
        plugin_count: pluginCount,
        core_count: coreCount,
        all_time_peak: allTimePeak
    });
});

app.get("/api/recent-activity", (req, res) => {
    const recentActivity = getRecentActivity();
    res.status(200).json({ recentActivity });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

if (!process.env.SERVER_ALIVE_CHECK_INTERVAL || isNaN(process.env.SERVER_ALIVE_CHECK_INTERVAL)) {
    console.warn("SERVER_ALIVE_CHECK_INTERVAL is not set or is not a number, defaulting to 5 minutes");
    process.env.SERVER_ALIVE_CHECK_INTERVAL = "5";
}

// Periodically check for inactive servers, while we are at it we update player count
// cause why not do it here!
setInterval(() => {
    checkInActiveServers();
    onlinePlayers = getTotalPlayersOnline();
    onlineServers = getTotalServers();
    osNames = getAllOSNames();
    javaVersions = getAllJavaVersions();
    countries = getAllCountries();
    userCount = getTotalAccounts();
    coreCount = getCoreCounts();
    pluginCount = getTotalPlugins();
    allTimePeak = getGlobalAllTimePeaks();
    console.log(`Currently ${onlineServers} online servers with ${onlinePlayers} total players.`);
}, process.env.SERVER_ALIVE_CHECK_INTERVAL * 60 * 1000); // minutes
