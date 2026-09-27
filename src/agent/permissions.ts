import path from "node:path";
import crypto from "node:crypto";
import type { CanUseTool, HookCallbackMatcher, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedScope } from "../core/scopes.js";
import { hostAllowed } from "./sandbox.js";

export type Decision = { kind: "allow" } | { kind: "deny"; message: string } | { kind: "ask"; risky: boolean };

export interface PolicyContext {
  cwd: string;
  sandboxed: boolean;
  scope: ResolvedScope;
}

const ALWAYS_ALLOW = new Set([
  "TodoWrite", "WebSearch", "Task", "Agent", "BashOutput", "KillShell", "Skill", "ToolSearch",
]);
const FILE_READERS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const FILE_WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Built-ins that only make sense with a terminal user; Claude asks in the thread instead. */
const NOT_ON_DISCORD = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree"]);

const RISKY = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i,
  /\bgit\s+push\b[^\n]*(--force|-f\b|--force-with-lease)/i,
  /\bgit\s+push\b[^\n]*\b(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bsudo\b/,
  /\b(npm|pnpm|yarn|cargo|twine|gem)\s+publish\b/i,
  /\b(kubectl|helm|terraform|pulumi|fly|vercel|netlify|heroku)\b[^\n]*\b(apply|deploy|destroy|delete|up)\b/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\bchmod\s+-R\s+777\b/,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
];

export function isRiskyCommand(cmd: string): boolean {
  return RISKY.some((re) => re.test(cmd));
}

export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(dir, file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function pathArg(input: Record<string, unknown>): unknown {
  return input.file_path ?? input.notebook_path ?? input.path;
}

/**
 * Hard limits, enforced from a PreToolUse hook so they apply even to calls Claude Code would
 * auto-approve (it treats commands like `cat` as read-only). File tools stay inside the session's
 * workspace, and with the sandbox off every shell command needs a person's approval.
 * Returns null when the normal permission flow should decide.
 */
export function hardRule(
  toolName: string, input: Record<string, unknown>, ctx: Pick<PolicyContext, "cwd" | "sandboxed">,
): { kind: "deny"; message: string } | { kind: "ask" } | null {
  if (FILE_READERS.has(toolName) || FILE_WRITERS.has(toolName)) {
    const p = pathArg(input);
    // Glob/Grep without a path search the workspace.
    if (p === undefined && !FILE_WRITERS.has(toolName) && toolName !== "Read") return null;
    if (typeof p === "string" && isInside(ctx.cwd, p)) return null;
    return { kind: "deny", message: `File access is limited to your workspace (${ctx.cwd}).` };
  }
  if (toolName === "Bash" && !ctx.sandboxed) return { kind: "ask" };
  return null;
}

/** The PreToolUse hook that enforces `hardRule` for a session. */
export function hardRuleHook(cwd: string, sandboxed: boolean): HookCallbackMatcher {
  return {
    hooks: [async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const r = hardRule(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, { cwd, sandboxed });
      if (!r) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: r.kind,
          permissionDecisionReason: r.kind === "deny" ? r.message : "Needs approval in Discord.",
        },
      };
    }],
  };
}

/**
 * What to do with a tool call that Claude Code didn't already allow on its own.
 * Allowed without asking: our own tools, admin-configured MCP servers, read-only tools, edits
 * inside the workspace, and web fetches to allowed hosts. Everything else asks a person.
 */
