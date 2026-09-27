import crypto from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type Interaction,
  type ModalSubmitInteraction, type RESTPostAPIChatInputApplicationCommandsJSONBody, type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "../config.js";
import { encrypt } from "../core/crypto.js";
import { all, get, logActivity, run } from "../core/db.js";
import { log } from "../core/log.js";
import { deleteMemory, formatMemory, readableMemory } from "../core/memory.js";
import { describeRoutine, listRoutines } from "../core/routines.js";
import {
  channelScopeId, guildScopeId, listConnections, patchScope, readScope, removeConnection, scopeConfigSchema,
  setConnection, writeScope, type ResolvedScope,
} from "../core/scopes.js";
import { period, usageReport } from "../core/spend.js";
import type { SessionManager } from "../agent/manager.js";
import { canEditChannel, isAdmin } from "./access.js";
import { HELP } from "./commands.js";
import { memoryPlace, placeOf, scopeFor, type Place } from "./place.js";

export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const claude = new SlashCommandBuilder()
    .setName("claude")
    .setDescription("Claude in this channel")
    .addSubcommand((s) => s.setName("help").setDescription("How to use Claude"))
    .addSubcommand((s) => s.setName("status").setDescription("What Claude is doing here"))
    .addSubcommand((s) => s.setName("configure").setDescription("This channel's Claude settings"))
    .addSubcommand((s) => s.setName("routines").setDescription("Scheduled routines in this channel"))
    .addSubcommand((s) =>
      s.setName("memory").setDescription("What Claude remembers here")
        .addIntegerOption((o) => o.setName("delete").setDescription("Delete the note with this id")))
    .addSubcommand((s) =>
      s.setName("feedback").setDescription("Send feedback to the bot operators")
        .addStringOption((o) => o.setName("text").setDescription("Your feedback").setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) =>
      s.setName("model").setDescription("Switch the model for this thread, or the channel default")
        .addStringOption((o) => o.setName("name").setDescription("Model").setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName("for").setDescription("Where it applies").addChoices(
          { name: "this thread", value: "thread" }, { name: "channel default", value: "channel" },
        )))
    .addSubcommandGroup((g) =>
      g.setName("account").setDescription("Your personal settings for DMs with Claude")
        .addSubcommand((s) => s.setName("set-key").setDescription("Use your own Anthropic API key for your DMs"))
        .addSubcommand((s) => s.setName("clear-key").setDescription("Forget your API key"))
        .addSubcommand((s) =>
          s.setName("model").setDescription("Default model for your DMs")
            .addStringOption((o) => o.setName("name").setDescription("Model").setRequired(true).setAutocomplete(true))));

  const scopeOpt = (o: import("discord.js").SlashCommandStringOption) =>
    o.setName("scope").setDescription("Server-wide or this channel").setRequired(true)
      .addChoices({ name: "server", value: "guild" }, { name: "this channel", value: "channel" });

  const admin = new SlashCommandBuilder()
    .setName("claude-admin")
    .setDescription("Administer Claude in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(0)
    .addSubcommand((s) => s.setName("show").setDescription("Show the configuration").addStringOption(scopeOpt))
    .addSubcommand((s) => s.setName("edit").setDescription("Edit the configuration as JSON").addStringOption(scopeOpt))
    .addSubcommandGroup((g) =>
      g.setName("secret").setDescription("Connections: credentials injected at the network proxy")
        .addSubcommand((s) =>
          s.setName("set").setDescription("Add or replace a connection (value entered privately)")
            .addStringOption(scopeOpt)
            .addStringOption((o) => o.setName("name").setDescription("Connection name, e.g. github").setRequired(true).setMaxLength(40))
            .addStringOption((o) => o.setName("env_var").setDescription("Environment variable, e.g. GITHUB_TOKEN").setRequired(true).setMaxLength(60))
            .addStringOption((o) => o.setName("hosts").setDescription("Comma-separated hosts it's sent to, e.g. api.github.com,github.com").setRequired(true)))
        .addSubcommand((s) =>
          s.setName("remove").setDescription("Remove a connection")
            .addStringOption(scopeOpt)
            .addStringOption((o) => o.setName("name").setDescription("Connection name").setRequired(true))))
    .addSubcommand((s) => s.setName("usage").setDescription("This month's estimated spend"))
    .addSubcommand((s) => s.setName("audit").setDescription("Routines, memory, and recent activity"))
    .addSubcommand((s) => s.setName("reset-channel").setDescription("Replace this channel's session and reset its reading state"));

  return [claude.toJSON(), admin.toJSON()];
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const EPHEMERAL = MessageFlags.Ephemeral;
type Replyable = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;

async function say(i: Replyable, content: string): Promise<void> {
  const payload = { content: content.slice(0, 2000), flags: EPHEMERAL, allowedMentions: { parse: [] as never[] } } as const;
  if (i.replied || i.deferred) await i.followUp(payload);
  else await i.reply(payload);
}

function placeOfInteraction(i: Interaction): Place | null {
  return i.channel ? placeOf(i.channel, i.user.id) : null;
}

function sessionKeyFor(place: Place, userId: string): string {
  return place.kind === "thread" ? place.threadId! : place.kind === "dm" ? `dm:${userId}` : `channel:${place.channelId}`;
}

function redactedScope(scopeId: string): string {
  const cfg = readScope(scopeId);
  const conns = listConnections(scopeId).map((c) => ({ name: c.name, envVar: c.envVar, hosts: c.hosts, value: "••••" }));
  return JSON.stringify({ ...cfg, connections: conns }, null, 2);
}

function configurePanel(place: Place, scope: ResolvedScope, models: string[]) {
  const summary = [
    `**Claude in <#${place.channelId}>**`,
    `Respond automatically: **${scope.respondAutomatically ? "on" : "off"}**`,
    `Default model: **${scope.model}**`,
    `Instructions: ${scope.instructions.length ? scope.instructions.map((s) => `\n> ${s.slice(0, 300).replace(/\n/g, "\n> ")}`).join("") : "none"}`,
    `Allow rules: ${scope.allowRules.length} · Network: ${scope.networkAccess} · Repositories: ${scope.repositories.join(", ") || "none"}`,
    `Guests: ${place.hasGuests ? `present (${scope.guestMode})` : "none"} · Member edits: ${scope.memberEdits}`,
    "-# Admins can change everything else with `/claude-admin edit`.",
  ].join("\n");
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cfg:auto:${scope.respondAutomatically ? "off" : "on"}`)
      .setLabel(`Turn respond automatically ${scope.respondAutomatically ? "off" : "on"}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cfg:instr").setLabel("Edit channel instructions").setStyle(ButtonStyle.Primary),
  );
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("cfg:model").setPlaceholder("Default model for new sessions")
      .addOptions(models.slice(0, 25).map((m) => ({ label: m, value: m, default: m === scope.model }))),
  );
  return { content: summary, components: [buttons, select] };
}

