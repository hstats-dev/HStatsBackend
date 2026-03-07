import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { deletePlugin, getPlugin } from "../../../databases/plugindb.js";
import { removePluginFromAllAccounts } from "../../../databases/accountsdb.js";
import { deletePluginStats } from "../../../databases/pluginstatsdb.js";
import { removePluginFromAllServers } from "../../../databases/serversdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-delete-plugin")
        .setDescription("Deletes a plugin and removes its references from accounts, servers, and stats.")
        .addStringOption((option) =>
            option.setName("plugin_uuid").setDescription("Plugin UUID").setRequired(true)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const pluginUUID = interaction.options.getString("plugin_uuid", true).trim();
        const plugin = getPlugin(pluginUUID);
        if (!plugin) {
            await interaction.reply({
                content: "Plugin not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        deletePlugin(pluginUUID);
        const removedFromAccounts = removePluginFromAllAccounts(pluginUUID);
        const removedFromServers = removePluginFromAllServers(pluginUUID);
        const statsDelete = deletePluginStats(pluginUUID);

        await interaction.reply({
            content: [
                `Deleted plugin ${pluginUUID} (${plugin.name || "unknown"}).`,
                `accounts_updated=${removedFromAccounts}`,
                `servers_updated=${removedFromServers}`,
                `stats_hourly_deleted=${statsDelete.hourly_deleted}`,
                `stats_peaks_deleted=${statsDelete.peaks_deleted}`
            ].join(" "),
            flags: MessageFlags.Ephemeral
        });
    }
};

