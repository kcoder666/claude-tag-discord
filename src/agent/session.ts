import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SandboxSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../core/log.js";
import type { Credential } from "../core/auth.js";
import type { Effort } from "../config.js";

export type UserContent = SDKUserMessage["message"]["content"];

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TurnResult {
  text: string;
  isError: boolean;
  /** Cost of this turn alone (the SDK reports a running total; we diff it). */
  turnCostUsd: number;
  model: string;
  /** More queued messages will run as further turns without new input. */
  morePending: boolean;
}

export interface SessionHandlers {
  onSessionId?(id: string): void;
  onTurnStart?(): void;
  onTodos?(todos: Todo[]): void;
  onToolUse?(name: string, input: Record<string, unknown>): void;
  onTurnEnd?(result: TurnResult): void | Promise<void>;
  onClosed?(reason: string): void;
}

export interface SessionOptions {
  key: string;
  cwd: string;
  model: string;
  effort: Effort;
  credentialEnv: Record<string, string>;
  credential: Credential;
  systemAppend: string;
  /** Built-in tools to expose; [] disables them all (the channel session uses only our tools). */
  builtinTools?: string[];
  mcpServers: Record<string, McpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool: CanUseTool;
  permissionMode: "default" | "auto";
  sandbox?: SandboxSettings;
  plugins?: string[];
  resume?: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  handlers: SessionHandlers;
}

/**
 * One long-lived Claude Agent SDK session in streaming-input mode. Messages pushed while a turn
 * is running are folded into the work in progress, which is how anyone in a thread can steer a
 * task without starting over.
 */
export class AgentSession {
  readonly key: string;
  readonly startedAt = Date.now();
  lastActivity = Date.now();
  busySince: number | null = null;
  sdkSessionId: string | undefined;
  model: string;
  closed = false;

  private q: Query;
  private queue: SDKUserMessage[] = [];
  private waiter: ((m: SDKUserMessage | null) => void) | null = null;
  private lastCostTotal = 0;
  private readonly abort = new AbortController();
  private readonly handlers: SessionHandlers;

  constructor(private readonly opts: SessionOptions) {
    this.key = opts.key;
    this.model = opts.model;
    this.handlers = opts.handlers;

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      env: opts.credentialEnv,
      abortController: this.abort,
      systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemAppend },
      mcpServers: opts.mcpServers,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      hooks: opts.hooks,
      canUseTool: opts.canUseTool,
      permissionMode: opts.permissionMode,
      // Read CLAUDE.md files in cloned repositories, but never the host user's own settings.
      settingSources: ["project"],
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      resume: opts.resume,
      stderr: (d) => log.debug(`[${opts.key}] ${d.trim()}`),
    };
    if (opts.builtinTools) options.tools = opts.builtinTools;
    if (opts.sandbox) options.sandbox = opts.sandbox;
    if (opts.plugins?.length) options.plugins = opts.plugins.map((p) => ({ type: "local" as const, path: p }));

    this.q = query({ prompt: this.input(), options });
    void this.pump();
  }

  get busy(): boolean {
    return this.busySince !== null;
  }

  /** Queue a user message. Starts a turn, or joins the running one. */
  push(content: UserContent): void {
    if (this.closed) throw new Error("session closed");
    this.lastActivity = Date.now();
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
    if (!this.busy) {
      this.busySince = Date.now();
      this.handlers.onTurnStart?.();
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.busy) return;
    try {
      await this.q.interrupt();
    } catch (e) {
      log.warn(`[${this.key}] interrupt failed`, e);
    }
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
    this.model = model;
  }

  /** End the session. The transcript stays on disk, so it can be resumed later. */
  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
    // Give the CLI a moment to flush the transcript, then make sure the process is gone.
    setTimeout(() => this.abort.abort(), 5_000).unref();
    this.handlers.onClosed?.(reason);
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift() ?? (await new Promise<SDKUserMessage | null>((r) => (this.waiter = r)));
      if (!next) return;
      yield next;
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q) this.handle(m);
      if (!this.closed) this.close("ended");
    } catch (e) {
      if (!this.closed) {
        log.error(`[${this.key}] session crashed`, e);
        if (this.busy) {
          this.busySince = null;
          await this.handlers.onTurnEnd?.({
            text: `I hit an error and stopped: ${(e as Error).message}`,
            isError: true, turnCostUsd: 0, model: this.model, morePending: false,
          });
        }
        this.close("crashed");
      }
    }
  }

  private handle(m: SDKMessage): void {
    this.lastActivity = Date.now();
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.sdkSessionId = m.session_id;
          this.model = m.model;
          this.handlers.onSessionId?.(m.session_id);
        }
        return;
      case "assistant":
        for (const block of m.message.content) {
          if (block.type !== "tool_use") continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === "TodoWrite" && Array.isArray(input.todos)) {
            this.handlers.onTodos?.(input.todos as Todo[]);
          }
          this.handlers.onToolUse?.(block.name, input);
        }
        return;
      case "result": {
        const total = m.total_cost_usd ?? 0;
        const turnCost = Math.max(0, total - this.lastCostTotal);
        this.lastCostTotal = total;
        const morePending = (m.queued_turn_count ?? 0) > 0;
        if (!morePending) this.busySince = null;
        const text = m.subtype === "success" ? m.result : m.errors?.join("\n") || `Stopped (${m.subtype}).`;
        void Promise.resolve(
          this.handlers.onTurnEnd?.({
            text: text ?? "", isError: m.is_error || m.subtype !== "success", turnCostUsd: turnCost,
            model: this.model, morePending,
          }),
        ).catch((e) => log.error(`[${this.key}] onTurnEnd failed`, e));
        return;
      }
      default:
        return;
    }
  }
}
