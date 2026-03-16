import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { createAndUploadDatabaseBackups } from "../../databaseBackups.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

function formatBytes(bytes) {
    const safeBytes = Number(bytes) || 0;
    if (safeBytes < 1024) {
        return `${safeBytes} B`;
    }
    if (safeBytes < 1024 * 1024) {
        return `${(safeBytes / 1024).toFixed(1)} KB`;
    }
    return `${(safeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default {
    data: new SlashCommandBuilder()
        .setName("admin-backup-databases")
        .setDescription("Creates and uploads fresh backups of all SQLite databases."),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const backupResult = await createAndUploadDatabaseBackups({
                reason: "admin_command"
            });
            const totalBytes = backupResult.files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);

            await interaction.editReply({
                content: `Backup uploaded. files=${backupResult.files.length}, total_size=${formatBytes(totalBytes)}, skipped=${backupResult.skipped.length}`
            });
        } catch (error) {
            await interaction.editReply({
                content: `Backup failed: ${error?.message || "Unknown error"}`
            });
        }
    }
};
