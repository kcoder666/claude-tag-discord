import "./env.js";
import fs from "node:fs";
import { Events } from "discord.js";
import { config } from "./config.js";
import { startHttpServer } from "./artifacts.js";
import { ApprovalBroker } from "./agent/permissions.js";
import { SessionManager } from "./agent/manager.js";
import { botCredential, describeCredential } from "./core/auth.js";
import { getDb } from "./core/db.js";
import { log } from "./core/log.js";
import { RoutineScheduler } from "./core/routines.js";
import { createClient } from "./discord/client.js";
import { registerHandlers } from "./discord/handlers.js";
import { Poster } from "./discord/poster.js";
import { commandDefinitions } from "./discord/slash.js";

async function main(): Promise<void> {
  if (!config.discordToken) {
    log.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const credential = botCredential();
  log.info(`Claude credential: ${describeCredential(credential)}`);
  if (credential.kind === "subscription") {
    log.warn(
      "Running on a Claude subscription token. Anthropic does not allow offering claude.ai login or subscription " +
      "rate limits to other people through Agent SDK products without approval: use only your own token for your own " +
      "self-hosted bot, and prefer an API key for anything shared widely. See README → Authentication.",
    );
  }
  if (!config.secretKey) log.warn("SECRET_KEY is not set: connection secrets and personal API keys will be stored unencrypted.");
  if (!config.sandboxEnabled) log.warn("SANDBOX_ENABLED=false: every shell command will need approval in Discord.");

  fs.mkdirSync(config.workspacesDir, { recursive: true });
  getDb();

  const client = createClient();
  const poster = new Poster(client);
  const broker = new ApprovalBroker(config.approvalTimeoutMs);
  const manager = new SessionManager(client, poster, broker);
  const scheduler = new RoutineScheduler((r, trigger) => manager.fireRoutine(r, trigger));
  manager.scheduler = scheduler;
  registerHandlers(client, manager);

  client.once(Events.ClientReady, async (c) => {
    log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
    manager.start();
    scheduler.start();
    if (process.env.REGISTER_COMMANDS !== "false") {
      try {
        const defs = commandDefinitions();
        if (config.devGuildId) await c.application.commands.set(defs, config.devGuildId);
        else await c.application.commands.set(defs);
        log.info(`Slash commands registered ${config.devGuildId ? `in guild ${config.devGuildId}` : "globally"}.`);
      } catch (e) {
        log.warn("Registering slash commands failed", e);
      }
    }
  });

  const http = config.publicBaseUrl || process.env.HTTP_ENABLED === "true" ? startHttpServer() : null;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    scheduler.stop();
    await manager.shutdown();
    http?.close();
    await client.destroy();
    setTimeout(() => process.exit(0), 6_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));

  await client.login(config.discordToken);
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
