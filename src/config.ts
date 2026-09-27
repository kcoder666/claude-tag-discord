import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(name: string, fallback: number): number {
  const v = env(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[] = []): string[] {
  const v = env(name);
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const dataDir = path.resolve(env("DATA_DIR", "./data")!);

export const config = {
  discordToken: env("DISCORD_TOKEN"),
  /** Register slash commands to one guild instantly (dev) instead of globally. */
  devGuildId: env("DEV_GUILD_ID"),
  /** Discord user IDs that act as organization Owners in every guild. */
  ownerIds: list("OWNER_IDS"),

  dataDir,
  workspacesDir: path.join(dataDir, "workspaces"),
  artifactsDir: path.join(dataDir, "artifacts"),
  dbPath: path.join(dataDir, "claude-tag.db"),
  /** Encrypts connection secrets and personal API keys at rest (any string; hashed to a key). */
  secretKey: env("SECRET_KEY"),

  defaultModel: env("DEFAULT_MODEL", "claude-opus-5")!,
  /** Models members may switch to. The default model is always allowed. */
  allowedModels: list("ALLOWED_MODELS", ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]),
  /** Model for the always-on channel session (ambient triage + top-level replies). */
  channelModel: env("CHANNEL_MODEL", env("DEFAULT_MODEL", "claude-opus-5"))!,
  channelEffort: env("CHANNEL_EFFORT", "low") as "low" | "medium" | "high" | "xhigh" | "max",
  taskEffort: env("TASK_EFFORT", "high") as "low" | "medium" | "high" | "xhigh" | "max",

  /** 'default' → our approval policy + Approve/Deny buttons; 'auto' → Claude Code's auto-mode classifier. */
  permissionMode: env("PERMISSION_MODE", "default") as "default" | "auto",
  sandboxEnabled: bool("SANDBOX_ENABLED", true),
  defaultRespondAutomatically: bool("DEFAULT_RESPOND_AUTOMATICALLY", true),
  defaultTimezone: env("DEFAULT_TIMEZONE", "UTC")!,
  allowDmsDefault: bool("ALLOW_DMS", true),
  /** When a DM sender has no personal API key, run their DM on the bot's credential. */
  dmFallbackToBotCredential: bool("DM_FALLBACK_TO_BOT_CREDENTIAL", true),

  /** A thread's working sandbox is released after this long without activity. */
  sandboxIdleMs: num("SANDBOX_IDLE_MINUTES", 5) * 60_000,
  /** The channel session is replaced after this long idle, or once it is this old and quiet. */
  channelSessionIdleMs: num("CHANNEL_SESSION_IDLE_MINUTES", 60) * 60_000,
  channelSessionMaxAgeMs: num("CHANNEL_SESSION_MAX_AGE_HOURS", 24) * 3_600_000,
  /** Stop reading a channel's top-level messages after this many arrive without Claude posting. */
  stopReadingAfter: num("STOP_READING_AFTER", 100),
  /** How many earlier thread messages a mid-thread mention gets as context. */
  threadContextWindow: num("THREAD_CONTEXT_WINDOW", 50),
  maxTurnsPerMessage: num("MAX_TURNS_PER_MESSAGE", 200),
  approvalTimeoutMs: num("APPROVAL_TIMEOUT_MINUTES", 15) * 60_000,

  /** Hosted pages ("artifacts"): served when set, e.g. https://claude.example.com */
  publicBaseUrl: env("PUBLIC_BASE_URL"),
  httpPort: num("HTTP_PORT", 8787),

  githubToken: env("GITHUB_TOKEN"),
  prPollIntervalMs: num("PR_POLL_SECONDS", 120) * 1000,
  feedbackChannelId: env("FEEDBACK_CHANNEL_ID"),
  /** Spend is enforced against estimated list-price cost. Disable when running on a subscription. */
  enforceSpendLimits: bool("ENFORCE_SPEND_LIMITS", true),
  logLevel: env("LOG_LEVEL", "info")!,
};

export type Effort = typeof config.taskEffort;
