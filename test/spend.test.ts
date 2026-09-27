import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import { channelScopeId, guildScopeId, resolveScope, writeScope } from "../src/core/scopes.js";
import { checkBudget, guildSpend, newlyCrossedThresholds, period, recordUsage, usageReport } from "../src/core/spend.js";

const G = "g1";
const C = "c1";

function use(cost: number, kind: "channel" | "dm" | "routine" = "channel", channelId = C) {
  recordUsage({ guildId: G, channelId, userId: "u", kind, work: "task", model: "m", costUsd: cost, metered: true });
}

beforeEach(() => {
  useMemoryDb();
});

describe("budgets", () => {
  it("allows everything with no limits", () => {
    use(1000);
    expect(checkBudget(resolveScope(G, C), C)).toEqual({ ok: true, remaining: undefined });
  });

  it("enforces the guild monthly limit and reports what's left", () => {
    writeScope(guildScopeId(G), G, { monthlyLimitUsd: 10 });
    use(4);
    expect(checkBudget(resolveScope(G, C), C)).toEqual({ ok: true, remaining: 6 });
    use(6);
    expect(checkBudget(resolveScope(G, C), C)).toEqual({ ok: false, blockedBy: "guild", remaining: 0 });
  });

  it("uses the tighter of the guild and channel limits", () => {
    writeScope(guildScopeId(G), G, { monthlyLimitUsd: 100, channelLimitUsd: 5 });
    use(3);
    expect(checkBudget(resolveScope(G, C), C).remaining).toBe(2);
    writeScope(channelScopeId(C), G, { channelLimitUsd: 50 });
    expect(checkBudget(resolveScope(G, C), C).remaining).toBe(47);
    use(2, "channel", "c2");
    expect(checkBudget(resolveScope(G, "c2"), "c2").remaining).toBe(3);
  });

  it("doesn't count DMs against channel budgets", () => {
    writeScope(guildScopeId(G), G, { monthlyLimitUsd: 1 });
    use(50, "dm");
    expect(guildSpend(G)).toBe(0);
    expect(checkBudget(resolveScope(G, C), C).ok).toBe(true);
  });

  it("ignores zero and negative costs", () => {
    use(0);
    use(-1);
    expect(guildSpend(G)).toBe(0);
  });
});

describe("threshold alerts", () => {
  it("fires 75% and 95% once each per period", () => {
    expect(newlyCrossedThresholds("s", 5, 10)).toEqual([]);
    expect(newlyCrossedThresholds("s", 7.5, 10)).toEqual([75]);
    expect(newlyCrossedThresholds("s", 8, 10)).toEqual([]);
    expect(newlyCrossedThresholds("s", 12, 10)).toEqual([95]);
    expect(newlyCrossedThresholds("s", 12, 10)).toEqual([]);
    expect(newlyCrossedThresholds("other", 12, 10)).toEqual([75, 95]);
    expect(newlyCrossedThresholds("x", 12, undefined)).toEqual([]);
  });
});

describe("report", () => {
  it("groups usage by channel, kind and work", () => {
    use(2);
    use(3, "routine", "c2");
    const r = usageReport(G);
    expect(r.total).toBe(5);
    expect(r.byChannel[0]).toEqual({ channel_id: "c2", spend: 3 });
    expect(r.byKind.map((k) => k.kind).sort()).toEqual(["channel", "routine"]);
  });

  it("formats the period as YYYY-MM in UTC", () => {
    expect(period(new Date(Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-01");
  });
});
