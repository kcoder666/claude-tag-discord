import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import { channelScopeId, resolveScope, setConnection, TRUSTED_DOMAINS, writeScope } from "../src/core/scopes.js";
import { allowedDomains, buildSandbox, hostAllowed, protectedPaths } from "../src/agent/sandbox.js";
import { config } from "../src/config.js";

beforeEach(() => {
  useMemoryDb();
});

describe("sandbox", () => {
  it("includes trusted registries unless the network level is none", () => {
    writeScope(channelScopeId("c"), "g", { domains: ["internal.example.com"] });
    expect(allowedDomains(resolveScope("g", "c"))).toEqual(expect.arrayContaining(["internal.example.com", ...TRUSTED_DOMAINS]));
    writeScope(channelScopeId("c"), "g", { domains: ["internal.example.com"], networkAccess: "none" });
    expect(allowedDomains(resolveScope("g", "c"))).toEqual(["internal.example.com"]);
  });

  it("matches wildcard entries", () => {
    writeScope(channelScopeId("c"), "g", { domains: ["*.corp.example"], networkAccess: "none" });
    const s = resolveScope("g", "c");
    expect(hostAllowed(s, "git.corp.example")).toBe(true);
    expect(hostAllowed(s, "corp.example")).toBe(true);
    expect(hostAllowed(s, "evilcorp.example")).toBe(false);
  });

  it("masks connection secrets for their hosts and hides the Claude credential", () => {
    setConnection(channelScopeId("c"), "gh", "GH_TOKEN", ["api.github.com"], "ghp_x", "u");
    const sb = buildSandbox(resolveScope("g", "c"), "/work/t1");
    expect(sb.enabled).toBe(true);
    expect(sb.allowUnsandboxedCommands).toBe(false);
    expect(sb.filesystem?.allowWrite).toEqual(["/work/t1"]);
    expect(sb.network?.strictAllowlist).toBe(true);
    expect(sb.network?.allowedDomains).toContain("api.github.com");
    expect(sb.credentials?.envVars).toEqual(expect.arrayContaining([
      { name: "GH_TOKEN", mode: "mask", injectHosts: ["api.github.com"] },
      { name: "ANTHROPIC_API_KEY", mode: "deny" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
    ]));
    expect(JSON.stringify(sb)).not.toContain("ghp_x");
  });

  it("hides the bot's data, install dir and credential stores from commands, except this workspace", () => {
    const sb = buildSandbox(resolveScope("g", "c"), "/data/workspaces/t1");
    expect(sb.filesystem?.denyRead).toEqual(expect.arrayContaining([config.dataDir, process.cwd()]));
    expect(sb.filesystem?.allowRead).toEqual(["/data/workspaces/t1"]);
    expect(protectedPaths("/home/bot", "/app")).toEqual(expect.arrayContaining(["/app", "/home/bot/.ssh", "/home/bot/.claude"]));
  });

  it("drops the strict allowlist under full network access", () => {
    writeScope(channelScopeId("c"), "g", { networkAccess: "full" });
    expect(buildSandbox(resolveScope("g", "c"), "/w").network?.strictAllowlist).toBe(false);
  });
});
