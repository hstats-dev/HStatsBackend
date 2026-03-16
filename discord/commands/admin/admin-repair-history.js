import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { repairPluginHistory } from "../../../databases/pluginstatsdb.js";
import { repairGlobalHistory } from "../../../databases/serversdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-repair-history")
        .setDescription("Repairs plugin/global history rows and rebuilds recorded peaks.")
        .addStringOption((option) =>
            option
                .setName("scope")
                .setDescription("What to repair")
                .setRequired(false)
                .addChoices(
                    { name: "All", value: "all" },
                    { name: "Plugin", value: "plugin" },
                    { name: "Global", value: "global" }
                )
        )
        .addStringOption((option) =>
            option
                .setName("plugin_uuid")
                .setDescription("Optional plugin UUID when repairing plugin history.")
                .setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        try {
            const scope = interaction.options.getString("scope") || "all";
            const pluginUUID = interaction.options.getString("plugin_uuid");
            const segments = [];

            if ((scope === "plugin" || scope === "all") && scope !== "global") {
                const pluginSummary = repairPluginHistory(pluginUUID || null);
                segments.push(
                    `plugin: scanned=${pluginSummary.plugins_scanned}, touched=${pluginSummary.plugins_touched}, rows_updated=${pluginSummary.rows_updated}`
                );
            }

            if (scope === "global" || scope === "all") {
                const globalSummary = repairGlobalHistory();
                segments.push(
                    `global: rows_scanned=${globalSummary.rows_scanned}, rows_updated=${globalSummary.rows_updated}, peak_servers=${globalSummary.peaks?.servers?.count || 0}, peak_players=${globalSummary.peaks?.players?.count || 0}`
                );
            }

            await interaction.reply({
                content: `Repair complete. ${segments.join(" | ")}`,
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
