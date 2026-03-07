import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configDotenv } from "dotenv";

configDotenv();

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

function assertDiscordEnv() {
    if (!token) {
        throw new Error("Missing DISCORD_BOT_TOKEN in environment.");
    }
    if (!clientId) {
        throw new Error("Missing DISCORD_CLIENT_ID in environment.");
    }
    if (!guildId) {
        throw new Error("Missing DISCORD_GUILD_ID in environment.");
    }
}

async function buildCommandsPayload() {
    const commands = [];
    const commandsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");
    const commandFolders = fs.readdirSync(commandsRoot);

    for (const folder of commandFolders) {
        const commandsPath = path.join(commandsRoot, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default ?? commandModule;

            if ("data" in command && "execute" in command) {
                commands.push(command.data.toJSON());
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }

    return commands;
}

async function deployCommands() {
    assertDiscordEnv();
    const commands = await buildCommandsPayload();
    const rest = new REST().setToken(token);

    console.log(`Started refreshing ${commands.length} application (/) commands.`);
    const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
}

deployCommands().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
