import { Cron } from "croner";
import { all, get, run } from "./db.js";
import { log } from "./log.js";
import { config } from "../config.js";

/**
 * Routines are scheduled work a channel owns: a cron schedule ("every weekday at 9"), a channel
 * watch (a schedule whose prompt reads other channels), or a subscription to one GitHub pull
 * request that wakes Claude on CI, review or merge changes. Anyone in the channel can list,
 * pause, reschedule or stop them; they keep running if their creator leaves.
 */
export interface Routine {
  id: number;
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  kind: "schedule" | "pr";
  name: string;
  cron: string | null;
  timezone: string | null;
  prompt: string;
  repo: string | null;
  prNumber: number | null;
  ownerKind: "channel" | "dm";
  createdBy: string;
  enabled: boolean;
  state: Record<string, unknown>;
  lastRunAt: number | null;
  lastStatus: string | null;
}

type RoutineRow = {
  id: number; guild_id: string | null; channel_id: string; thread_id: string | null; kind: "schedule" | "pr";
  name: string; cron: string | null; timezone: string | null; prompt: string; repo: string | null;
  pr_number: number | null; owner_kind: "channel" | "dm"; created_by: string; enabled: number; state: string;
  last_run_at: number | null; last_status: string | null;
};

function toRoutine(r: RoutineRow): Routine {
  return {
    id: r.id, guildId: r.guild_id, channelId: r.channel_id, threadId: r.thread_id, kind: r.kind, name: r.name,
    cron: r.cron, timezone: r.timezone, prompt: r.prompt, repo: r.repo, prNumber: r.pr_number, ownerKind: r.owner_kind,
    createdBy: r.created_by, enabled: r.enabled === 1, state: JSON.parse(r.state || "{}"),
    lastRunAt: r.last_run_at, lastStatus: r.last_status,
  };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws with a readable message when the cron expression or timezone is invalid. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date {
  if (!isValidTimezone(timezone)) throw new Error(`Unknown timezone "${timezone}". Use an IANA name like America/New_York.`);
  let job: Cron;
  try {
    job = new Cron(cron, { timezone, paused: true });
  } catch (e) {
    throw new Error(`Invalid cron expression "${cron}": ${(e as Error).message}`);
  }
  const next = job.nextRun(from);
  job.stop();
  if (!next) throw new Error(`"${cron}" never runs.`);
  return next;
}

export function createRoutine(r: {
  guildId: string | null; channelId: string; threadId: string | null; kind: "schedule" | "pr"; name: string;
  cron?: string; timezone?: string; prompt: string; repo?: string; prNumber?: number;
  ownerKind: "channel" | "dm"; createdBy: string;
}): Routine {
  if (r.kind === "schedule") {
    if (!r.cron) throw new Error("A scheduled routine needs a cron expression.");
    nextRun(r.cron, r.timezone ?? config.defaultTimezone);
  } else {
    if (!r.repo || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) throw new Error("repo must look like owner/name.");
    if (!r.prNumber || r.prNumber < 1) throw new Error("pr_number must be a positive integer.");
  }
  const { lastInsertRowid } = run(
    `INSERT INTO routines (guild_id, channel_id, thread_id, kind, name, cron, timezone, prompt, repo, pr_number, owner_kind, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.guildId, r.channelId, r.threadId, r.kind, r.name.slice(0, 100), r.cron ?? null,
    r.kind === "schedule" ? r.timezone ?? config.defaultTimezone : null, r.prompt.slice(0, 4000),
    r.repo ?? null, r.prNumber ?? null, r.ownerKind, r.createdBy, Date.now(),
  );
  return getRoutine(lastInsertRowid)!;
}

export function getRoutine(id: number): Routine | undefined {
  const r = get<RoutineRow>("SELECT * FROM routines WHERE id = ?", id);
  return r ? toRoutine(r) : undefined;
}

export function listRoutines(channelId: string): Routine[] {
  return all<RoutineRow>("SELECT * FROM routines WHERE channel_id = ? ORDER BY id", channelId).map(toRoutine);
}

export function allEnabledRoutines(): Routine[] {
  return all<RoutineRow>("SELECT * FROM routines WHERE enabled = 1 ORDER BY id").map(toRoutine);
}

/** Routines belong to a channel: they can only be changed from that channel. */
export function updateRoutine(
  channelId: string, id: number,
  patch: { enabled?: boolean; cron?: string; timezone?: string; prompt?: string; name?: string },
): Routine {
  const r = getRoutine(id);
  if (!r || r.channelId !== channelId) throw new Error(`No routine #${id} in this channel.`);
  if (patch.cron !== undefined || patch.timezone !== undefined) {
    if (r.kind !== "schedule") throw new Error("Only scheduled routines have a schedule.");
    nextRun(patch.cron ?? r.cron!, patch.timezone ?? r.timezone ?? config.defaultTimezone);
  }
  run(
    "UPDATE routines SET enabled = ?, cron = ?, timezone = ?, prompt = ?, name = ? WHERE id = ?",
    patch.enabled === undefined ? (r.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
    patch.cron ?? r.cron, patch.timezone ?? r.timezone, patch.prompt?.slice(0, 4000) ?? r.prompt,
    patch.name?.slice(0, 100) ?? r.name, id,
  );
  return getRoutine(id)!;
}

export function deleteRoutine(channelId: string, id: number): void {
  const r = getRoutine(id);
  if (!r || r.channelId !== channelId) throw new Error(`No routine #${id} in this channel.`);
  run("DELETE FROM routines WHERE id = ?", id);
}

export function recordRun(id: number, status: string, state?: Record<string, unknown>): void {
  if (state) run("UPDATE routines SET last_run_at = ?, last_status = ?, state = ? WHERE id = ?", Date.now(), status, JSON.stringify(state), id);
  else run("UPDATE routines SET last_run_at = ?, last_status = ? WHERE id = ?", Date.now(), status, id);
}

export function setRoutineThread(id: number, threadId: string): void {
  run("UPDATE routines SET thread_id = ? WHERE id = ?", threadId, id);
}

export function describeRoutine(r: Routine): string {
  const what = r.kind === "pr" ? `PR ${r.repo}#${r.prNumber}` : `\`${r.cron}\` (${r.timezone})`;
  const next = r.kind === "schedule" && r.enabled && r.cron
    ? (() => {
        try {
          return ` · next <t:${Math.floor(nextRun(r.cron, r.timezone ?? "UTC").getTime() / 1000)}:R>`;
        } catch {
          return "";
        }
      })()
    : "";
  return `#${r.id} **${r.name}** — ${what}${r.enabled ? "" : " · ⏸ paused"}${next} · by <@${r.createdBy}>${r.lastStatus ? ` · last: ${r.lastStatus}` : ""}`;
}

// ── GitHub pull request subscriptions ────────────────────────────────────────────────────────

export interface PrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  ci: "pending" | "success" | "failure" | "none";
  /** Latest review per reviewer, as "login:STATE". */
  reviews: string[];
}

/** Events worth waking Claude for, comparing the last snapshot with the current one. */
export function diffPr(prev: PrSnapshot | undefined, next: PrSnapshot): string[] {
  if (!prev) return [];
  const events: string[] = [];
  if (!prev.merged && next.merged) events.push("The pull request was merged.");
  else if (prev.state === "open" && next.state === "closed") events.push("The pull request was closed without merging.");
  else if (prev.state === "closed" && next.state === "open") events.push("The pull request was reopened.");
  if (prev.headSha !== next.headSha) events.push(`New commits were pushed (head ${next.headSha.slice(0, 7)}).`);
  if (prev.ci !== next.ci && (next.ci === "success" || next.ci === "failure")) {
    events.push(next.ci === "success" ? "CI passed." : "CI failed.");
  }
  const before = new Set(prev.reviews);
  for (const r of next.reviews) {
    if (before.has(r)) continue;
    const [who, state] = r.split(":");
    events.push(`${who} submitted a review: ${state?.toLowerCase().replace(/_/g, " ")}.`);
  }
  return events;
}

async function gh<T>(pathname: string): Promise<T> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-tag-discord",
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${pathname}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function summarizeChecks(runs: { status: string; conclusion: string | null }[]): PrSnapshot["ci"] {
  if (!runs.length) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const bad = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];
  return runs.some((r) => r.conclusion && bad.includes(r.conclusion)) ? "failure" : "success";
}

export async function fetchPr(repo: string, n: number): Promise<PrSnapshot> {
  const pr = await gh<{ state: "open" | "closed"; merged: boolean; head: { sha: string } }>(`/repos/${repo}/pulls/${n}`);
  const checks = await gh<{ check_runs: { status: string; conclusion: string | null }[] }>(
    `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
  );
  const reviews = await gh<{ user: { login: string } | null; state: string }[]>(`/repos/${repo}/pulls/${n}/reviews?per_page=100`);
  const latest = new Map<string, string>();
  for (const r of reviews) if (r.user && r.state !== "COMMENTED" && r.state !== "PENDING") latest.set(r.user.login, r.state);
  return {
    state: pr.state,
    merged: pr.merged,
    headSha: pr.head.sha,
    ci: summarizeChecks(checks.check_runs),
    reviews: [...latest].map(([who, s]) => `${who}:${s}`).sort(),
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────────────────────

export type FireRoutine = (r: Routine, trigger: string) => Promise<void>;

export class RoutineScheduler {
  private jobs = new Map<number, Cron>();
  private prTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(private readonly fire: FireRoutine) {}

  start(): void {
    this.reload();
    this.prTimer = setInterval(() => void this.pollPrs(), config.prPollIntervalMs);
    this.prTimer.unref();
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    if (this.prTimer) clearInterval(this.prTimer);
  }

  /** Re-read routines from the database after any change. */
  reload(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    for (const r of allEnabledRoutines()) {
      if (r.kind !== "schedule" || !r.cron) continue;
      try {
        const job = new Cron(r.cron, { timezone: r.timezone ?? "UTC", protect: true }, () => {
          const current = getRoutine(r.id);
          if (current?.enabled) void this.fire(current, "schedule").catch((e) => log.error(`routine #${r.id} failed`, e));
        });
        this.jobs.set(r.id, job);
      } catch (e) {
        log.warn(`routine #${r.id} has an invalid schedule`, e);
      }
    }
  }

  async pollPrs(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const r of allEnabledRoutines()) {
        if (r.kind !== "pr" || !r.repo || !r.prNumber) continue;
        try {
          const snap = await fetchPr(r.repo, r.prNumber);
          const prev = r.state.pr as PrSnapshot | undefined;
          const events = diffPr(prev, snap);
          const done = snap.merged || snap.state === "closed";
          run("UPDATE routines SET state = ?, enabled = ? WHERE id = ?", JSON.stringify({ ...r.state, pr: snap }), done ? 0 : 1, r.id);
          if (events.length) await this.fire({ ...r, state: { ...r.state, pr: snap } }, events.join(" "));
        } catch (e) {
          log.warn(`PR poll for routine #${r.id} failed`, e);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
