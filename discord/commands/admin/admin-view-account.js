import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import {
    getAccountByDiscordId,
    getAccountByEmail,
    getAccountById,
    getAccountByUsername,
    toSafeAccount
} from "../../../databases/accountsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

function formatTimestamp(unixSeconds) {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
        return "n/a";
    }
    return `<t:${Math.floor(unixSeconds)}:f>`;
}

function formatList(values, maxItems = 10) {
    if (!Array.isArray(values) || values.length === 0) {
        return "None";
    }

    const trimmed = values
        .map((value) => String(value || "").trim())
        .filter(Boolean);
    if (trimmed.length === 0) {
        return "None";
    }

    const visible = trimmed.slice(0, maxItems);
    const extra = trimmed.length - visible.length;
    return extra > 0
        ? `${visible.join("\n")}\n...and ${extra} more`
        : visible.join("\n");
}

export default {
    data: new SlashCommandBuilder()
        .setName("admin-view-account")
        .setDescription("Views account information by id, email, Discord ID, or username.")
        .addStringOption((option) =>
            option.setName("account_id").setDescription("Account UUID").setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("email").setDescription("Account email").setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("discord_id").setDescription("Linked Discord user ID").setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("username").setDescription("Account username").setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const accountId = interaction.options.getString("account_id");
        const email = interaction.options.getString("email");
        const discordId = interaction.options.getString("discord_id");
        const username = interaction.options.getString("username");

        let account = null;
        if (accountId) {
            account = getAccountById(accountId);
        } else if (email) {
            account = getAccountByEmail(email);
        } else if (discordId) {
            account = getAccountByDiscordId(discordId);
        } else if (username) {
            account = getAccountByUsername(username);
        } else {
            await interaction.reply({
                content: "Provide one of: account_id, email, discord_id, or username.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!account) {
            await interaction.reply({
                content: "Account not found.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const safeAccount = toSafeAccount(account);
        const privatePluginAccess = typeof safeAccount?.plugin_access === "string" && safeAccount.plugin_access.trim()
            ? safeAccount.plugin_access.split(",").map((value) => value.trim()).filter(Boolean)
            : [];

        const embed = new EmbedBuilder()
            .setColor(account.is_disabled ? 0xb91c1c : 0x1f2937)
            .setTitle(safeAccount?.username?.trim() || "No Name")
            .setDescription(`Account ID: \`${account.id}\``)
            .addFields(
                { name: "Email", value: safeAccount?.email || "n/a", inline: false },
                { name: "Disabled", value: account.is_disabled ? "Yes" : "No", inline: true },
                { name: "Discord", value: account.discord_id ? `${account.discord_username || "Unknown"} (\`${account.discord_id}\`)` : "Not linked", inline: true },
                { name: "Created", value: formatTimestamp(account.created_at), inline: true },
                { name: "Updated", value: formatTimestamp(account.updated_at), inline: true },
                { name: "Last Login", value: formatTimestamp(account.last_login), inline: true },
                { name: "GitHub Link", value: safeAccount?.github_link || "None", inline: false },
                { name: "CurseForge Link", value: safeAccount?.curseforge_link || "None", inline: false },
                { name: `Private Plugin Access (${privatePluginAccess.length})`, value: formatList(privatePluginAccess), inline: false }
            )
            .setTimestamp(new Date());

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
        });
    }
};
