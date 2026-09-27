import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import {
  channelScopeId, connectionValue, guildScopeId, isBlockedChannel, listConnections, matchesPattern, patchScope,
  readScope, resolveScope, scopeConfigSchema, setConnection, writeScope,
} from "../src/core/scopes.js";

const G = "100";
const C = "200";

beforeEach(() => {
  useMemoryDb();
});

describe("resolveScope", () => {
  it("uses defaults when nothing is configured", () => {
    const s = resolveScope(G, C);
    expect(s.enabled).toBe(true);
    expect(s.respondAutomatically).toBe(true);
    expect(s.model).toBe("claude-opus-5");
    expect(s.networkAccess).toBe("trusted");
    expect(s.guestMode).toBe("restrict");
    expect(s.instructions).toEqual([]);
    expect(s.channelOnly).toBe(false);
  });

  it("stacks instructions and allow rules guild → channel, and unions domains", () => {
    writeScope(guildScopeId(G), G, { instructions: "Be terse.", allowRules: ["open draft PRs"], domains: ["a.com", "b.com"] });
    writeScope(channelScopeId(C), G, { instructions: "Use British spelling.", allowRules: ["run tests"], domains: ["b.com", "c.com"] });
    const s = resolveScope(G, C);
    expect(s.instructions).toEqual(["Be terse.", "Use British spelling."]);
    expect(s.allowRules).toEqual(["open draft PRs", "run tests"]);
    expect(s.domains).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("lets the channel override the guild's model and switches", () => {
    writeScope(guildScopeId(G), G, { model: "claude-sonnet-5", enabled: true, memberEdits: "block" });
    writeScope(channelScopeId(C), G, { model: "claude-haiku-4-5", enabled: false });
    const s = resolveScope(G, C);
    expect(s.model).toBe("claude-haiku-4-5");
    expect(s.enabled).toBe(false);
    expect(s.memberEdits).toBe("block");
  });

  it("merges MCP servers by name, channel winning", () => {
    writeScope(guildScopeId(G), G, { mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    writeScope(channelScopeId(C), G, { mcpServers: { b: { type: "http", url: "https://mcp.example.com" } } });
    const s = resolveScope(G, C);
    expect(Object.keys(s.mcpServers).sort()).toEqual(["a", "b"]);
    expect(s.mcpServers.b).toEqual({ type: "http", url: "https://mcp.example.com" });
  });

  it("strips everything inherited from the guild under channel-only guest access", () => {
    writeScope(guildScopeId(G), G, {
      instructions: "Guild secret sauce", guestMode: "channel_only", plugins: ["/p"], domains: ["internal.corp"],
      environment: { setupScript: "echo hi", env: { A: "1" } }, networkAccess: "full", repositories: ["org/private"],
    });
    writeScope(channelScopeId(C), G, { instructions: "Channel rules" });
    setConnection(guildScopeId(G), "gh", "GH_TOKEN", ["api.github.com"], "guild-secret", "u");
    setConnection(channelScopeId(C), "linear", "LINEAR_KEY", ["api.linear.app"], "chan-secret", "u");

    const full = resolveScope(G, C, false);
    expect(full.channelOnly).toBe(false);
    expect(full.instructions).toHaveLength(2);
    expect(full.connections.map((c) => c.name).sort()).toEqual(["gh", "linear"]);

    const guarded = resolveScope(G, C, true);
    expect(guarded.channelOnly).toBe(true);
    expect(guarded.instructions).toEqual(["Channel rules"]);
    expect(guarded.plugins).toEqual([]);
    expect(guarded.setupScripts).toEqual([]);
    expect(guarded.env).toEqual({});
    expect(guarded.domains).toEqual([]);
    expect(guarded.repositories).toEqual([]);
    expect(guarded.networkAccess).toBe("trusted");
    expect(guarded.connections.map((c) => c.name)).toEqual(["linear"]);
  });

  it("does not strip anything when guests are present but mode is full", () => {
    writeScope(guildScopeId(G), G, { instructions: "Guild", guestMode: "full" });
    expect(resolveScope(G, C, true).instructions).toEqual(["Guild"]);
  });
});

describe("scope storage", () => {
  it("rejects unknown keys (strict schema)", () => {
    expect(scopeConfigSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(() => writeScope(guildScopeId(G), G, { nope: 1 } as never)).toThrow();
  });

  it("patchScope merges and drops undefined keys", () => {
    patchScope(channelScopeId(C), G, { model: "claude-sonnet-5", instructions: "x" });
    patchScope(channelScopeId(C), G, { instructions: undefined, respondAutomatically: false });
    expect(readScope(channelScopeId(C))).toEqual({ model: "claude-sonnet-5", respondAutomatically: false });
  });
});

describe("connections", () => {
  it("stores secrets encrypted and lets a channel connection replace the guild's by name", () => {
    setConnection(guildScopeId(G), "gh", "GH_TOKEN", ["api.github.com"], "guild-value", "u");
    setConnection(channelScopeId(C), "gh", "GH_TOKEN", ["api.github.com"], "channel-value", "u");
    const s = resolveScope(G, C);
    expect(s.connections).toHaveLength(1);
    expect(connectionValue(s.connections[0]!)).toBe("channel-value");
    expect(listConnections(guildScopeId(G))[0]).not.toHaveProperty("value");
  });
});

describe("channel name patterns", () => {
  it("matches * and ? case-insensitively and anchors the whole name", () => {
    expect(matchesPattern("hr-private", "hr-*")).toBe(true);
    expect(matchesPattern("HR-Private", "hr-*")).toBe(true);
    expect(matchesPattern("ops-hr-private", "hr-*")).toBe(false);
    expect(matchesPattern("team1", "team?")).toBe(true);
    expect(matchesPattern("team12", "team?")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true);
    expect(matchesPattern("axb", "a.b")).toBe(false);
  });

  it("blocks channels matching a guild pattern", () => {
    writeScope(guildScopeId(G), G, { blockedChannelPatterns: ["legal-*", "*-secret"] });
    const s = resolveScope(G, C);
    expect(isBlockedChannel(s, "legal-contracts")).toBe(true);
    expect(isBlockedChannel(s, "eng-secret")).toBe(true);
    expect(isBlockedChannel(s, "general")).toBe(false);
  });
});
