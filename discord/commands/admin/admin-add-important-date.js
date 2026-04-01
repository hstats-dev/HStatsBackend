import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { addImportantDateMarker, normalizeImportantDateInput } from "../../../databases/importantdatesdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

function formatUtcDate(dateIso) {
    const parsedMs = Date.parse(dateIso);
    if (Number.isNaN(parsedMs)) {
        return dateIso;
    }
    return `<t:${Math.floor(parsedMs / 1000)}:F>`;
}

export default {
    data: new SlashCommandBuilder()
        .setName("admin-add-important-date")
        .setDescription("Adds a frontend graph marker date with a label.")
        .addStringOption((option) =>
            option
                .setName("label")
                .setDescription("Short marker label shown to frontend users")
                .setRequired(true)
                .setMaxLength(140)
        )
        .addStringOption((option) =>
            option
                .setName("date")
                .setDescription("today, tomorrow, YYYY-MM-DD, MM/DD/YYYY, or include time")
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName("time")
                .setDescription("Optional UTC time like 14:30, 2:30pm, or 14:30:00")
                .setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const label = interaction.options.getString("label", true).trim();
        const dateInput = interaction.options.getString("date", true).trim();
        const timeInput = interaction.options.getString("time")?.trim() || "";

        try {
            const normalized = normalizeImportantDateInput(dateInput, timeInput);
            const marker = addImportantDateMarker({
                markerAt: normalized.marker_at,
                label
            });

            await interaction.reply({
                content: [
                    `Added important date marker #${marker.id}.`,
                    `label="${marker.label}"`,
                    `date=${formatUtcDate(marker.date)}`,
                    `iso=${marker.date}`
                ].join(" "),
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: [
                    `Failed to add important date marker: ${error?.message || "Unknown error"}.`,
                    `Accepted examples: today, tomorrow, 2026-04-15, 04/15/2026, 2026-04-15 14:30, 04/15/2026 2:30pm.`
                ].join(" "),
                flags: MessageFlags.Ephemeral
            });
        }
    }
};
