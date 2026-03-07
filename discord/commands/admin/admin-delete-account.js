import { MessageFlags, SlashCommandBuilder } from "discord.js";
import {
    deleteAccountById,
    getAccountByDiscordId,
    getAccountByEmail,
    getAccountById
} from "../../../databases/accountsdb.js";
import { ensureDiscordOwner } from "../../adminAuth.js";

export default {
    data: new SlashCommandBuilder()
        .setName("admin-delete-account")
        .setDescription("Deletes an account by account id, email, or Discord ID.")
        .addStringOption((option) =>
            option.setName("account_id").setDescription("Account UUID").setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("email").setDescription("Account email").setRequired(false)
        )
        .addStringOption((option) =>
            option.setName("discord_id").setDescription("Discord user ID linked to the account").setRequired(false)
        ),
    async execute(interaction) {
        if (!(await ensureDiscordOwner(interaction))) {
            return;
        }

        const accountId = interaction.options.getString("account_id");
        const email = interaction.options.getString("email");
        const discordId = interaction.options.getString("discord_id");

        let account = null;
        if (accountId) {
            account = getAccountById(accountId);
        } else if (email) {
            account = getAccountByEmail(email);
        } else if (discordId) {
            account = getAccountByDiscordId(discordId);
        } else {
            await interaction.reply({
                content: "Provide one of: account_id, email, or discord_id.",
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

        const removed = deleteAccountById(account.id);
        await interaction.reply({
            content: removed > 0
                ? `Deleted account ${account.id}.`
                : `No account deleted for ${account.id}.`,
            flags: MessageFlags.Ephemeral
        });
    }
};

