import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getPlugin } from "../../../databases/plugindb.js";
import { getPluginAllTimePeak, setPluginAllTimePeak } from "../../../databases/pluginstatsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-set-plugin-peak")
        .setDescription("Overrides all-time peak values for a plugin.")
        .addStringOption((option) =>
            option.setName("plugin_uuid").setDescription("Plugin UUID").setRequired(true)
        )
        .addIntegerOption((option) =>
            option.setName("servers_count").setDescription("Peak server count").setMinValue(0).setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("servers_at").setDescription("Hour bucket (YYYY-MM-DD HH:MM:SS or ISO UTC)").setRequired(false)
        )
        .addIntegerOption((option) =>
            option.setName("players_count").setDescription("Peak player count").setMinValue(0).setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("players_at").setDescription("Hour bucket (YYYY-MM-DD HH:MM:SS or ISO UTC)").setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const pluginUUID = interaction.options.getString("plugin_uuid", true).trim();
        if (!getPlugin(pluginUUID)) {
            await interaction.reply({
                content: "Plugin not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const serversCount = interaction.options.getInteger("servers_count");
        const playersCount = interaction.options.getInteger("players_count");
        const serversAt = interaction.options.getString("servers_at");
        const playersAt = interaction.options.getString("players_at");

        if (serversCount === null && playersCount === null && !serversAt && !playersAt) {
            const current = getPluginAllTimePeak(pluginUUID);
            await interaction.reply({
                content: `Current peak for ${pluginUUID}: servers=${current.servers.count} at=${current.servers.at || "null"} players=${current.players.count} at=${current.players.at || "null"}`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        try {
            const updated = setPluginAllTimePeak(pluginUUID, {
                serversCount: serversCount === null ? undefined : serversCount,
                serversAt: serversAt ?? undefined,
                playersCount: playersCount === null ? undefined : playersCount,
                playersAt: playersAt ?? undefined
            });

            await interaction.reply({
                content: `Updated peak for ${pluginUUID}: servers=${updated.servers.count} at=${updated.servers.at || "null"} players=${updated.players.count} at=${updated.players.at || "null"}`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: `Failed to set plugin peak: ${error?.message || "Unknown error"}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};

