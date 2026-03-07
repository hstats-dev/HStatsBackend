import { MessageFlags } from "discord.js";

export const OWNER_ID = "323945473738145793"; // hardcoded but whatever

export async function ensureDiscordOwner(interaction) {
    if (interaction.user?.id === OWNER_ID) {
        return true;
    }

    const payload = {
        content: "You are not authorized to run this command.",
        flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
    } else {
        await interaction.reply(payload);
    }
    return false;
}

