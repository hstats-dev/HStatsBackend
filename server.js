import express from "express";
import session from "express-session";
import SQLiteStore from "connect-sqlite3";
import cors from "cors";
import { configDotenv } from "dotenv";
import {
    checkInActiveServers,
    getAllCountries,
    getAllJavaVersions,
    getAllOSNames,
    getCoreCounts,
    getGlobalAllTimePeaks,
    getGlobalHourlyStats,
    getGlobalHourlyStatsAll,
    getGlobalHourlyStatsLastDays,
    getTotalPlayersOnline,
    getTotalServers
} from "./databases/serversdb.js";
import { getSessionMaxAgeMs, getTotalAccounts } from "./databases/accountsdb.js";
import pluginRoutes from "./routes/plugins.js";
import accountRoutes from "./routes/accounts.js";
import serverRoutes from "./routes/servers.js";
import embedRoutes from "./routes/embed.js";
import { getTotalPlugins } from "./databases/plugindb.js";
import { getRecentActivity } from "./databases/liveActivity.js";
import { listImportantDateMarkers } from "./databases/importantdatesdb.js";
import { FRONTEND_URL, PORT } from "./config.js";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ActivityType, Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { heavyGetRateLimiter, publicGetRateLimiter } from "./middleware/rateLimiters.js";
import { createAndUploadDatabaseBackups } from "./discord/databaseBackups.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, (readyClient) => {
	console.log(`Discord Bot Ready! Logged in as ${readyClient.user.tag}`);
    updateDiscordPresence();
});

client.commands = new Collection();

async function loadDiscordCommands() {
    const projectRoot = path.dirname(fileURLToPath(import.meta.url));
    const foldersPath = path.join(projectRoot, 'discord', 'commands');
    const commandFolders = fs.readdirSync(foldersPath);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default ?? commandModule;

            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }
}

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
});

configDotenv();

const app = express();
const DISCORD_BOT_ENABLED = ["1", "true", "yes", "on"].includes(
    String(process.env.DISCORD_BOT_ENABLED || "").trim().toLowerCase()
);

if (process.env.PRODUCTION === "true")
    app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

let onlinePlayers = 0;
let onlineServers = 0;
let osNames = {};
let javaVersions = {};
let countries = {};
let userCount = 0;
let coreCount = {};
let pluginCount = 0;
let allTimePeak = getGlobalAllTimePeaks();
let backupJobInFlight = false;

function refreshCachedStats() {
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
}

refreshCachedStats();

async function runAutomatedDatabaseBackup(reason = "scheduled_hourly") {
    const webhookUrl = typeof process.env.DISCORD_BACKUP_WEBHOOK === "string"
        ? process.env.DISCORD_BACKUP_WEBHOOK.trim()
        : "";

    if (!webhookUrl) {
        return;
    }

    if (backupJobInFlight) {
        console.warn("Skipping database backup because a previous backup job is still running.");
        return;
    }

    backupJobInFlight = true;
    try {
        const result = await createAndUploadDatabaseBackups({
            webhookUrl,
            reason
        });
        console.log(`Database backup uploaded successfully (${result.files.length} files).`);
    } catch (error) {
        console.error(`Database backup failed: ${error?.message || error}`);
    } finally {
        backupJobInFlight = false;
    }
}

function updateDiscordPresence() {
    if (!client.isReady() || !client.user) {
        return;
    }
    const statusText = `${onlinePlayers.toLocaleString("en-US")} Players on ${onlineServers.toLocaleString("en-US")} Servers`;
    client.user.setActivity(statusText, { type: ActivityType.Watching });
}

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
app.get("/api/server-data", publicGetRateLimiter, (req, res) => {
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

app.get("/api/recent-activity", publicGetRateLimiter, (req, res) => {
    const recentActivity = getRecentActivity();
    res.status(200).json({ recentActivity });
});

app.get("/api/important-dates", publicGetRateLimiter, (req, res) => {
    const limitRaw = req.query.limit;
    const parsedLimit = limitRaw === undefined ? null : Number.parseInt(String(limitRaw), 10);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : null;

    const markers = listImportantDateMarkers({ limit });
    return res.status(200).json({ markers });
});

app.get("/api/server-history", heavyGetRateLimiter, (req, res) => {
    try {
        const all = typeof req.query.all === "string" && ["1", "true", "yes", "on"].includes(req.query.all.toLowerCase());
        const from = typeof req.query.from === "string" ? req.query.from : null;
        const to = typeof req.query.to === "string" ? req.query.to : null;

        if (from && to) {
            const rows = getGlobalHourlyStats(from, to);
            return res.status(200).json({ history: rows });
        }

        if (all) {
            const limitRaw = req.query.limit;
            const limitParsed = limitRaw === undefined ? null : Number.parseInt(String(limitRaw), 10);
            const limit = Number.isInteger(limitParsed) && limitParsed > 0
                ? Math.min(limitParsed, 100_000)
                : null;
            const rows = getGlobalHourlyStatsAll(limit);
            return res.status(200).json({ history: rows });
        }

        const daysParsed = Number.parseInt(String(req.query.days ?? "30"), 10);
        const days = Number.isInteger(daysParsed) && daysParsed > 0
            ? Math.min(daysParsed, 3650)
            : 30;
        const rows = getGlobalHourlyStatsLastDays(days);
        return res.status(200).json({ history: rows });
    } catch (error) {
        return res.status(400).json({ error: "Invalid history query parameters" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

if (!process.env.SERVER_ALIVE_CHECK_INTERVAL || isNaN(process.env.SERVER_ALIVE_CHECK_INTERVAL)) {
    console.warn("SERVER_ALIVE_CHECK_INTERVAL is not set or is not a number, defaulting to 5 minutes");
    process.env.SERVER_ALIVE_CHECK_INTERVAL = "5";
}

if (DISCORD_BOT_ENABLED) {
    if (!process.env.DISCORD_BOT_TOKEN) {
        console.warn("DISCORD_BOT_ENABLED is true, but DISCORD_BOT_TOKEN is not set. Discord bot startup skipped.");
    } else {
        try {
            await loadDiscordCommands();
            await client.login(process.env.DISCORD_BOT_TOKEN);
        } catch (error) {
            console.error(`Discord bot startup failed: ${error?.message || error}`);
        }
    }
} else {
    console.log("Discord bot startup skipped. Set DISCORD_BOT_ENABLED=true to enable it.");
}

// Periodically check for inactive servers, while we are at it we update player count
// cause why not do it here!
setInterval(() => {
    refreshCachedStats();
    updateDiscordPresence();
    console.log(`Currently ${onlineServers} online servers with ${onlinePlayers} total players.`);
}, process.env.SERVER_ALIVE_CHECK_INTERVAL * 60 * 1000); // minutes

setInterval(() => {
    runAutomatedDatabaseBackup();
}, 60 * 60 * 1000); // hourly
