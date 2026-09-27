import os from "node:os";
import path from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { CREDENTIAL_ENV_VARS } from "../core/auth.js";
import { TRUSTED_DOMAINS, type ResolvedScope } from "../core/scopes.js";

/** Hosts Claude's commands may reach: scope domains, connection hosts, and the trusted baseline. */
export function allowedDomains(scope: ResolvedScope): string[] {
  const hosts = new Set<string>(scope.domains);
  for (const c of scope.connections) for (const h of c.hosts) hosts.add(h);
  if (scope.networkAccess !== "none") for (const h of TRUSTED_DOMAINS) hosts.add(h);
  return [...hosts].sort();
}

/** Whether a host is reachable under the scope (exact match, or a `*.example.com` entry). */
export function hostAllowed(scope: ResolvedScope, host: string): boolean {
  if (scope.networkAccess === "full") return true;
  const h = host.toLowerCase();
  return allowedDomains(scope).some((d) => {
    const x = d.toLowerCase();
    return x.startsWith("*.") ? h === x.slice(2) || h.endsWith(x.slice(1)) : h === x;
  });
}

/**
 * Host paths commands must never read: the bot's own data (database, other sessions' workspaces,
 * hosted pages), its install directory (.env), and common credential stores. The session's own
 * workspace is re-allowed on top of this.
 */
export function protectedPaths(home = os.homedir(), botDir = process.cwd()): string[] {
  const dot = [".ssh", ".aws", ".azure", ".config/gcloud", ".config/gh", ".claude", ".claude.json", ".netrc", ".npmrc",
    ".pypirc", ".docker", ".kube", ".gnupg", ".git-credentials"];
  return [...new Set([config.dataDir, botDir, ...dot.map((d) => path.join(home, d))])];
}

/**
 * The Agent Proxy equivalent. Commands Claude runs are confined to the workspace, reach only
 * allowed hosts, and never see a credential: each connection's secret is masked, and the proxy
 * swaps in the real value only on the way out to that connection's hosts. The Claude credential
 * is hidden from commands entirely.
 *
 * On macOS and Windows the SDK degrades `mask` to `deny` (the command sees nothing), so run the
 * bot on Linux or in Docker to get injection.
 */
export function buildSandbox(scope: ResolvedScope, cwd: string): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: allowedDomains(scope),
      // Under "full" an unlisted host is a permission request, which our policy allows.
      strictAllowlist: scope.networkAccess !== "full",
    },
    filesystem: { allowWrite: [cwd], denyRead: protectedPaths(), allowRead: [cwd] },
    credentials: {
      envVars: [
        ...scope.connections.map((c) => ({ name: c.envVar, mode: "mask" as const, injectHosts: c.hosts })),
        ...CREDENTIAL_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
      ],
    },
  };
}