/** Values too long for a custom id wait here between a slash command and its modal. */
const pendingSecrets = new Map<string, { scopeId: string; guildId: string; name: string; envVar: string; hosts: string[]; at: number }>();

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────

export async function handleInteraction(i: Interaction, manager: SessionManager): Promise<void> {
  try {
    if (i.isAutocomplete()) return await autocomplete(i, manager);
    if (i.isChatInputCommand()) {
      if (i.commandName === "claude") return await claudeCommand(i, manager);
      if (i.commandName === "claude-admin") return await adminCommand(i, manager);
    }
    if (i.isButton()) return await button(i, manager);
    if (i.isStringSelectMenu()) return await select(i, manager);
    if (i.isModalSubmit()) return await modal(i);
  } catch (e) {
    log.error("interaction failed", e);
    if (i.isRepliable()) await say(i as Replyable, `Something went wrong: ${(e as Error).message}`).catch(() => {});
  }
}

async function autocomplete(i: AutocompleteInteraction, manager: SessionManager): Promise<void> {
  const place = placeOfInteraction(i);
  const models = manager.allowedModels(place ? scopeFor(place) : scopeFor({ kind: "dm", guildId: null, channelId: "", threadId: null, channelName: "DM", isPublic: false, hasGuests: false, dmUserId: i.user.id }));
  const q = i.options.getFocused().toLowerCase();
  await i.respond(models.filter((m) => m.includes(q)).slice(0, 25).map((m) => ({ name: m, value: m })));
}

