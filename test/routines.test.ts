import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import {
  createRoutine, deleteRoutine, describeRoutine, diffPr, listRoutines, nextRun, summarizeChecks, updateRoutine,
  type PrSnapshot,
} from "../src/core/routines.js";

beforeEach(() => {
  useMemoryDb();
});

const base = { guildId: "g", channelId: "c", threadId: null, ownerKind: "channel" as const, createdBy: "u1" };

describe("schedules", () => {
  it("computes the next run in the routine's timezone", () => {
    const from = new Date("2026-03-02T00:00:00Z"); // a Monday
    expect(nextRun("0 9 * * 1-5", "America/New_York", from).toISOString()).toBe("2026-03-02T14:00:00.000Z");
    expect(nextRun("0 9 * * *", "UTC", from).toISOString()).toBe("2026-03-02T09:00:00.000Z");
  });

  it("rejects bad cron expressions and timezones", () => {
    expect(() => nextRun("not cron", "UTC")).toThrow(/Invalid cron/);
    expect(() => nextRun("0 9 * * *", "Mars/Olympus")).toThrow(/timezone/);
  });

  it("creates, updates and deletes routines owned by a channel", () => {
    const r = createRoutine({ ...base, kind: "schedule", name: "Digest", cron: "0 9 * * 1", prompt: "Summarize the week" });
    expect(r.timezone).toBe("UTC");
    expect(listRoutines("c")).toHaveLength(1);
    expect(() => updateRoutine("other", r.id, { enabled: false })).toThrow(/No routine/);
    const paused = updateRoutine("c", r.id, { enabled: false, cron: "30 8 * * *", timezone: "Asia/Tokyo" });
    expect(paused).toMatchObject({ enabled: false, cron: "30 8 * * *", timezone: "Asia/Tokyo" });
    expect(describeRoutine(paused)).toContain("paused");
    expect(() => updateRoutine("c", r.id, { cron: "bad" })).toThrow();
    expect(() => deleteRoutine("other", r.id)).toThrow();
    deleteRoutine("c", r.id);
    expect(listRoutines("c")).toHaveLength(0);
  });

  it("validates PR subscriptions", () => {
    expect(() => createRoutine({ ...base, kind: "pr", name: "x", repo: "not a repo", prNumber: 1, prompt: "p" })).toThrow(/owner\/name/);
    expect(() => createRoutine({ ...base, kind: "pr", name: "x", repo: "a/b", prNumber: 0, prompt: "p" })).toThrow(/pr_number/);
    const r = createRoutine({ ...base, kind: "pr", name: "a/b#3", repo: "a/b", prNumber: 3, prompt: "p" });
    expect(describeRoutine(r)).toContain("PR a/b#3");
  });
});

describe("PR change detection", () => {
  const snap: PrSnapshot = { state: "open", merged: false, headSha: "aaaaaaa1", ci: "pending", reviews: [] };

  it("reports nothing on the first poll", () => {
    expect(diffPr(undefined, snap)).toEqual([]);
  });

  it("reports CI results, new commits, reviews and merges", () => {
    expect(diffPr(snap, { ...snap, ci: "failure" })).toEqual(["CI failed."]);
    expect(diffPr({ ...snap, ci: "failure" }, { ...snap, ci: "pending", headSha: "bbbbbbb2" })).toEqual(["New commits were pushed (head bbbbbbb)."]);
    expect(diffPr(snap, { ...snap, reviews: ["bob:CHANGES_REQUESTED"] })).toEqual(["bob submitted a review: changes requested."]);
    expect(diffPr(snap, { ...snap, state: "closed", merged: true })).toEqual(["The pull request was merged."]);
    expect(diffPr(snap, { ...snap, state: "closed" })).toEqual(["The pull request was closed without merging."]);
    expect(diffPr(snap, snap)).toEqual([]);
  });

  it("summarizes check runs", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([{ status: "in_progress", conclusion: null }])).toBe("pending");
    expect(summarizeChecks([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }])).toBe("success");
    expect(summarizeChecks([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }])).toBe("failure");
  });
});
