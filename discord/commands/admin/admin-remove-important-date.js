import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { removeImportantDateMarker } from "../../../databases/importantdatesdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-remove-important-date")
        .setDescription("Removes a stored frontend graph marker date by ID.")
        .addIntegerOption((option) =>
            option
                .setName("id")
                .setDescription("Marker ID from /admin-list-important-dates")
                .setRequired(true)
                .setMinValue(1)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const id = interaction.options.getInteger("id", true);
        const removed = removeImportantDateMarker(id);
        if (!removed) {
            await interaction.reply({
                content: "Important date marker not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.reply({
            content: `Removed important date marker #${removed.id} (${removed.date}) "${removed.label}".`,
            flags: MessageFlags.Ephemeral
        });
    }
};
