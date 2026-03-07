import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { setGlobalAllTimePeaksExact } from "../../../databases/serversdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

function validateTimestampInput(value) {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        throw new Error("timestamp must be parseable by Date.parse (ISO recommended).");
    }
    return new Date(parsed).toISOString();
}

export default {
    data: new SlashCommandBuilder()
        .setName("admin-set-global-peak")
        .setDescription("Overrides global all-time server/player peaks.")
        .addIntegerOption((option) =>
            option.setName("servers_count").setDescription("Peak server count").setMinValue(0).setRequired(false)
        )
        .addIntegerOption((option) =>
            option.setName("players_count").setDescription("Peak player count").setMinValue(0).setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("timestamp").setDescription("ISO timestamp for provided counts").setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const serversCount = interaction.options.getInteger("servers_count");
        const playersCount = interaction.options.getInteger("players_count");
        if (serversCount === null && playersCount === null) {
            await interaction.reply({
                content: "Provide at least one of servers_count or players_count.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        try {
            const timestamp = validateTimestampInput(interaction.options.getString("timestamp"));
            const result = setGlobalAllTimePeaksExact({
                serversCount,
                serversAt: serversCount !== null ? timestamp : undefined,
                playersCount,
                playersAt: playersCount !== null ? timestamp : undefined
            });

            await interaction.reply({
                content: `Global peaks updated. servers=${result.servers.count} at=${result.servers.at || "null"} players=${result.players.count} at=${result.players.at || "null"}`,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            await interaction.reply({
                content: `Failed to set global peak: ${error?.message || "Unknown error"}`,
                flags: MessageFlags.Ephemeral
            });
        }
    }
};

