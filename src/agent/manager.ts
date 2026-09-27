import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  type Client, type Message, type TextChannel, type NewsChannel, type ThreadChannel,
} from "discord.js";
import { getSessionMessages, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { botCredential, buildSessionEnv, isMetered, type Credential } from "../core/auth.js";
import { decrypt } from "../core/crypto.js";
import { all, get, logActivity, run } from "../core/db.js";
import { log } from "../core/log.js";
import { formatMemory, readableMemory } from "../core/memory.js";
import { getRoutine, recordRun, type Routine, type RoutineScheduler } from "../core/routines.js";
import {
  channelScopeId, connectionValue, guildScopeId, patchScope, scopeUpdatedAt, type ResolvedScope,
} from "../core/scopes.js";
import { searchMessages } from "../core/search.js";
import { checkBudget, channelSpend, guildSpend, newlyCrossedThresholds, recordUsage, type UsageKind } from "../core/spend.js";
import { publishPage, pagesEnabled } from "../artifacts.js";
import { canApprove, canEditChannel, fetchMember } from "../discord/access.js";
import { describeMessage, fetchWindow, formatWindow, messageContent, type ContentBlockParam } from "../discord/context.js";
import { parseChannelRef, relTime, renderChecklist, titleFrom } from "../discord/format.js";
import { describePlace, isPublicChannel, memoryPlace, placeOf, scopeFor, type Place } from "../discord/place.js";
import { Poster, type Target } from "../discord/poster.js";
import { ApprovalBroker, hardRuleHook, makeCanUseTool, type ApprovalRequest } from "./permissions.js";
import { channelSystemPrompt, taskSystemPrompt, type PromptContext } from "./prompts.js";
import { allowedDomains, buildSandbox } from "./sandbox.js";
import { AgentSession, type Todo, type TurnResult, type UserContent } from "./session.js";
import { buildTagServer, TAG_SERVER, type ToolHost } from "./tools.js";

export type SessionKind = "thread" | "channel" | "dm";

interface SessionRow {
  id: number; key: string; kind: SessionKind; guild_id: string | null; channel_id: string; thread_id: string | null;
  sdk_session_id: string | null; title: string | null; model: string | null; model_pinned: number;
  status: string; muted: number; created_by: string | null; created_at: number; last_active_at: number;
}

interface Live {
  key: string;
  kind: SessionKind;
  rowId: number;
  agent: AgentSession;
  place: Place;
  target: Target;
  title: string | null;
  cwd: string;
  credential: Credential;
  requesterId: string | null;
  /** Notes (edits, handoffs) folded into the next message Claude receives. */
  notes: string[];
  checklist: { msg: Message | null; todos: Todo[]; chain: Promise<unknown> };
  typing: NodeJS.Timeout | null;
  scopeStamp: number;
  usageKind: UsageKind;
  work: string;
  turnWaiters: ((r: TurnResult) => void)[];
  /** Channel session: mentions that must get a response this turn. */
  pendingMentions: Map<string, Message>;
}

/** Built-ins that don't fit a chat surface or would schedule work behind our back. */
const DISALLOWED_BUILTINS = [
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList", "RemoteTrigger", "PushNotification", "ScheduleWakeup",
];

const INTRO = `👋 Hi, I'm Claude. Tag me with a task and I'll work on it in a thread under your message — anyone can steer me by replying there.
Try: *@Claude summarize what we decided about the launch*, *@Claude investigate why CI fails on main*, or *@Claude every Monday at 9, post a digest of this channel*.
Say *remember …* and I'll keep it in this channel's notes. \`@Claude !help\` lists commands; \`/claude configure\` changes my settings here.`;

export class SessionManager {
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<Live>>();
  /** Top-level messages seen while the channel session wasn't reading, to catch it up on a mention. */
  private ambient = new Map<string, string[]>();
  private batches = new Map<string, { blocks: ContentBlockParam[]; timer: NodeJS.Timeout | null }>();
  private sweeper: NodeJS.Timeout | undefined;
  scheduler: RoutineScheduler | undefined;

  constructor(
    private readonly client: Client,
    readonly poster: Poster,
    readonly broker: ApprovalBroker,
  ) {}

  private get botId(): string {
    return this.client.user!.id;
  }

  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 30_000);
    this.sweeper.unref();
  }

  // ── rows ──────────────────────────────────────────────────────────────────────────────────

  activeRow(key: string): SessionRow | undefined {
    return get<SessionRow>("SELECT * FROM sessions WHERE key = ? AND status = 'active' ORDER BY id DESC LIMIT 1", key);
  }

  private createRow(key: string, kind: SessionKind, place: Place, title: string | null, by: string | null): SessionRow {
    const now = Date.now();
    const { lastInsertRowid } = run(
      `INSERT INTO sessions (key, kind, guild_id, channel_id, thread_id, title, status, created_by, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      key, kind, place.guildId, place.channelId, place.threadId, title, by, now, now,
    );
    return get<SessionRow>("SELECT * FROM sessions WHERE id = ?", lastInsertRowid)!;
  }

  private archive(key: string): void {
    run("UPDATE sessions SET status = 'archived' WHERE key = ? AND status = 'active'", key);
  }

  /** A thread Claude has joined (it has an active session row). */
  hasJoined(threadId: string): boolean {
    return !!this.activeRow(threadId);
  }

  // ── opening sessions ──────────────────────────────────────────────────────────────────────

  workspaceDir(key: string): string {
    return path.join(config.workspacesDir, key.replace(/[^\w-]+/g, "-"));
  }

  private credentialFor(kind: SessionKind, place: Place): Credential {
    if (kind !== "dm") return botCredential();
    const row = get<{ api_key_enc: string | null }>("SELECT api_key_enc FROM users WHERE user_id = ?", place.dmUserId);
    if (row?.api_key_enc) return { kind: "api-key", value: decrypt(row.api_key_enc), owner: "user" };
    if (config.dmFallbackToBotCredential) return botCredential();
    throw new Error("DMs run on your own Anthropic API key here. Save one with `/claude account set-key`.");
  }

  allowedModels(scope: ResolvedScope): string[] {
    return [...new Set([config.defaultModel, ...config.allowedModels, scope.model])];
  }

  private promptContext(place: Place, scope: ResolvedScope, model: string): PromptContext {
    const mem = memoryPlace(place, scope);
    return {
      where: describePlace(place),
      channelName: place.channelName,
      isPublic: place.isPublic,
      instructions: scope.instructions,
      memory: formatMemory(readableMemory(mem)),
      memoryOff: !!mem.noMemory,
      allowRules: scope.allowRules,
      repositories: scope.repositories,
      model,
      allowedModels: this.allowedModels(scope),
      now: new Date(),
      timezone: config.defaultTimezone,
      allowedHosts: scope.networkAccess === "full" ? null : allowedDomains(scope),
      sandboxed: config.sandboxEnabled,
      canPublishPages: pagesEnabled(),
    };
  }

  private async runSetupScripts(scope: ResolvedScope, cwd: string, env: Record<string, string>): Promise<string | null> {
    for (const script of scope.setupScripts) {
      const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn("bash", ["-lc", script], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => (out = (out + d).slice(-4000)));
        p.stderr.on("data", (d) => (out = (out + d).slice(-4000)));
        const t = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);
        p.on("close", (code) => (clearTimeout(t), resolve({ code, out })));
        p.on("error", (e) => (clearTimeout(t), resolve({ code: -1, out: e.message })));
      });
      if (res.code !== 0) return `Setup script failed (exit ${res.code}):\n${res.out.slice(-1500)}`;
    }
    return null;
  }

  /** Get the live session for a key, or open one (resuming the transcript when there is one). */
  private async ensure(
    key: string, kind: SessionKind, place: Place, target: Target,
    opts: { title?: string | null; requesterId?: string | null } = {},
  ): Promise<{ live: Live; fresh: boolean; resumed: boolean }> {
    const existing = this.live.get(key);
    if (existing && !existing.agent.closed) return { live: existing, fresh: false, resumed: false };
    const pending = this.opening.get(key);
    if (pending) return { live: await pending, fresh: false, resumed: false };
    let resumed = false;
    const p = (async () => {
      let row = this.activeRow(key);
      if (!row) row = this.createRow(key, kind, place, opts.title ?? null, opts.requesterId ?? null);
      resumed = !!row.sdk_session_id;
      return this.open(row, kind, place, target, opts.requesterId ?? null);
    })();
    this.opening.set(key, p);
    try {
      const live = await p;
      return { live, fresh: !resumed, resumed };
    } finally {
      this.opening.delete(key);
    }
  }

  private async open(row: SessionRow, kind: SessionKind, place: Place, target: Target, requesterId: string | null): Promise<Live> {
    const scope = scopeFor(place);
    const credential = this.credentialFor(kind, place);
    const cwd = this.workspaceDir(row.key);
    const freshDir = !fs.existsSync(cwd) || fs.readdirSync(cwd).length === 0;
    fs.mkdirSync(cwd, { recursive: true });

    const connectionEnv: Record<string, string> = {};
    for (const c of scope.connections) {
      try {
        connectionEnv[c.envVar] = connectionValue(c);
      } catch (e) {
        log.warn(`connection ${c.name} unavailable`, e);
      }
    }
    const tmp = path.join(cwd, ".tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const env = buildSessionEnv(credential, { ...scope.env, ...connectionEnv, TMPDIR: tmp, TMP: tmp, TEMP: tmp });

    if (kind !== "channel" && freshDir && scope.setupScripts.length) {
      const failure = await this.runSetupScripts(scope, cwd, buildSessionEnv({ kind: "local-login", owner: "bot" }, scope.env));
      if (failure) await this.poster.post(target, { text: `⚠️ ${failure}`, quiet: true });
    }

    const dmModel = kind === "dm"
      ? get<{ dm_model: string | null }>("SELECT dm_model FROM users WHERE user_id = ?", place.dmUserId)?.dm_model ?? null
      : null;
    const model = kind === "channel" ? config.channelModel : row.model ?? dmModel ?? scope.model;
    const ctx = this.promptContext(place, scope, model);
    const systemAppend = kind === "channel"
      ? channelSystemPrompt({ ...ctx, respondAutomatically: scope.respondAutomatically })
      : taskSystemPrompt({ ...ctx, kind: kind === "dm" ? "dm" : "thread", title: row.title ?? undefined });

    const liveRef: { current?: Live } = {};
    const host = this.makeHost(() => liveRef.current!);
    const mcpServers: Record<string, McpServerConfig> = { [TAG_SERVER]: buildTagServer(host) };
    if (kind !== "channel") for (const [name, s] of Object.entries(scope.mcpServers)) mcpServers[name] = s as McpServerConfig;

    const inner = makeCanUseTool({
      sessionKey: row.key,
      policy: () => ({ cwd, sandboxed: config.sandboxEnabled, scope: scopeFor(place) }),
      askHuman: (req, signal) => this.askHuman(liveRef.current!, req, signal),
    });
    const budget = kind === "dm" ? { ok: true as const, remaining: undefined } : checkBudget(scope, place.channelId);

    const agent = new AgentSession({
      key: row.key,
      cwd,
      model,
      effort: kind === "channel" ? config.channelEffort : config.taskEffort,
      credentialEnv: env,
      credential,
      systemAppend,
      builtinTools: kind === "channel" ? [] : undefined,
      disallowedTools: DISALLOWED_BUILTINS,
      mcpServers,
      hooks: { PreToolUse: [hardRuleHook(cwd, config.sandboxEnabled)] },
      canUseTool: async (name, input, o) => {
        const r = await inner(name, input, o);
        if (r?.behavior === "deny" && r.message.startsWith("Network access to")) {
          logActivity(place.guildId, place.channelId, "network_blocked", `${row.key}: ${r.message}`);
          void this.poster.post(target, { text: `-# 🚫 ${r.message}`, quiet: true, sessionKey: row.key });
        }
        return r;
      },
      permissionMode: config.permissionMode,
      sandbox: config.sandboxEnabled && kind !== "channel" ? buildSandbox(scope, cwd) : undefined,
      plugins: kind === "channel" ? [] : scope.plugins,
      resume: row.sdk_session_id ?? undefined,
      maxTurns: config.maxTurnsPerMessage,
      maxBudgetUsd: budget.remaining,
      handlers: {
        onSessionId: (id) => run("UPDATE sessions SET sdk_session_id = ? WHERE id = ?", id, row.id),
        onTurnStart: () => this.onTurnStart(liveRef.current),
        onTodos: (todos) => liveRef.current && this.updateChecklist(liveRef.current, todos),
        onTurnEnd: (r) => (liveRef.current ? this.onTurnEnd(liveRef.current, r) : undefined),
        onClosed: (reason) => liveRef.current && this.onClosed(liveRef.current, reason),
      },
    });

    const live: Live = {
      key: row.key, kind, rowId: row.id, agent, place, target, title: row.title, cwd, credential, requesterId,
      notes: [], checklist: { msg: null, todos: [], chain: Promise.resolve() }, typing: null,
      scopeStamp: this.scopeStamp(place), usageKind: kind === "dm" ? "dm" : "channel",
      work: kind === "channel" ? "channel" : kind === "dm" ? "dm" : "task", turnWaiters: [], pendingMentions: new Map(),
    };
    liveRef.current = live;
    this.live.set(row.key, live);
    log.info(`[${row.key}] session opened (${kind}, ${model}${row.sdk_session_id ? ", resumed" : ""})`);
    return live;
  }

  private scopeStamp(place: Place): number {
    return scopeUpdatedAt(channelScopeId(place.channelId)) + (place.guildId ? scopeUpdatedAt(guildScopeId(place.guildId)) : 0);
  }

  // ── delivering messages ──────────────────────────────────────────────────────────────────

  /** Push content into a session; checks the budget first when this starts a new turn. */
  private async deliver(live: Live, content: UserContent, requesterId: string | null): Promise<boolean> {
    if (requesterId) live.requesterId = requesterId;
    if (!live.agent.busy && live.kind !== "dm") {
      const scope = scopeFor(live.place);
      const b = checkBudget(scope, live.place.channelId);
      if (!b.ok) {
        await this.poster.post(live.target, {
          text: `💸 This ${b.blockedBy === "guild" ? "server" : "channel"} has reached its monthly Claude spend limit, so I can't take on new work. An admin can raise it with \`/claude-admin edit\`.`,
          quiet: true, sessionKey: live.key,
        });
        return false;
      }
    }
    let blocks: ContentBlockParam[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
    if (live.notes.length) {
      blocks = [{ type: "text", text: live.notes.splice(0).join("\n\n") }, ...blocks];
    }
    run("UPDATE sessions SET last_active_at = ? WHERE id = ?", Date.now(), live.rowId);
    live.agent.push(blocks);
    return true;
  }

  private onTurnStart(live: Live | undefined): void {
    if (!live || live.kind === "channel") return;
    this.startTyping(live);
  }

  private startTyping(live: Live): void {
    if (live.typing) return;
    const tick = () => void live.target.sendTyping().catch(() => {});
    tick();
    live.typing = setInterval(tick, 8_000);
    live.typing.unref();
  }

  private stopTyping(live: Live): void {
    if (live.typing) clearInterval(live.typing);
    live.typing = null;
  }

  private async onTurnEnd(live: Live, r: TurnResult): Promise<void> {
    log.info(`[${live.key}] turn ended${r.isError ? " with an error" : ""} ($${r.turnCostUsd.toFixed(4)}, ${r.model}${r.morePending ? ", more queued" : ""})`);
    if (!r.morePending) this.stopTyping(live);
    this.recordTurnUsage(live, r);

    if (live.kind === "channel") {
      await this.ensureMentionsAnswered(live);
    } else {
      let text = r.text.trim();
      if (r.isError) {
        if (/max_budget/i.test(text)) text = "💸 I stopped because this channel hit its spend limit.";
        else if (/max_turns/i.test(text)) text = "⏸️ I hit my step limit for one message. Reply to have me continue.";
        else text = `⚠️ ${text || "I stopped because of an error."}`;
      }
      if (text) {
        await this.poster.post(live.target, { text, title: live.title, model: r.model, sessionKey: live.key })
          .catch((e) => log.error(`[${live.key}] post failed`, e));
      }
      if (!r.morePending) await this.finishChecklist(live);
    }
    if (!r.morePending) {
      for (const w of live.turnWaiters.splice(0)) w(r);
      live.usageKind = live.kind === "dm" ? "dm" : "channel";
    }
  }

  private recordTurnUsage(live: Live, r: TurnResult): void {
    const { guildId, channelId } = live.place;
    recordUsage({
      guildId, channelId: live.kind === "dm" ? null : channelId, userId: live.requesterId, kind: live.usageKind,
      work: live.work, model: r.model, costUsd: r.turnCostUsd, metered: isMetered(live.credential),
    });
    if (!guildId || live.kind === "dm" || !(r.turnCostUsd > 0)) return;
    const scope = scopeFor(live.place);
    const alerts: string[] = [];
    for (const t of newlyCrossedThresholds(guildScopeId(guildId), guildSpend(guildId), scope.monthlyLimitUsd)) {
      alerts.push(`⚠️ This server has used ${t}% of its monthly Claude limit ($${scope.monthlyLimitUsd}).`);
    }
    for (const t of newlyCrossedThresholds(channelScopeId(channelId), channelSpend(channelId), scope.channelLimitUsd)) {
      alerts.push(`⚠️ <#${channelId}> has used ${t}% of its monthly Claude limit ($${scope.channelLimitUsd}).`);
    }
    if (!alerts.length) return;
    const where = scope.alertChannelId ?? channelId;
    void this.client.channels.fetch(where).then((ch) => {
      if (ch && ch.isTextBased() && "send" in ch) return this.poster.post(ch as Target, { text: alerts.join("\n"), quiet: true });
    }).catch((e) => log.warn("spend alert failed", e));
  }

  /** The channel session must act on every mention; if it didn't, start a task for it. */
  private async ensureMentionsAnswered(live: Live): Promise<void> {
    const missed = [...live.pendingMentions.values()];
    live.pendingMentions.clear();
    for (const m of missed) {
      log.info(`[${live.key}] mention ${m.id} got no action; starting a task`);
      await this.startTask(m, titleFrom(m.content), m.content, m.author.id).catch((e) => log.error("auto start_task failed", e));
    }
  }

  private onClosed(live: Live, reason: string): void {
    this.stopTyping(live);
    this.broker.cancelFor(live.key);
    if (this.live.get(live.key) === live) this.live.delete(live.key);
    for (const w of live.turnWaiters.splice(0)) w({ text: `session ${reason}`, isError: true, turnCostUsd: 0, model: live.agent.model, morePending: false });
    log.info(`[${live.key}] session closed (${reason})`);
  }

  // ── checklist ─────────────────────────────────────────────────────────────────────────────

  private checklistRow(key: string, stopped = false) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`stop:${key}`).setLabel(stopped ? "Stopped" : "Stop").setStyle(ButtonStyle.Danger).setDisabled(stopped),
    );
  }

  private updateChecklist(live: Live, todos: Todo[]): void {
    if (live.kind === "channel" || !todos.length) return;
    live.checklist.todos = todos;
    live.checklist.chain = live.checklist.chain.then(async () => {
      const text = renderChecklist(live.checklist.todos);
      if (!live.checklist.msg) {
        const [m] = await this.poster.post(live.target, { text, components: [this.checklistRow(live.key)], quiet: true, sessionKey: live.key });
        live.checklist.msg = m ?? null;
      } else {
        await live.checklist.msg.edit({ content: text, components: [this.checklistRow(live.key)] });
      }
    }).catch((e) => log.warn(`[${live.key}] checklist update failed`, e));
  }

  private async finishChecklist(live: Live, stopped = false): Promise<void> {
    await live.checklist.chain;
    const msg = live.checklist.msg;
    if (!msg) return;
    const allDone = live.checklist.todos.every((t) => t.status === "completed");
    if (!allDone && !stopped) return;
    await msg.edit({ content: renderChecklist(live.checklist.todos, stopped), components: stopped ? [this.checklistRow(live.key, true)] : [] }).catch(() => {});
    if (allDone) live.checklist = { msg: null, todos: [], chain: Promise.resolve() };
  }

  // ── approvals ─────────────────────────────────────────────────────────────────────────────

  private async askHuman(live: Live, req: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const guild = "guild" in live.target ? live.target.guild : null;
    const scope = scopeFor(live.place);
    const { id, decision } = this.broker.create(
      req,
      (userId) => live.kind === "dm" ? userId === live.place.dmUserId : canApprove(guild?.members.cache.get(userId), scope),
      signal,
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`approve:${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`deny:${id}`).setLabel("Deny").setStyle(ButtonStyle.Secondary),
    );
    const lang = req.toolName === "Bash" ? "sh" : "";
    const text = `🔐 **Approval needed**${req.risky ? " ⚠️" : ""} — Claude wants to use \`${req.toolName}\`:\n\`\`\`${lang}\n${req.summary.replace(/```/g, "ˋˋˋ")}\n\`\`\`-# Anyone who can use Claude here can decide. Times out in ${Math.round(config.approvalTimeoutMs / 60_000)}m.`;
    const [msg] = await this.poster.post(live.target, { text, components: [row], quiet: true, sessionKey: live.key });
    const { ok, by } = await decision;
    const outcome = by ? `${ok ? "✅ Approved" : "❌ Denied"} by <@${by}>` : "⌛ No decision (denied)";
    await msg?.edit({ content: `${text.split("\n-#")[0]}\n${outcome}`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    logActivity(live.place.guildId, live.place.channelId, "approval", `${req.toolName}: ${ok ? "approved" : "denied"} by ${by ?? "timeout"}`);
    return ok;
  }

  // ── entry points from the Discord handlers ────────────────────────────────────────────────

  /** A top-level channel message. The channel session decides what to do with it. */
  async handleTopLevel(msg: Message, place: Place, mentioned: boolean): Promise<void> {
    const channel = msg.channel as TextChannel | NewsChannel;
    const scope = scopeFor(place);
    const state = get<{ unread_since_post: number; activated: number }>(
      "SELECT unread_since_post, activated FROM channel_state WHERE channel_id = ?", place.channelId,
    ) ?? { unread_since_post: 0, activated: 0 };
    run(
      `INSERT INTO channel_state (channel_id, guild_id, unread_since_post, activated) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET unread_since_post = excluded.unread_since_post, activated = excluded.activated`,
      place.channelId, place.guildId, mentioned ? 0 : state.unread_since_post + 1, mentioned ? 1 : state.activated,
    );

    const reading = scope.respondAutomatically && state.unread_since_post < config.stopReadingAfter;
    if (!mentioned && !reading) {
      const buf = this.ambient.get(place.channelId) ?? [];
      buf.push(describeMessage(msg, this.botId));
      if (buf.length > 20) buf.shift();
      this.ambient.set(place.channelId, buf);
      return;
    }

    if (mentioned) {
      void msg.react("👀").catch(() => {});
      if (!state.activated) await this.poster.post(channel, { text: INTRO, quiet: true });
    }

    const { live, fresh } = await this.ensure(`channel:${place.channelId}`, "channel", place, channel);
    const blocks: ContentBlockParam[] = [];
    if (fresh) {
      const history = await fetchWindow(channel, this.botId, 15, msg.id).catch(() => []);
      if (history.length) blocks.push({ type: "text", text: `Recent messages in #${place.channelName}, for context (already handled):\n${formatWindow(history, this.botId)}` });
      this.ambient.delete(place.channelId);
    }
    const missed = this.ambient.get(place.channelId);
    if (missed?.length) {
      blocks.push({ type: "text", text: `Messages posted while you weren't reading (context only):\n${missed.join("\n")}` });
      this.ambient.delete(place.channelId);
    }
    blocks.push(...(await messageContent(msg, this.botId, { mentioned })));
    if (mentioned) live.pendingMentions.set(msg.id, msg);
    this.batch(live, blocks, mentioned, msg.author.id);
  }

  /** Ambient messages are batched for a moment so a burst of chat becomes one turn. */
  private batch(live: Live, blocks: ContentBlockParam[], immediate: boolean, requesterId: string): void {
    const b = this.batches.get(live.key) ?? { blocks: [], timer: null };
    b.blocks.push(...blocks);
    this.batches.set(live.key, b);
    if (b.timer) clearTimeout(b.timer);
    const flush = () => {
      this.batches.delete(live.key);
      if (live.agent.closed) return;
      void this.deliver(live, b.blocks, requesterId);
    };
    if (immediate) flush();
    else b.timer = setTimeout(flush, 2_500);
  }

  /** A message in a thread. Claude answers in threads it has joined, and anywhere it's mentioned. */
  async handleThreadMessage(msg: Message, place: Place, mentioned: boolean): Promise<void> {
    const thread = msg.channel as ThreadChannel;
    const row = this.activeRow(thread.id);
    if (!row && !mentioned) return;
    if (row?.muted && !mentioned) return;
    const { live, fresh, resumed } = await this.ensure(thread.id, "thread", place, thread, {
      title: row?.title ?? null, requesterId: msg.author.id,
    });
    let preamble: string | undefined;
    if (fresh && !resumed) {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const window = await fetchWindow(thread, this.botId, config.threadContextWindow, msg.id).catch(() => []);
      const parts: string[] = [];
      if (starter) parts.push(`The message this thread started from:\n${describeMessage(starter, this.botId)}`);
      if (window.length) parts.push(`Earlier messages in this thread:\n${formatWindow(window, this.botId)}`);
      preamble = parts.join("\n\n") || undefined;
    } else if (resumed) {
      preamble = "(Your previous workspace was released while you were idle; files that weren't delivered are gone. The conversation continues.)";
    }
    if (mentioned) void msg.react("👀").catch(() => {});
    const content = await messageContent(msg, this.botId, { mentioned, cwd: live.cwd, preamble });
    log.info(`[${live.key}] message from ${msg.author.username}${mentioned ? " (mention)" : ""}${live.agent.busy ? ", folded into the running turn" : ""}`);
    await this.deliver(live, content, msg.author.id);
  }

  async handleDm(msg: Message, place: Place): Promise<void> {
    const key = `dm:${msg.author.id}`;
    let live: Live;
    let resumed: boolean;
    try {
      ({ live, resumed } = await this.ensure(key, "dm", place, msg.channel as Target, { requesterId: msg.author.id }));
    } catch (e) {
      await this.poster.post(msg.channel as Target, { text: (e as Error).message, quiet: true });
      return;
    }
    const preamble = resumed ? "(Your previous workspace was released while you were idle; the conversation continues.)" : undefined;
    const content = await messageContent(msg, this.botId, { cwd: live.cwd, preamble });
    await this.deliver(live, content, msg.author.id);
  }

  /** Edits send Claude a note but never start work. */
  noteEdit(key: string, author: string, messageId: string, before: string, after: string): void {
    const live = this.live.get(key);
    const note = `[edit] ${author} edited message ${messageId}.\nBefore: ${before || "(unknown)"}\nAfter: ${after}`;
    if (!live) {
      return;
    }
    if (live.agent.busy) live.agent.push(note);
    else live.notes.push(note);
  }

  /** Deleting a thread's first message closes its session. */
  closeThread(threadId: string, reason: string): void {
    const live = this.live.get(threadId);
    live?.agent.close(reason);
    this.archive(threadId);
  }

  async stop(key: string): Promise<boolean> {
    const live = this.live.get(key);
    if (!live) return false;
    this.broker.cancelFor(key);
    await live.agent.interrupt();
    await this.finishChecklist(live, true);
    return true;
  }

  setMuted(threadId: string, muted: boolean): boolean {
    const row = this.activeRow(threadId);
    if (!row) return false;
    run("UPDATE sessions SET muted = ? WHERE id = ?", muted ? 1 : 0, row.id);
    if (muted) void this.stop(threadId);
    return true;
  }

  /** Archive the session and start over; a thread session rereads the thread. */
  async restart(key: string): Promise<void> {
    const live = this.live.get(key);
    const row = this.activeRow(key);
    live?.agent.close("restarted");
    this.archive(key);
    if (row && row.kind === "thread") {
      // Keep the thread joined with a fresh session row (same title, no transcript).
      run(
        `INSERT INTO sessions (key, kind, guild_id, channel_id, thread_id, title, status, created_by, created_at, last_active_at)
         VALUES (?, 'thread', ?, ?, ?, ?, 'active', ?, ?, ?)`,
        key, row.guild_id, row.channel_id, row.thread_id, row.title, row.created_by, Date.now(), Date.now(),
      );
    }
  }

  /** Switch a thread's model, live if the session is running. */
  async setThreadModel(key: string, model: string): Promise<boolean> {
    const row = this.activeRow(key);
    if (!row) return false;
    run("UPDATE sessions SET model = ?, model_pinned = 1 WHERE id = ?", model, row.id);
    const live = this.live.get(key);
    if (live && !live.agent.closed) await live.agent.setModel(model);
    return true;
  }

  status(key: string): string {
    const row = this.activeRow(key);
    const live = this.live.get(key);
    if (!row && !live) return "No session here yet.";
    const parts: string[] = [];
    if (live?.agent.busySince) parts.push(`still working, started ${relTime(Date.now() - live.agent.busySince)} ago`);
    else if (live) parts.push(`idle for ${relTime(Date.now() - live.agent.lastActivity)}`);
    else parts.push("asleep (the sandbox was released; the next reply resumes the conversation)");
    parts.push(`model: ${live?.agent.model ?? row?.model ?? "default"}`);
    if (row && row.kind === "thread") parts.push(`muted: ${row.muted ? "yes" : "no"}`);
    const waiting = this.broker.countFor(key);
    if (waiting) parts.push(`${waiting} approval(s) waiting`);
    return parts.join(", ");
  }

  // ── channel-session actions ───────────────────────────────────────────────────────────────

  private async fetchChannelMessage(channelId: string, messageId: string): Promise<Message> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) throw new Error("Channel not found.");
    return ch.messages.fetch(messageId);
  }

  /** Start a working session in a thread under a message. */
  async startTask(msg: Message, title: string, brief: string, requesterId: string | null, extra?: { routine?: Routine }): Promise<ThreadChannel> {
    const cleanTitle = title.slice(0, 60).trim() || "Task";
    const thread = msg.hasThread && msg.thread
      ? msg.thread
      : await msg.startThread({ name: cleanTitle.slice(0, 100), autoArchiveDuration: 1440 });
    const place = placeOf(thread)!;
    const row = this.activeRow(thread.id);
    if (row && !row.title) run("UPDATE sessions SET title = ? WHERE id = ?", cleanTitle, row.id);
    const { live, fresh } = await this.ensure(thread.id, "thread", place, thread, { title: row?.title ?? cleanTitle, requesterId });
    if (!live.title) live.title = cleanTitle;
    if (extra?.routine) {
      live.usageKind = "routine";
      live.work = `routine:${extra.routine.name}`;
    }
    const content = await messageContent(msg, this.botId, {
      cwd: live.cwd,
      preamble: `${fresh ? "You've been asked to work on this" : "New request in this thread"}${requesterId ? ` (by <@${requesterId}>)` : ""}.\nBrief: ${brief}\n\nThe message it came from:`,
    });
    await this.deliver(live, content, requesterId);
    logActivity(place.guildId, place.channelId, "task", `${cleanTitle} (${thread.id})`);
    return thread;
  }

  private markActed(channelKey: string, messageId: string): void {
    this.live.get(channelKey)?.pendingMentions.delete(messageId);
    run("UPDATE channel_state SET unread_since_post = 0, last_post_at = ? WHERE channel_id = ?", Date.now(), channelKey.slice("channel:".length));
  }

  // ── routines ──────────────────────────────────────────────────────────────────────────────

  private waitForTurn(live: Live): Promise<TurnResult> {
    return new Promise((resolve) => live.turnWaiters.push(resolve));
  }

  async fireRoutine(r: Routine, trigger: string): Promise<void> {
    const prompt = `⏰ Routine #${r.id} "${r.name}" fired (${trigger === "schedule" ? "scheduled run" : trigger}).\nTask: ${r.prompt}`;
    let live: Live | undefined;
    let link = "";
    try {
      if (r.ownerKind === "dm") {
        const user = await this.client.users.fetch(r.createdBy);
        const dm = await user.createDM();
        const place = placeOf(dm, user.id)!;
        ({ live } = await this.ensure(`dm:${user.id}`, "dm", place, dm, { requesterId: user.id }));
        live.usageKind = "routine";
        await this.deliver(live, prompt, user.id);
      } else {
        const threadCh = r.threadId ? await this.client.channels.fetch(r.threadId).catch(() => null) : null;
        if (threadCh?.isThread()) {
          if (threadCh.archived) await threadCh.setArchived(false).catch(() => {});
          const place = placeOf(threadCh)!;
          ({ live } = await this.ensure(threadCh.id, "thread", place, threadCh, { requesterId: r.createdBy }));
          live.usageKind = "routine";
          await this.deliver(live, prompt, r.createdBy);
          link = threadCh.url;
        } else {
          const ch = await this.client.channels.fetch(r.channelId);
          if (!ch || !ch.isTextBased() || ch.isThread() || ch.type === ChannelType.DM || !("send" in ch)) throw new Error("routine channel is gone");
          const [announce] = await this.poster.post(ch as Target, { text: `⏰ **Routine: ${r.name}**`, quiet: true });
          if (!announce) throw new Error("could not post");
          const thread = await this.startTask(announce, r.name, prompt, r.createdBy, { routine: r });
          live = this.live.get(thread.id);
          link = thread.url;
        }
      }
      const result = live ? await this.waitForTurn(live) : undefined;
      const status = result && !result.isError ? "completed" : "failed";
      recordRun(r.id, status);
      await this.notifyCreator(r, status, link);
    } catch (e) {
      recordRun(r.id, `failed: ${(e as Error).message}`.slice(0, 200));
      await this.notifyCreator(r, "failed", link, (e as Error).message);
      throw e;
    }
  }

  private async notifyCreator(r: Routine, status: string, link: string, error?: string): Promise<void> {
    if (r.ownerKind === "dm") return;
    try {
      const user = await this.client.users.fetch(r.createdBy);
      await user.send({
        content: `${status === "completed" ? "✅" : "⚠️"} Your routine **${r.name}** (#${r.id}) ${status}${link ? `: ${link}` : "."}${error ? `\n${error}` : ""}`,
        allowedMentions: { parse: [] },
      });
    } catch {
      // DMs closed; nothing to do.
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────

  /** Release idle sandboxes; rotate stale channel sessions. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const live of [...this.live.values()]) {
      if (live.agent.busy) continue;
      const idle = now - live.agent.lastActivity;
      if (live.kind === "channel") {
        const age = now - live.agent.startedAt;
        const changed = this.scopeStamp(live.place) !== live.scopeStamp;
        if (idle > config.channelSessionIdleMs || (age > config.channelSessionMaxAgeMs && idle > 10 * 60_000) || changed) {
          live.agent.close(changed ? "config changed" : "rotated");
          this.archive(live.key);
        }
      } else if (idle > config.sandboxIdleMs) {
        live.agent.close("idle");
        await this.wipeWorkspace(live.cwd);
      }
    }
  }

  private async wipeWorkspace(dir: string): Promise<void> {
    // Keep the directory itself: the transcript is keyed by this path, so resuming needs it stable.
    try {
      for (const entry of await fsp.readdir(dir)) await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
    } catch (e) {
      log.warn(`could not wipe ${dir}`, e);
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const live of [...this.live.values()]) live.agent.close("shutdown");
  }

  liveCount(): number {
    return this.live.size;
  }

  // ── tool host ─────────────────────────────────────────────────────────────────────────────

  private async resolveChannel(ref: string, place: Place) {
    const { id, name } = parseChannelRef(ref);
    if (id) return this.client.channels.fetch(id).catch(() => null);
    if (!place.guildId) return null;
    const guild = await this.client.guilds.fetch(place.guildId);
    const chans = await guild.channels.fetch();
    return chans.find((c) => !!c && c.name.toLowerCase() === name && c.isTextBased()) ?? null;
  }

  private makeHost(getLive: () => Live): ToolHost {
    const self = this;
    const L = () => {
      const l = getLive();
      if (!l) throw new Error("Session not ready.");
      return l;
    };
    const channelOnly = () => {
      if (L().kind !== "channel") throw new Error("Only the channel session can do that.");
    };
    const requireEdit = async (): Promise<ResolvedScope> => {
      const live = L();
      if (live.kind === "dm" || !live.place.guildId) throw new Error("Channel settings can't be changed from a DM.");
      const scope = scopeFor(live.place);
      const guild = await self.client.guilds.fetch(live.place.guildId);
      const member = await fetchMember(guild, live.requesterId);
      if (!canEditChannel(member, scope)) throw new Error("Only admins can change this channel's settings (member edits are blocked).");
      return scope;
    };
    return {
      get kind() { return getLive()?.kind ?? "thread"; },
      get guildId() { return getLive()?.place.guildId ?? null; },
      get channelId() { return getLive()?.place.kind === "dm" ? getLive()!.place.dmUserId ?? getLive()!.place.channelId : getLive()?.place.channelId ?? ""; },
      get threadId() { return getLive()?.kind === "thread" ? getLive()!.key : null; },
      memoryPlace: () => memoryPlace(L().place, scopeFor(L().place)),
      requesterId: () => L().requesterId,
      allowedModels: () => self.allowedModels(scopeFor(L().place)),

      async postMessage(text) {
        const live = L();
        await self.poster.post(live.target, { text, title: live.title, sessionKey: live.key });
      },
      async attachFile(p, name, comment) {
        const live = L();
        const full = path.resolve(live.cwd, p);
        const rel = path.relative(live.cwd, full);
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Only files inside your workspace can be attached.");
        const st = await fsp.stat(full).catch(() => null);
        if (!st?.isFile()) throw new Error(`No file at ${p}.`);
        if (st.size > 25 * 1024 * 1024) throw new Error("File is over 25MB; publish it somewhere and share a link instead.");
        await self.poster.post(live.target, {
          text: comment, title: live.title, sessionKey: live.key,
          files: [new AttachmentBuilder(full, { name: name ?? path.basename(full) })],
        });
      },
      async publishPage(html, title) {
        const live = L();
        const url = publishPage(live.key, title, html);
        logActivity(live.place.guildId, live.place.channelId, "page", `${title}: ${url}`);
        return `Published: ${url}`;
      },
      async postToChannel(ref, text) {
        const live = L();
        if (live.place.kind !== "dm" && !live.place.isPublic) throw new Error("Posting to other channels isn't allowed from a private channel.");
        const ch = await self.resolveChannel(ref, live.place);
        if (!ch || !ch.isTextBased() || ch.type === ChannelType.DM || !("guild" in ch)) throw new Error(`Can't find channel ${ref}.`);
        if (!isPublicChannel(ch)) throw new Error("Claude only posts to public channels.");
        const me = ch.guild.members.me;
        if (!me || !ch.permissionsFor(me)?.has("SendMessages")) throw new Error(`I can't post in #${ch.name}.`);
        const who = live.requesterId ? `<@${live.requesterId}>` : "someone";
        const src = live.place.kind === "dm" ? "a DM" : `<#${live.place.threadId ?? live.place.channelId}>`;
        if (live.place.kind === "dm") {
          const member = await fetchMember(ch.guild, live.place.dmUserId);
          if (!member || !ch.permissionsFor(member)?.has("ViewChannel")) throw new Error("You can't see that channel, so I won't post there for you.");
          const { id, decision } = self.broker.create(
            { sessionKey: live.key, toolName: "post_to_channel", summary: text, risky: false },
            (u) => u === live.place.dmUserId,
          );
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve:${id}`).setLabel("Approve and post").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`deny:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
          );
          const [prompt] = await self.poster.post(live.target, {
            text: `I'd post this in **#${ch.name}** (${ch.guild.name}):\n>>> ${text}`, components: [row], quiet: true,
          });
          const { ok } = await decision;
          await prompt?.edit({ components: [] }).catch(() => {});
          if (!ok) return "The person didn't approve; nothing was posted.";
        }
        const [m] = await self.poster.post(ch as Target, {
          text: `${text}\n-# Sent by Claude in ${src} on behalf of ${who}`, quiet: true, sessionKey: live.key,
        });
        logActivity(live.place.guildId ?? ch.guild.id, ch.id, "cross_post", `from ${live.key} by ${live.requesterId}`);
        return m ? `Posted: ${m.url}` : "Posted.";
      },
      async searchMessages(q, limit) {
        const live = L();
        if (!live.place.guildId) throw new Error("Search works in server channels, not DMs.");
        const scope = scopeFor(live.place);
        let allowed: Set<string> | undefined;
        if (scope.searchScope === "member_only") {
          allowed = new Set(all<{ channel_id: string }>("SELECT DISTINCT channel_id FROM sessions WHERE guild_id = ?", live.place.guildId).map((r) => r.channel_id));
        }
        const hits = searchMessages({ guildId: live.place.guildId, query: q, allowedChannelIds: allowed, currentChannelId: live.place.channelId, limit });
        if (!hits.length) return "No matches.";
        return hits.map((h) => `[#${h.channel_name}] ${h.author} · ${new Date(h.created_at).toISOString()} · id ${h.message_id} (channel ${h.channel_id})\n${h.content.slice(0, 500)}`).join("\n\n");
      },
      async readChannelHistory(ref, limit) {
        const live = L();
        let ch = ref ? await self.resolveChannel(ref, live.place) : live.target;
        if (!ch || !ch.isTextBased()) throw new Error(`Can't find channel ${ref}.`);
        const isCurrent = ch.id === live.target.id || ch.id === live.place.channelId;
        if (!isCurrent) {
          if (ch.type === ChannelType.DM || !("guild" in ch)) throw new Error("Can't read that channel.");
          if (live.place.guildId && ch.guild.id !== live.place.guildId) throw new Error("That channel is in another server.");
          if (!isPublicChannel(ch)) throw new Error("Only public channels can be read from here.");
        }
        const msgs = await fetchWindow(ch, self.botId, limit);
        return msgs.length ? formatWindow(msgs, self.botId) : "(no messages)";
      },
      async listSessions() {
        const live = L();
        const rows = all<SessionRow>(
          "SELECT * FROM sessions WHERE channel_id = ? AND kind = 'thread' ORDER BY id DESC LIMIT 25", live.place.channelId,
        );
        if (!rows.length) return "No sessions yet.";
        return rows.map((r) => `<#${r.thread_id}> (thread id ${r.thread_id}) — ${r.title ?? "untitled"} — started ${new Date(r.created_at).toISOString()} — ${r.status}`).join("\n");
      },
      async readSessionTranscript(threadId, limit) {
        const live = L();
        const row = get<SessionRow>(
          "SELECT * FROM sessions WHERE key = ? AND channel_id = ? AND sdk_session_id IS NOT NULL ORDER BY id DESC LIMIT 1", threadId, live.place.channelId,
        );
        if (!row) throw new Error("No transcript for that thread in this channel.");
        const msgs = await getSessionMessages(row.sdk_session_id!, { dir: self.workspaceDir(threadId) });
        const lines: string[] = [];
        for (const m of msgs.slice(-limit)) {
          const content = (m.message as { content?: unknown } | undefined)?.content;
          const text = typeof content === "string" ? content
            : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
          if (text.trim()) lines.push(`${m.type === "user" ? "User" : "Claude"}: ${text.slice(0, 2000)}`);
        }
        return lines.join("\n\n") || "(transcript has no text)";
      },
      async setModel(target, model) {
        const live = L();
        const scope = scopeFor(live.place);
        if (!self.allowedModels(scope).includes(model)) throw new Error(`${model} isn't allowed here. Allowed: ${self.allowedModels(scope).join(", ")}`);
        if (target === "thread") {
          if (live.kind === "channel") throw new Error("There's no thread session here; use target 'channel'.");
          await live.agent.setModel(model);
          run("UPDATE sessions SET model = ?, model_pinned = 1 WHERE id = ?", model, live.rowId);
          return `Switched this conversation to ${model}.`;
        }
        await requireEdit();
        patchScope(channelScopeId(live.place.channelId), live.place.guildId!, { model });
        logActivity(live.place.guildId, live.place.channelId, "settings", `model → ${model} by ${live.requesterId}`);
        return `${model} is now the default for new sessions in this channel.`;
      },
      async setRespondAutomatically(on) {
        const live = L();
        await requireEdit();
        patchScope(channelScopeId(live.place.channelId), live.place.guildId!, { respondAutomatically: on });
        logActivity(live.place.guildId, live.place.channelId, "settings", `respondAutomatically → ${on} by ${live.requesterId}`);
        return `Respond automatically is now ${on ? "on" : "off"} in this channel.`;
      },
      async setTaskTitle(title) {
        const live = L();
        live.title = title;
        run("UPDATE sessions SET title = ? WHERE id = ?", title, live.rowId);
        if (live.target.isThread()) await live.target.setName(title.slice(0, 100)).catch(() => {});
      },
      routinesChanged: () => self.scheduler?.reload(),

      async respondInThread(messageId, text) {
        channelOnly();
        const live = L();
        const msg = await self.fetchChannelMessage(live.place.channelId, messageId);
        const thread = msg.hasThread && msg.thread ? msg.thread : await msg.startThread({ name: titleFrom(msg.content || "Reply").slice(0, 100), autoArchiveDuration: 1440 });
        if (!self.activeRow(thread.id)) self.createRow(thread.id, "thread", placeOf(thread)!, null, msg.author.id);
        await self.poster.post(thread, { text, sessionKey: thread.id, model: live.agent.model });
        self.markActed(live.key, messageId);
        return `Replied in thread ${thread.id}.`;
      },
      async startTask(messageId, title, brief) {
        channelOnly();
        const live = L();
        const msg = await self.fetchChannelMessage(live.place.channelId, messageId);
        self.markActed(live.key, messageId);
        const thread = await self.startTask(msg, title, brief, msg.author.id);
        return `Started "${title}" in thread ${thread.id}.`;
      },
      async handoff(threadId, note) {
        channelOnly();
        const live = L();
        const thread = await self.client.channels.fetch(threadId).catch(() => null);
        if (!thread?.isThread() || thread.parentId !== live.place.channelId) throw new Error("No such thread in this channel.");
        const { live: t } = await self.ensure(thread.id, "thread", placeOf(thread)!, thread, { requesterId: live.requesterId });
        await self.deliver(t, `[Handoff from the channel] ${note}`, live.requesterId);
        for (const id of [...live.pendingMentions.keys()]) self.markActed(live.key, id);
        return `Handed off to thread ${threadId}.`;
      },
      async react(messageId, emoji) {
        channelOnly();
        const live = L();
        const msg = await self.fetchChannelMessage(live.place.channelId, messageId);
        await msg.react(emoji);
        self.markActed(live.key, messageId);
      },
    };
  }

  /** Is this one of Claude's own messages (for 👎 muting)? */
  isBotMessage(messageId: string): { sessionKey: string | null } | undefined {
    const r = get<{ session_key: string | null }>("SELECT session_key FROM bot_messages WHERE message_id = ?", messageId);
    return r ? { sessionKey: r.session_key } : undefined;
  }

}