async function claudeCommand(i: ChatInputCommandInteraction, manager: SessionManager): Promise<void> {
  const place = placeOfInteraction(i);
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand();

  if (group === "account") {
    if (sub === "set-key") {
      const input = new TextInputBuilder().setCustomId("key").setLabel("Anthropic API key (sk-ant-…)").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(20).setMaxLength(200);
      await i.showModal(new ModalBuilder().setCustomId("setkey").setTitle("Your API key for DMs").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    if (sub === "clear-key") {
      run("UPDATE users SET api_key_enc = NULL, updated_at = ? WHERE user_id = ?", Date.now(), i.user.id);
      return say(i, "Forgot your API key. Your DMs now use the bot's credential (if the operator allows it).");
    }
    if (sub === "model") {
      const model = i.options.getString("name", true);
      const allowed = manager.allowedModels(place ? scopeFor(place) : scopeFor({ kind: "dm", guildId: null, channelId: "", threadId: null, channelName: "DM", isPublic: false, hasGuests: false, dmUserId: i.user.id }));
      if (!allowed.includes(model)) return say(i, `Not allowed. Choose one of: ${allowed.join(", ")}`);
      run(
        `INSERT INTO users (user_id, dm_model, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET dm_model = excluded.dm_model, updated_at = excluded.updated_at`,
        i.user.id, model, Date.now(),
      );
      return say(i, `Your new DM sessions will use ${model}.`);
    }
  }

  if (!place) return say(i, "Use this in a channel, thread or DM.");
  const scope = scopeFor(place);
  switch (sub) {
    case "help":
      return say(i, HELP);
    case "status":
      return say(i, `**Status** — ${manager.status(sessionKeyFor(place, i.user.id))}`);
    case "configure": {
      if (place.kind === "dm") return say(i, "DM settings: `/claude account set-key`, `/claude account model`.");
      return void (await i.reply({ ...configurePanel(place, scope, manager.allowedModels(scope)), flags: EPHEMERAL, allowedMentions: { parse: [] } }));
    }
    case "routines": {
      const list = listRoutines(place.kind === "dm" ? i.user.id : place.channelId);
      return say(i, list.length ? list.map(describeRoutine).join("\n") : "No routines here. Ask Claude, e.g. *every weekday at 9am, summarize new issues*.");
    }
    case "memory": {
      const mp = memoryPlace(place, scope);
      const del = i.options.getInteger("delete");
      if (del !== null) {
        deleteMemory(mp, del);
        return say(i, `Deleted note #${del}.`);
      }
      return say(i, `**What Claude remembers here**\n${formatMemory(readableMemory(mp))}`);
    }
    case "feedback": {
      const text = i.options.getString("text", true);
      run("INSERT INTO feedback (guild_id, channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)", place.guildId, place.channelId, i.user.id, text, Date.now());
      return say(i, "Thanks — sent to the operators.");
    }
    case "model": {
      const model = i.options.getString("name", true);
      const where = i.options.getString("for") ?? (place.kind === "thread" ? "thread" : "channel");
      if (!manager.allowedModels(scope).includes(model)) return say(i, `Not allowed. Choose one of: ${manager.allowedModels(scope).join(", ")}`);
      if (where === "thread") {
        if (place.kind !== "thread") return say(i, "Not in a thread. Use `for: channel default`.");
        if (!(await manager.setThreadModel(place.threadId!, model))) return say(i, "Claude isn't active in this thread.");
        return say(i, `Switched this thread to ${model}.`);
      }
      if (place.kind === "dm") return say(i, "Use `/claude account model` in DMs.");
      if (!canEditChannel(i.inCachedGuild() ? i.member : null, scope)) return say(i, "Only admins can change this channel's settings.");
      patchScope(channelScopeId(place.channelId), place.guildId!, { model });
      logActivity(place.guildId, place.channelId, "settings", `model → ${model} by ${i.user.id}`);
      return say(i, `${model} is now the default for new sessions in <#${place.channelId}>.`);
    }
  }
}

async function adminCommand(i: ChatInputCommandInteraction, manager: SessionManager): Promise<void> {
  if (!i.inCachedGuild()) return say(i, "Use this in a server.");
  if (!isAdmin(i.member)) return say(i, "You need Manage Server (or be a bot owner).");
  const place = placeOfInteraction(i);
  const channelId = place?.channelId ?? i.channelId;
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand();
  const scopeId = () => (i.options.getString("scope") === "guild" ? guildScopeId(i.guildId) : channelScopeId(channelId));

  if (group === "secret") {
    if (sub === "set") {
      const hosts = i.options.getString("hosts", true).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      const envVar = i.options.getString("env_var", true);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) return say(i, "env_var must look like MY_TOKEN.");
      if (["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PATH", "HOME"].includes(envVar)) return say(i, `${envVar} is reserved.`);
      if (!hosts.length) return say(i, "Give at least one host.");
      const id = crypto.randomBytes(8).toString("hex");
      pendingSecrets.set(id, { scopeId: scopeId(), guildId: i.guildId, name: i.options.getString("name", true), envVar, hosts, at: Date.now() });
      const input = new TextInputBuilder().setCustomId("value").setLabel(`Value for ${envVar}`).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
      await i.showModal(new ModalBuilder().setCustomId(`secret:${id}`).setTitle("Connection secret").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    const name = i.options.getString("name", true);
    return say(i, removeConnection(scopeId(), name) ? `Removed connection **${name}**.` : `No connection named **${name}** there.`);
  }

  switch (sub) {
    case "show":
      return say(i, `\`\`\`json\n${redactedScope(scopeId()).slice(0, 1900)}\n\`\`\``);
    case "edit": {
      const id = scopeId();
      const current = JSON.stringify(readScope(id), null, 2);
      const input = new TextInputBuilder().setCustomId("json").setLabel("Scope configuration (JSON)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
      if (current.length <= 4000) input.setValue(current);
      await i.showModal(new ModalBuilder().setCustomId(`scope:${id}`).setTitle(id.startsWith("guild:") ? "Server settings" : "Channel settings").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    case "usage": {
      const r = usageReport(i.guildId);
      const scope = scopeFor(place ?? { kind: "channel", guildId: i.guildId, channelId, threadId: null, channelName: "", isPublic: true, hasGuests: false, dmUserId: null });
      const lines = [
        `**Estimated spend for ${period()}** — $${r.total.toFixed(2)}${scope.monthlyLimitUsd !== undefined ? ` of $${scope.monthlyLimitUsd}` : ""}`,
        config.enforceSpendLimits ? "" : "-# Spend limits are not enforced (ENFORCE_SPEND_LIMITS=false).",
        "**By channel**", ...r.byChannel.map((c) => `<#${c.channel_id}> $${c.spend.toFixed(2)}`),
        "**By kind**", ...r.byKind.map((k) => `${k.kind}: $${k.spend.toFixed(2)}`),
        "**By work**", ...r.byWork.map((w) => `${w.work}: $${w.spend.toFixed(2)}`),
        "-# Costs are list-price estimates from the Agent SDK. On a subscription they are not billed amounts.",
      ].filter(Boolean);
      return say(i, lines.join("\n"));
    }
    case "audit": {
      const routines = all<{ id: number; channel_id: string; name: string; kind: string; enabled: number; created_by: string }>(
        "SELECT id, channel_id, name, kind, enabled, created_by FROM routines WHERE guild_id = ? ORDER BY id", i.guildId,
      );
      const memory = all<{ scope: string; scope_id: string; n: number }>(
        "SELECT scope, scope_id, COUNT(*) AS n FROM memory WHERE guild_id = ? GROUP BY scope, scope_id", i.guildId,
      );
      const activity = all<{ kind: string; channel_id: string | null; detail: string; created_at: number }>(
        "SELECT kind, channel_id, detail, created_at FROM activity WHERE guild_id = ? ORDER BY id DESC LIMIT 15", i.guildId,
      );
      const lines = [
        "**Routines**", ...(routines.length ? routines.map((r) => `#${r.id} ${r.name} (${r.kind}) in <#${r.channel_id}> by <@${r.created_by}>${r.enabled ? "" : " · paused"}`) : ["none"]),
        "**Memory**", ...(memory.length ? memory.map((m) => `${m.scope === "workspace" ? "workspace" : `<#${m.scope_id}>`}: ${m.n} notes`) : ["none"]),
        "**Recent activity**", ...activity.map((a) => `<t:${Math.floor(a.created_at / 1000)}:R> ${a.kind}${a.channel_id ? ` <#${a.channel_id}>` : ""}: ${a.detail.slice(0, 120)}`),
      ];
      return say(i, lines.join("\n"));
    }
    case "reset-channel":
      await manager.restart(`channel:${channelId}`);
      run("UPDATE channel_state SET unread_since_post = 0 WHERE channel_id = ?", channelId);
      return say(i, "Replaced this channel's session and reset its reading state.");
  }
}

async function button(i: ButtonInteraction, manager: SessionManager): Promise<void> {
  const [kind, arg, extra] = i.customId.split(":");
  if (kind === "approve" || kind === "deny") {
    const outcome = manager.broker.resolve(arg!, i.user.id, kind === "approve");
    if (outcome === "forbidden") return say(i, "You can't approve actions here.");
    if (outcome === "unknown") return say(i, "That request already ended.");
    return void (await i.deferUpdate());
  }
  if (kind === "stop") {
    const key = i.customId.slice("stop:".length);
    const place = placeOfInteraction(i);
    if (place?.guildId && i.inCachedGuild()) {
      const scope = scopeFor(place);
      if (!canEditChannel(i.member, scope) && !isAdmin(i.member)) return say(i, "You can't stop Claude here.");
    }
    const stopped = await manager.stop(key);
    return say(i, stopped ? "⏹️ Stopped." : "Nothing is running.");
  }
  if (kind === "cfg") {
    const place = placeOfInteraction(i);
    if (!place || place.kind === "dm" || !i.inCachedGuild()) return;
    const scope = scopeFor(place);
    if (!canEditChannel(i.member, scope)) return say(i, "Only admins can change this channel's settings.");
    if (arg === "auto") {
      patchScope(channelScopeId(place.channelId), place.guildId!, { respondAutomatically: extra === "on" });
      logActivity(place.guildId, place.channelId, "settings", `respondAutomatically → ${extra} by ${i.user.id}`);
      const next = scopeFor(place);
      return void (await i.update(configurePanel(place, next, manager.allowedModels(next))));
    }
    if (arg === "instr") {
      const current = readScope(channelScopeId(place.channelId)).instructions ?? "";
      const input = new TextInputBuilder().setCustomId("text").setLabel("Standing instructions for this channel").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000);
      if (current) input.setValue(current.slice(0, 4000));
      await i.showModal(new ModalBuilder().setCustomId(`instr:${place.channelId}`).setTitle("Channel instructions").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    }
  }
}

async function select(i: StringSelectMenuInteraction, manager: SessionManager): Promise<void> {
  if (i.customId !== "cfg:model") return;
  const place = placeOfInteraction(i);
  if (!place || place.kind === "dm" || !i.inCachedGuild()) return;
  const scope = scopeFor(place);
  if (!canEditChannel(i.member, scope)) return say(i, "Only admins can change this channel's settings.");
  const model = i.values[0]!;
  if (!manager.allowedModels(scope).includes(model)) return say(i, "Model not allowed.");
  patchScope(channelScopeId(place.channelId), place.guildId!, { model });
  logActivity(place.guildId, place.channelId, "settings", `model → ${model} by ${i.user.id}`);
  const next = scopeFor(place);
  await i.update(configurePanel(place, next, manager.allowedModels(next)));
}

async function modal(i: ModalSubmitInteraction): Promise<void> {
  const [kind, arg] = i.customId.split(":");
  if (kind === "setkey") {
    const key = i.fields.getTextInputValue("key").trim();
    if (!key.startsWith("sk-ant-")) return say(i, "That doesn't look like an Anthropic API key (sk-ant-…).");
    run(
      `INSERT INTO users (user_id, api_key_enc, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, updated_at = excluded.updated_at`,
      i.user.id, encrypt(key), Date.now(),
    );
    return say(i, `Saved. Your DMs with Claude now run on your key${config.secretKey ? " (stored encrypted)" : " — note: the operator hasn't set SECRET_KEY, so it's stored unencrypted"}.`);
  }
  if (kind === "instr") {
    if (!i.inCachedGuild()) return;
    const place = i.channel ? placeOf(i.channel, i.user.id) : null;
    if (!place || place.channelId !== arg) return say(i, "Open the settings again from the channel.");
    if (!canEditChannel(i.member, scopeFor(place))) return say(i, "Only admins can change this channel's settings.");
    const text = i.fields.getTextInputValue("text").trim();
    patchScope(channelScopeId(arg!), i.guildId, { instructions: text || undefined });
    logActivity(i.guildId, arg!, "settings", `instructions updated by ${i.user.id}`);
    return say(i, text ? "Saved the channel instructions. New sessions will follow them." : "Cleared the channel instructions.");
  }
  if (kind === "scope") {
    if (!i.inCachedGuild() || !isAdmin(i.member)) return say(i, "You need Manage Server.");
    const scopeId = i.customId.slice("scope:".length);
    const owner = get<{ guild_id: string }>("SELECT guild_id FROM scopes WHERE id = ?", scopeId)?.guild_id;
    if (owner && owner !== i.guildId) return say(i, "That scope belongs to another server.");
    if (scopeId.startsWith("guild:") && scopeId !== guildScopeId(i.guildId)) return say(i, "That scope belongs to another server.");
    if (scopeId.startsWith("channel:")) {
      const ch = await i.client.channels.fetch(scopeId.slice("channel:".length)).catch(() => null);
      if (!ch || ch.type === ChannelType.DM || !("guildId" in ch) || ch.guildId !== i.guildId) return say(i, "That channel isn't in this server.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(i.fields.getTextInputValue("json"));
    } catch (e) {
      return say(i, `Invalid JSON: ${(e as Error).message}`);
    }
    const res = scopeConfigSchema.safeParse(parsed);
    if (!res.success) return say(i, `Not saved:\n\`\`\`\n${res.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("\n").slice(0, 1800)}\n\`\`\``);
    writeScope(scopeId, i.guildId, res.data);
    logActivity(i.guildId, scopeId.startsWith("channel:") ? scopeId.slice(8) : null, "settings", `${scopeId} edited by ${i.user.id}`);
    return say(i, "Saved. New sessions pick this up; the channel session restarts on its next message.");
  }
  if (kind === "secret") {
    const p = pendingSecrets.get(arg!);
    pendingSecrets.delete(arg!);
    if (!p || Date.now() - p.at > 15 * 60_000) return say(i, "That request expired. Run the command again.");
    if (!i.inCachedGuild() || i.guildId !== p.guildId || !isAdmin(i.member)) return say(i, "You need Manage Server.");
    setConnection(p.scopeId, p.name, p.envVar, p.hosts, i.fields.getTextInputValue("value"), i.user.id);
    logActivity(p.guildId, p.scopeId.startsWith("channel:") ? p.scopeId.slice(8) : null, "connection", `${p.name} set by ${i.user.id}`);
    return say(i, `Saved connection **${p.name}** (${p.envVar} → ${p.hosts.join(", ")})${config.secretKey ? ", encrypted at rest" : ". ⚠️ SECRET_KEY is not set, so it's stored unencrypted"}.`);
  }
}
