import { z } from "zod";
import { all, get, run } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { config } from "../config.js";

/**
 * A scope is where access and behavior are configured, like Claude Tag's organization /
 * workspace / channel scopes. On Discord there are two levels: the guild (server) scope, which
 * every channel inherits, and a channel scope that narrows or extends it. Threads use their
 * parent channel's scope.
 */
const mcpServerSchema = z.union([
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export const scopeConfigSchema = z
  .object({
    /** Turns Claude on or off in this scope. */
    enabled: z.boolean().optional(),
    /** Channel only: reply to messages nobody tagged Claude in, when a reply is warranted. */
    respondAutomatically: z.boolean().optional(),
    /** Standing guidance read in every session. Stacks guild → channel; outranks memory. */
    instructions: z.string().max(8000).optional(),
    /** Default model new sessions start on. */
    model: z.string().optional(),
    /** Whether channel members (not just admins) may change channel settings from Discord. */
    memberEdits: z.enum(["allow", "block"]).optional(),
    /** Plain-sentence descriptions of pre-approved actions. Stack guild → channel. */
    allowRules: z.array(z.string().max(1024)).max(50).optional(),
    /** Hosts reachable from the sandbox without a credential. Union guild ∪ channel. */
    domains: z.array(z.string()).optional(),
    /** Baseline network access for the sandbox: package registries only, none, or everything. */
    networkAccess: z.enum(["trusted", "none", "full"]).optional(),
    /** MCP servers (connections to tools). Merged guild → channel by name. */
    mcpServers: z.record(z.string(), mcpServerSchema).optional(),
    /** Local Claude Code plugin directories (bundles of skills). Union. */
    plugins: z.array(z.string()).optional(),
    /** GitHub repositories (owner/name) Claude may clone and open pull requests against. Union. */
    repositories: z.array(z.string()).optional(),
    /** Setup script run in each fresh sandbox, and non-secret environment variables. */
    environment: z
      .object({ setupScript: z.string().optional(), env: z.record(z.string(), z.string()).optional() })
      .optional(),
    /** How Claude works in channels a guest role can see. */
    guestMode: z.enum(["restrict", "channel_only", "full"]).optional(),
    /** Guild: roles that count as guests (like Slack guest accounts). */
    guestRoleIds: z.array(z.string()).optional(),
    /** Where message search looks: every public channel, or only channels Claude has worked in. */
    searchScope: z.enum(["all_public", "member_only"]).optional(),
    /** Guild: Claude won't read or respond in channels whose name matches (`*` and `?` wildcards). */
    blockedChannelPatterns: z.array(z.string().max(80)).max(50).optional(),
    /** Guild: when set, only members holding one of these roles can use Claude. */
    allowedRoleIds: z.array(z.string()).optional(),
    /** Guild: monthly cap across every channel, in USD (estimated list price). */
    monthlyLimitUsd: z.number().nonnegative().optional(),
    /** Guild: default monthly cap for each channel without its own. Channel: that channel's cap. */
    channelLimitUsd: z.number().nonnegative().optional(),
    /** Guild: where spend alerts (75% / 95%) and access requests are posted. */
    alertChannelId: z.string().optional(),
  })
  .strict();

export type ScopeConfig = z.infer<typeof scopeConfigSchema>;
export type McpServerJson = z.infer<typeof mcpServerSchema>;

export interface Connection {
  scopeId: string;
  name: string;
  envVar: string;
  hosts: string[];
}

export interface ResolvedScope {
  guildId: string | null;
  channelId: string | null;
  enabled: boolean;
  respondAutomatically: boolean;
  instructions: string[];
  model: string;
  memberEdits: "allow" | "block";
  allowRules: string[];
  domains: string[];
  networkAccess: "trusted" | "none" | "full";
  mcpServers: Record<string, McpServerJson>;
  plugins: string[];
  repositories: string[];
  setupScripts: string[];
  env: Record<string, string>;
  guestMode: "restrict" | "channel_only" | "full";
  guestRoleIds: string[];
  searchScope: "all_public" | "member_only";
  blockedChannelPatterns: string[];
  allowedRoleIds: string[];
  monthlyLimitUsd?: number;
  channelLimitUsd?: number;
  alertChannelId?: string;
  connections: Connection[];
  /** True when guests are present and this scope runs with channel-only access. */
  channelOnly: boolean;
}

export const guildScopeId = (guildId: string) => `guild:${guildId}`;
export const channelScopeId = (channelId: string) => `channel:${channelId}`;

export function readScope(scopeId: string): ScopeConfig {
  const row = get<{ json: string }>("SELECT json FROM scopes WHERE id = ?", scopeId);
  if (!row) return {};
  const parsed = scopeConfigSchema.safeParse(JSON.parse(row.json));
  return parsed.success ? parsed.data : {};
}

export function writeScope(scopeId: string, guildId: string, cfg: ScopeConfig): void {
  const valid = scopeConfigSchema.parse(cfg);
  run(
    `INSERT INTO scopes (id, guild_id, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    scopeId, guildId, JSON.stringify(valid), Date.now(),
  );
}

export function patchScope(scopeId: string, guildId: string, patch: Partial<ScopeConfig>): ScopeConfig {
  const next = { ...readScope(scopeId), ...patch };
  for (const k of Object.keys(next) as (keyof ScopeConfig)[]) if (next[k] === undefined) delete next[k];
  writeScope(scopeId, guildId, next);
  return next;
}

export function scopeUpdatedAt(scopeId: string): number {
  return get<{ updated_at: number }>("SELECT updated_at FROM scopes WHERE id = ?", scopeId)?.updated_at ?? 0;
}

/** Package registries and developer hosts reachable under the default "trusted" network level. */
export const TRUSTED_DOMAINS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
  "github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "crates.io", "static.crates.io", "index.crates.io",
  "proxy.golang.org", "sum.golang.org", "rubygems.org", "repo.maven.apache.org",
  "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "dl-cdn.alpinelinux.org",
];

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Resolve the effective configuration for a channel (pass the parent channel for a thread).
 * `hasGuests` applies the guest policy: under channel-only access, nothing inherited from the
 * guild applies, and neither do memory, plugins, or the environment.
 */
export function resolveScope(guildId: string | null, channelId: string | null, hasGuests = false): ResolvedScope {
  const g = guildId ? readScope(guildScopeId(guildId)) : {};
  const c = channelId ? readScope(channelScopeId(channelId)) : {};
  const guestMode = c.guestMode ?? g.guestMode ?? "restrict";
  const channelOnly = hasGuests && guestMode === "channel_only";
  const inherited: ScopeConfig = channelOnly ? {} : g;

  const connections = [
    ...(guildId && !channelOnly ? listConnections(guildScopeId(guildId)) : []),
    ...(channelId ? listConnections(channelScopeId(channelId)) : []),
  ];
  // A channel connection with the same name replaces the guild's.
  const byName = new Map(connections.map((x) => [x.name, x]));

  return {
    guildId,
    channelId,
    enabled: c.enabled ?? g.enabled ?? true,
    respondAutomatically: c.respondAutomatically ?? config.defaultRespondAutomatically,
    instructions: [inherited.instructions, c.instructions].filter((s): s is string => !!s?.trim()),
    model: c.model ?? g.model ?? config.defaultModel,
    memberEdits: c.memberEdits ?? g.memberEdits ?? "allow",
    allowRules: [...(inherited.allowRules ?? []), ...(c.allowRules ?? [])],
    domains: uniq([...(inherited.domains ?? []), ...(c.domains ?? [])]),
    networkAccess: channelOnly ? "trusted" : c.networkAccess ?? g.networkAccess ?? "trusted",
    mcpServers: { ...(inherited.mcpServers ?? {}), ...(c.mcpServers ?? {}) },
    plugins: channelOnly ? [] : uniq([...(g.plugins ?? []), ...(c.plugins ?? [])]),
    repositories: uniq([...(inherited.repositories ?? []), ...(c.repositories ?? [])]),
    setupScripts: channelOnly
      ? []
      : [g.environment?.setupScript, c.environment?.setupScript].filter((s): s is string => !!s?.trim()),
    env: channelOnly ? {} : { ...(g.environment?.env ?? {}), ...(c.environment?.env ?? {}) },
    guestMode,
    guestRoleIds: g.guestRoleIds ?? [],
    searchScope: c.searchScope ?? g.searchScope ?? "all_public",
    blockedChannelPatterns: g.blockedChannelPatterns ?? [],
    allowedRoleIds: g.allowedRoleIds ?? [],
    monthlyLimitUsd: g.monthlyLimitUsd,
    channelLimitUsd: c.channelLimitUsd ?? g.channelLimitUsd,
    alertChannelId: g.alertChannelId,
    connections: [...byName.values()],
    channelOnly,
  };
}

/** Glob match for channel-name patterns: lowercase, `*` = any run, `?` = one character. */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return re.test(name.toLowerCase());
}

export function isBlockedChannel(scope: ResolvedScope, channelName: string): boolean {
  return scope.blockedChannelPatterns.some((p) => matchesPattern(channelName, p));
}

// ── Connections: named credentials, attached to a scope ───────────────────────────────────────

export function listConnections(scopeId: string): Connection[] {
  return all<{ scope_id: string; name: string; env_var: string; hosts: string }>(
    "SELECT scope_id, name, env_var, hosts FROM secrets WHERE scope_id = ? ORDER BY name", scopeId,
  ).map((r) => ({ scopeId: r.scope_id, name: r.name, envVar: r.env_var, hosts: JSON.parse(r.hosts) }));
}

export function setConnection(
  scopeId: string, name: string, envVar: string, hosts: string[], value: string, by: string,
): void {
  run(
    `INSERT INTO secrets (scope_id, name, env_var, hosts, value_enc, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, name) DO UPDATE SET env_var = excluded.env_var, hosts = excluded.hosts,
       value_enc = excluded.value_enc, created_by = excluded.created_by, created_at = excluded.created_at`,
    scopeId, name, envVar, JSON.stringify(hosts), encrypt(value), by, Date.now(),
  );
  run("UPDATE scopes SET updated_at = ? WHERE id = ?", Date.now(), scopeId);
}

export function removeConnection(scopeId: string, name: string): boolean {
  const removed = run("DELETE FROM secrets WHERE scope_id = ? AND name = ?", scopeId, name).changes > 0;
  if (removed) run("UPDATE scopes SET updated_at = ? WHERE id = ?", Date.now(), scopeId);
  return removed;
}

export function connectionValue(c: Connection): string {
  const row = get<{ value_enc: string }>(
    "SELECT value_enc FROM secrets WHERE scope_id = ? AND name = ?", c.scopeId, c.name,
  );
  if (!row) throw new Error(`Connection ${c.name} no longer exists`);
  return decrypt(row.value_enc);
}
