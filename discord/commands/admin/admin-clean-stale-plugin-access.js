import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { cleanupStalePluginAccessReferences } from "../../../databases/accountsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-clean-stale-plugin-access")
        .setDescription("Removes deleted or duplicate plugin UUIDs from account plugin access lists."),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        try {
            const summary = cleanupStalePluginAccessReferences();
            await interaction.reply({
                content: `Cleanup complete. accounts_scanned=${summary.accounts_scanned}, accounts_updated=${summary.accounts_updated}, stale_entries_removed=${summary.stale_entries_removed}`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: `Cleanup failed: ${error?.message || "Unknown error"}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};
