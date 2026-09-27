import { all, get, run } from "./db.js";
import type { ResolvedScope } from "./scopes.js";
import { config } from "../config.js";

/**
 * Channel work draws from the guild's budget under a monthly limit; each channel also has a
 * limit (its own, or the guild's default for channels). DMs are tracked but not capped here:
 * they run on the sender's own account when they saved a key.
 */
export type UsageKind = "channel" | "dm" | "routine";

export function period(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodStart(p = period()): number {
  const [y, m] = p.split("-").map(Number);
  return Date.UTC(y!, m! - 1, 1);
}

export function recordUsage(u: {
  guildId: string | null; channelId: string | null; userId: string | null;
  kind: UsageKind; work: string; model: string; costUsd: number; metered: boolean;
}): void {
  if (!(u.costUsd > 0)) return;
  run(
    "INSERT INTO usage (guild_id, channel_id, user_id, kind, work, model, cost_usd, metered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    u.guildId, u.channelId, u.userId, u.kind, u.work, u.model, u.costUsd, u.metered ? 1 : 0, Date.now(),
  );
}

export function guildSpend(guildId: string, p = period()): number {
  return get<{ s: number | null }>(
    "SELECT SUM(cost_usd) AS s FROM usage WHERE guild_id = ? AND kind != 'dm' AND created_at >= ?", guildId, periodStart(p),
  )?.s ?? 0;
}

export function channelSpend(channelId: string, p = period()): number {
  return get<{ s: number | null }>(
    "SELECT SUM(cost_usd) AS s FROM usage WHERE channel_id = ? AND kind != 'dm' AND created_at >= ?", channelId, periodStart(p),
  )?.s ?? 0;
}

export interface BudgetCheck {
  ok: boolean;
  /** Which limit blocked the work, when one did. */
  blockedBy?: "guild" | "channel";
  /** Remaining USD before the tighter limit is reached (undefined: no limit). */
  remaining?: number;
}

export function checkBudget(scope: ResolvedScope, channelId: string | null): BudgetCheck {
  if (!config.enforceSpendLimits || !scope.guildId) return { ok: true };
  let remaining: number | undefined;
  if (scope.monthlyLimitUsd !== undefined) {
    const left = scope.monthlyLimitUsd - guildSpend(scope.guildId);
    if (left <= 0) return { ok: false, blockedBy: "guild", remaining: 0 };
    remaining = left;
  }
  if (channelId && scope.channelLimitUsd !== undefined) {
    const left = scope.channelLimitUsd - channelSpend(channelId);
    if (left <= 0) return { ok: false, blockedBy: "channel", remaining: 0 };
    remaining = remaining === undefined ? left : Math.min(remaining, left);
  }
  return { ok: true, remaining };
}

/** Thresholds crossed for the first time this period (75%, 95%), so admins are alerted once each. */
export function newlyCrossedThresholds(scopeId: string, spent: number, limit: number | undefined): number[] {
  if (limit === undefined || limit <= 0) return [];
  const p = period();
  const crossed: number[] = [];
  for (const t of [75, 95]) {
    if (spent / limit >= t / 100) {
      const inserted = run("INSERT OR IGNORE INTO alerts_sent (scope_id, period, threshold) VALUES (?, ?, ?)", scopeId, p, t);
      if (inserted.changes > 0) crossed.push(t);
    }
  }
  return crossed;
}

export interface UsageReport {
  total: number;
  byChannel: { channel_id: string; spend: number }[];
  byKind: { kind: string; spend: number }[];
  byWork: { work: string; spend: number }[];
}

export function usageReport(guildId: string, p = period()): UsageReport {
  const since = periodStart(p);
  return {
    total: get<{ s: number | null }>("SELECT SUM(cost_usd) AS s FROM usage WHERE guild_id = ? AND created_at >= ?", guildId, since)?.s ?? 0,
    byChannel: all("SELECT channel_id, SUM(cost_usd) AS spend FROM usage WHERE guild_id = ? AND created_at >= ? GROUP BY channel_id ORDER BY spend DESC LIMIT 25", guildId, since),
    byKind: all("SELECT kind, SUM(cost_usd) AS spend FROM usage WHERE guild_id = ? AND created_at >= ? GROUP BY kind", guildId, since),
    byWork: all("SELECT work, SUM(cost_usd) AS spend FROM usage WHERE guild_id = ? AND created_at >= ? GROUP BY work ORDER BY spend DESC LIMIT 10", guildId, since),
  };
}
