import "../env.js";
import { REST, Routes, type APIApplication } from "discord.js";
import { config } from "../config.js";
import { commandDefinitions } from "./slash.js";

/**
 * Register slash commands without starting the bot: `pnpm register-commands`.
 * The bot also registers them on startup; this is for CI or first-time setup.
 */
async function main(): Promise<void> {
  if (!config.discordToken) throw new Error("DISCORD_TOKEN is not set.");
  const rest = new REST().setToken(config.discordToken);
  const app = (await rest.get(Routes.currentApplication())) as APIApplication;
  const body = commandDefinitions();
  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(app.id, config.devGuildId), { body });
    console.log(`Registered ${body.length} commands in guild ${config.devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(app.id), { body });
    console.log(`Registered ${body.length} global commands (can take up to an hour to appear).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
