import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getPlugin } from "../../../databases/plugindb.js";
import { setPluginHourlyStatsExact } from "../../../databases/pluginstatsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-set-plugin-hour")
        .setDescription("Sets exact hourly stats for a plugin and rebuilds its all-time peak.")
        .addStringOption((option) =>
            option.setName("plugin_uuid").setDescription("Plugin UUID").setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName("hour_start")
                .setDescription("Hour bucket (YYYY-MM-DD HH:MM:SS or ISO UTC)")
                .setRequired(true)
        )
        .addIntegerOption((option) =>
            option.setName("servers_count").setDescription("Servers count for this hour").setMinValue(0).setRequired(true)
        )
        .addIntegerOption((option) =>
            option.setName("players_count").setDescription("Players count for this hour").setMinValue(0).setRequired(true)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const pluginUUID = interaction.options.getString("plugin_uuid", true).trim();
        const hourStart = interaction.options.getString("hour_start", true).trim();
        const serversCount = interaction.options.getInteger("servers_count", true);
        const playersCount = interaction.options.getInteger("players_count", true);

        if (!getPlugin(pluginUUID)) {
            await interaction.reply({
                content: "Plugin not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        try {
            const result = setPluginHourlyStatsExact(pluginUUID, hourStart, serversCount, playersCount);
            await interaction.reply({
                content: `Set ${pluginUUID} at ${result.hour_start}: servers=${serversCount}, players=${playersCount}.`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: `Failed to set plugin hour: ${error?.message || "Unknown error"}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};

