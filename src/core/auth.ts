/**
 * Which Claude credential a session runs on.
 *
 * - `api-key`      — an Anthropic API key (Console). Usage bills per token.
 * - `subscription` — a Claude Pro/Max subscription token created with `claude setup-token`
 *                    (CLAUDE_CODE_OAUTH_TOKEN). Usage counts against that subscription's limits.
 * - `local-login`  — neither is set; Claude Code falls back to whatever account is logged in
 *                    on this machine (`claude /login`).
 *
 * Channel work always runs on the bot operator's credential. A DM runs on the sender's own
 * API key when they saved one with `/claude account set-key`, mirroring Claude Tag, where a DM
 * runs on the sender's own account.
 */
export type Credential =
  | { kind: "api-key"; value: string; owner: "bot" | "user" }
  | { kind: "subscription"; value: string; owner: "bot" }
  | { kind: "local-login"; owner: "bot" };

export function botCredential(): Credential {
  const forced = process.env.AUTH_MODE?.toLowerCase();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (forced === "subscription") {
    if (!oauth) throw new Error("AUTH_MODE=subscription needs CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`).");
    return { kind: "subscription", value: oauth, owner: "bot" };
  }
  if (forced === "api-key") {
    if (!apiKey) throw new Error("AUTH_MODE=api-key needs ANTHROPIC_API_KEY.");
    return { kind: "api-key", value: apiKey, owner: "bot" };
  }
  if (forced === "local-login") return { kind: "local-login", owner: "bot" };

  if (apiKey) return { kind: "api-key", value: apiKey, owner: "bot" };
  if (oauth) return { kind: "subscription", value: oauth, owner: "bot" };
  return { kind: "local-login", owner: "bot" };
}

export function describeCredential(c: Credential): string {
  switch (c.kind) {
    case "api-key":
      return c.owner === "user" ? "your personal Anthropic API key" : "the bot's Anthropic API key";
    case "subscription":
      return "the operator's Claude subscription";
    case "local-login":
      return "the Claude account logged in on the host";
  }
}

/** Whether `total_cost_usd` reflects money actually billed (vs. an estimate against a subscription). */
export function isMetered(c: Credential): boolean {
  return c.kind === "api-key";
}

/** Host variables a Claude Code subprocess needs; everything else in process.env is withheld. */
const PASSTHROUGH = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ANTHROPIC_BASE_URL",
];

/** Names of the credential variables, so the sandbox can hide them from commands Claude runs. */
export const CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Build the environment for a Claude Code subprocess. The Discord token, the bot's secret key and
 * any other host secret never reach it.
 */
export function buildSessionEnv(
  credential: Credential,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  Object.assign(out, extra);
  if (credential.kind === "api-key") out.ANTHROPIC_API_KEY = credential.value;
  if (credential.kind === "subscription") out.CLAUDE_CODE_OAUTH_TOKEN = credential.value;
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "claude-tag-discord/1.0.0";
  return out;
}
