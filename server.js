import express from "express";
import session from "express-session";
import SQLiteStore from "connect-sqlite3";
import cors from "cors";
import requestIp from "request-ip";
import { configDotenv } from "dotenv";
import { checkInActiveServers, getAllCountries, getAllJavaVersions, getAllOSNames, getTotalPlayersOnline, getTotalServers } from "./databases/serversdb.js";
import { getSessionMaxAgeMs } from "./databases/accountsdb.js";
import pluginRoutes from "./routes/plugins.js";
import accountRoutes from "./routes/accounts.js";
import serverRoutes from "./routes/servers.js";
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

if (process.env.PRODUCTION === "true")
    app.set("trust proxy", 1);

const SQLiteStoreSession = SQLiteStore(session);
app.use(session({
    store: new SQLiteStoreSession({
        db: process.env.SESSIONS_DB || "sessions.db",
        dir: process.env.SESSIONS_DIR || "databases"
    }),
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.PRODUCTION === "true",
        maxAge: getSessionMaxAgeMs()
    }
}));

const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
app.use(cors({
    origin: allowedOrigin,
    credentials: true
}));

app.use("/api/account", accountRoutes);
app.use("/api/plugin", pluginRoutes);
app.use("/api/server", serverRoutes);

// Endpoint to get current server online server data
app.get("/api/server-data", (req, res) => {
    res.status(200).json({
        online_players: onlinePlayers,
        online_servers: onlineServers,
        os_names: osNames,
        java_versions: javaVersions,
        countries: countries
    });
});

app.listen(3000, () => {
    console.log(`Server is running on port 3000`);
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
    console.log(`Currently ${onlineServers} online servers with ${onlinePlayers} total players.`);
}, process.env.SERVER_ALIVE_CHECK_INTERVAL * 60 * 1000); // minutes
