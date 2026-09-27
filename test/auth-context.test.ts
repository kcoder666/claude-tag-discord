import { afterEach, describe, expect, it, vi } from "vitest";
import { botCredential, buildSessionEnv } from "../src/core/auth.js";
import { planAttachment } from "../src/discord/context.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("credentials", () => {
  it("prefers an API key, then a subscription token, then local login", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat");
    expect(botCredential().kind).toBe("api-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(botCredential().kind).toBe("subscription");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    expect(botCredential().kind).toBe("local-login");
  });

  it("honours AUTH_MODE and fails loudly when the credential is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat");
    vi.stubEnv("AUTH_MODE", "subscription");
    expect(botCredential()).toMatchObject({ kind: "subscription", value: "sk-ant-oat" });
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    expect(() => botCredential()).toThrow(/setup-token/);
  });

  it("never passes host secrets to Claude Code", () => {
    vi.stubEnv("DISCORD_TOKEN", "discord-secret");
    vi.stubEnv("GITHUB_TOKEN", "gh-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    const env = buildSessionEnv({ kind: "subscription", value: "sk-ant-oat", owner: "bot" }, { EXTRA: "1" });
    expect(env.DISCORD_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SECRET_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat");
    expect(env.EXTRA).toBe("1");
  });
});

describe("attachments", () => {
  const MB = 1024 * 1024;
  it("applies Claude Tag's limits", () => {
    expect(planAttachment({ name: "a.png", size: 3 * MB, contentType: "image/png" }, 0)).toEqual({ kind: "image", mediaType: "image/png" });
    expect(planAttachment({ name: "a.png", size: 4 * MB, contentType: "image/png" }, 0).kind).toBe("skip");
    expect(planAttachment({ name: "a.pdf", size: 4 * MB, contentType: "application/pdf" }, 0)).toEqual({ kind: "pdf" });
    expect(planAttachment({ name: "a.pdf", size: 6 * MB, contentType: null }, 0).kind).toBe("skip");
    expect(planAttachment({ name: "a.csv", size: 50 * MB, contentType: "text/csv" }, 0)).toEqual({ kind: "file" });
    expect(planAttachment({ name: "a.bin", size: 101 * MB, contentType: null }, 0).kind).toBe("skip");
    expect(planAttachment({ name: "f.txt", size: 1, contentType: "text/plain" }, 5).kind).toBe("skip");
  });
});
