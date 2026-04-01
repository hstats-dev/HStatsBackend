import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { listImportantDateMarkers } from "../../../databases/importantdatesdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

function formatMarker(marker) {
    const unix = Number(marker?.unix) || 0;
    const dateText = unix > 0 ? `<t:${unix}:F>` : (marker?.date || "n/a");
    return `#${marker.id} | ${dateText}\n${marker.label}`;
}

function buildEmbedDescription(markers, maxLength = 3800) {
    const lines = [];
    let used = 0;

    for (let index = 0; index < markers.length; index += 1) {
        const chunk = `${index > 0 ? "\n\n" : ""}${formatMarker(markers[index])}`;
        if ((used + chunk.length) > maxLength) {
            const remaining = markers.length - index;
            if (remaining > 0) {
                lines.push(`\n\n...and ${remaining} more`);
            }
            break;
        }
        lines.push(chunk);
        used += chunk.length;
    }

    return lines.join("");
}

export default {
    data: new SlashCommandBuilder()
        .setName("admin-list-important-dates")
        .setDescription("Lists stored frontend graph marker dates.")
        .addIntegerOption((option) =>
            option
                .setName("limit")
                .setDescription("How many markers to show")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(50)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const limit = interaction.options.getInteger("limit") || 20;
        const markers = listImportantDateMarkers({ limit });

        if (markers.length === 0) {
            await interaction.reply({
                content: "No important date markers are stored.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x1f2937)
            .setTitle(`Important Date Markers (${markers.length})`)
            .setDescription(buildEmbedDescription(markers))
            .setFooter({ text: "Use /admin-remove-important-date with the marker ID." })
            .setTimestamp(new Date());

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
        });
    }
};