export function decide(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  if (toolName.startsWith("mcp__tag__")) return { kind: "allow" };
  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1] ?? "";
    return server in ctx.scope.mcpServers ? { kind: "allow" } : { kind: "ask", risky: false };
  }
  if (NOT_ON_DISCORD.has(toolName)) {
    return { kind: "deny", message: "Not available on Discord. Ask your question in the thread as a normal message and end your turn." };
  }
  if (ALWAYS_ALLOW.has(toolName)) return { kind: "allow" };
  if (FILE_READERS.has(toolName) || FILE_WRITERS.has(toolName)) {
    const hard = hardRule(toolName, input, ctx);
    return hard?.kind === "deny" ? hard : { kind: "allow" };
  }
  if (toolName === "WebFetch") {
    const host = hostOf(input.url);
    return host && hostAllowed(ctx.scope, host) ? { kind: "allow" } : { kind: "ask", risky: false };
  }
  if (toolName === "Bash") {
    // A sandboxed command is auto-allowed before it reaches us; anything here runs outside it.
    const cmd = typeof input.command === "string" ? input.command : "";
    return { kind: "ask", risky: !ctx.sandboxed || isRiskyCommand(cmd) };
  }
  // Sandbox network requests carry a host.
  if (typeof input.host === "string") {
    return hostAllowed(ctx.scope, input.host)
      ? { kind: "allow" }
      : { kind: "deny", message: `Network access to ${input.host} is blocked here. An admin can allow it in the channel's domains.` };
  }
  return { kind: "ask", risky: false };
}

/** One line a person can judge a tool call by. */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  let body: string;
  if (toolName === "Bash") body = s(input.command);
  else if (toolName === "WebFetch") body = s(input.url);
  else if (FILE_WRITERS.has(toolName)) body = s(pathArg(input));
  else body = JSON.stringify(input);
  return body.length > 900 ? `${body.slice(0, 900)}…` : body;
}

// ── Approval broker: Approve / Deny buttons in the thread ────────────────────────────────────

export interface ApprovalRequest {
  sessionKey: string;
  toolName: string;
  summary: string;
  risky: boolean;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  canApprove(userId: string): boolean;
  resolve(ok: boolean, by: string | null): void;
}

export type ResolveOutcome = "ok" | "forbidden" | "unknown";

export class ApprovalBroker {
  private pending = new Map<string, PendingApproval>();

  constructor(private readonly timeoutMs: number) {}

  /** Register a request; the caller shows buttons with `approve:<id>` / `deny:<id>` custom ids. */
  create(
    req: ApprovalRequest,
    canApprove: (userId: string) => boolean,
    signal?: AbortSignal,
  ): { id: string; decision: Promise<{ ok: boolean; by: string | null }> } {
    const id = crypto.randomBytes(8).toString("hex");
    const decision = new Promise<{ ok: boolean; by: string | null }>((resolve) => {
      const done = (ok: boolean, by: string | null) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        resolve({ ok, by });
      };
      const timer = setTimeout(() => done(false, null), this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", () => done(false, null), { once: true });
      this.pending.set(id, { ...req, id, canApprove, resolve: done });
    });
    return { id, decision };
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  resolve(id: string, userId: string, ok: boolean): ResolveOutcome {
    const p = this.pending.get(id);
    if (!p) return "unknown";
    if (!p.canApprove(userId)) return "forbidden";
    p.resolve(ok, userId);
    return "ok";
  }

  /** Deny everything still waiting for a session (it was stopped, muted or closed). */
  cancelFor(sessionKey: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionKey === sessionKey) p.resolve(false, null);
  }

  get size(): number {
    return this.pending.size;
  }

  countFor(sessionKey: string): number {
    return [...this.pending.values()].filter((p) => p.sessionKey === sessionKey).length;
  }
}

export interface CanUseToolDeps {
  policy: () => PolicyContext;
  /** Show the request to people and wait. Resolves true when approved. */
  askHuman(req: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
  sessionKey: string;
}

export function makeCanUseTool(deps: CanUseToolDeps): CanUseTool {
  return async (toolName, input, { signal }): Promise<PermissionResult> => {
    const d = decide(toolName, input, deps.policy());
    if (d.kind === "allow") return { behavior: "allow", updatedInput: input };
    if (d.kind === "deny") return { behavior: "deny", message: d.message };
    const ok = await deps.askHuman(
      { sessionKey: deps.sessionKey, toolName, summary: summarizeToolCall(toolName, input), risky: d.risky },
      signal,
    );
    return ok
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "A person in the channel denied this (or nobody answered in time). Don't retry it; find another way or ask." };
  };
}
