import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { repairPluginHistory } from "../../../databases/pluginstatsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-repair-history")
        .setDescription("Repairs anomalous plugin history rows and rebuilds plugin peaks.")
        .addStringOption((option) =>
            option
                .setName("plugin_uuid")
                .setDescription("Optional plugin UUID. If omitted, all plugins are scanned.")
                .setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        try {
            const pluginUUID = interaction.options.getString("plugin_uuid");
            const summary = repairPluginHistory(pluginUUID || null);
            await interaction.reply({
                content: `Repair complete. scanned=${summary.plugins_scanned}, touched=${summary.plugins_touched}, rows_updated=${summary.rows_updated}`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: `Repair failed: ${error?.message || "Unknown error"}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};

