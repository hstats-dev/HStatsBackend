import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { getAccountThatOwnsPlugin } from "../../../databases/accountsdb.js";
import { getPlugin } from "../../../databases/plugindb.js";
import { getPluginAllTimePeak, getPluginDailyStatsLastDays } from "../../../databases/pluginstatsdb.js";
import { getServersUsingPlugin } from "../../../databases/serversdb.js";

function isCanonicalUuid(value) {
    if (typeof value !== "string") {
        return false;
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatPeakTime(isoHour) {
    if (!isoHour) {
        return "n/a";
    }
    const ms = Date.parse(isoHour);
    if (Number.isNaN(ms)) {
        return isoHour;
    }
    const unix = Math.floor(ms / 1000);
    return `<t:${unix}:f>`;
}

function parseVersions(servers, pluginUUID) {
    const versions = {};
    servers.forEach((server) => {
        const entries = typeof server.plugins === "string" ? server.plugins.split(",") : [];
        entries.forEach((entryRaw) => {
            const entry = String(entryRaw || "").trim();
            if (!entry) {
                return;
            }
            const [entryPluginUUID, entryVersion] = entry.split("@");
            if ((entryPluginUUID || "").trim() !== pluginUUID) {
                return;
            }
            const version = (entryVersion || "").trim() || "Unknown";
            versions[version] = (versions[version] || 0) + 1;
        });
    });
    return versions;
}

function formatTrend(rows) {
    if (!Array.isArray(rows) || rows.length < 2) {
        return "Not enough history yet";
    }

    const first = rows[0];
    const last = rows[rows.length - 1];
    const serverDelta = (Number(last.servers_count) || 0) - (Number(first.servers_count) || 0);
    const playerDelta = (Number(last.players_count) || 0) - (Number(first.players_count) || 0);

    const formatDelta = (delta) => {
        if (delta > 0) {
            return `+${formatNumber(delta)}`;
        }
        if (delta < 0) {
            return `-${formatNumber(Math.abs(delta))}`;
        }
        return "0";
    };

    return `Servers ${formatDelta(serverDelta)} | Players ${formatDelta(playerDelta)}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName("mod-stats")
        .setDescription("Shows live and historical stats for a plugin UUID.")
        .addStringOption((option) =>
            option
                .setName("plugin_uuid")
                .setDescription("Plugin UUID")
                .setRequired(true)
        ),
    async execute(interaction) {
        const pluginUUID = interaction.options.getString("plugin_uuid", true).trim();
        if (!isCanonicalUuid(pluginUUID)) {
            await interaction.reply({
                content: "Invalid plugin UUID format.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const plugin = getPlugin(pluginUUID);
        if (!plugin) {
            await interaction.reply({
                content: "Plugin not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const servers = getServersUsingPlugin(pluginUUID);
        const totalPlayers = servers.reduce((sum, server) => sum + (Number(server.players_online) || 0), 0);
        const peak = getPluginAllTimePeak(pluginUUID);
        const history = getPluginDailyStatsLastDays(pluginUUID, 2);
        const versions = parseVersions(servers, pluginUUID);
        const topVersions = Object.entries(versions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([version, count]) => `${version}: ${formatNumber(count)}`)
            .join("\n") || "No version data";

        const owner = getAccountThatOwnsPlugin(pluginUUID);
        const ownerLinks = [
            owner?.github_link ? `[GitHub](${owner.github_link})` : null,
            owner?.curseforge_link ? `[CurseForge](${owner.curseforge_link})` : null
        ].filter(Boolean).join(" | ") || "n/a";

        const embed = new EmbedBuilder()
            .setColor(0x1f2937)
            .setTitle(plugin.name || "Unknown Plugin")
            .setDescription(`UUID: \`${pluginUUID}\``)
            .addFields(
                { name: "Live Servers", value: formatNumber(servers.length), inline: true },
                { name: "Live Players", value: formatNumber(totalPlayers), inline: true },
                { name: "Top Versions", value: topVersions, inline: false },
                {
                    name: "All-Time Peaks",
                    value: [
                        `Servers: **${formatNumber(peak?.servers?.count || 0)}** at ${formatPeakTime(peak?.servers?.at)}`,
                        `Players: **${formatNumber(peak?.players?.count || 0)}** at ${formatPeakTime(peak?.players?.at)}`
                    ].join("\n"),
                    inline: false
                },
                { name: "48h Trend", value: formatTrend(history), inline: false },
                { name: "Developer", value: ownerLinks, inline: false }
            )
            .setFooter({ text: "hstats.dev • Plugin Stats" })
            .setTimestamp(new Date());

        await interaction.reply({ embeds: [embed] });
    }
};
