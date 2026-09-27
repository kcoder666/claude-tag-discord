import { Client, GatewayIntentBits, Partials } from "discord.js";

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      // Privileged but optional: lets guest/allowed-role checks see members' roles reliably.
      ...(process.env.GUILD_MEMBERS_INTENT === "false" ? [] : [GatewayIntentBits.GuildMembers]),
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    allowedMentions: { parse: ["users"], repliedUser: false },
  });
}
