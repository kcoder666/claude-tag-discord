import { describe, expect, it } from "vitest";
import {
  chunkMessage, fenceStateAfter, footer, parseChannelRef, parseCommand, personaName, relTime, renderChecklist,
  splitLeadingChannel, stripBotMention, titleFrom,
} from "../src/discord/format.js";

describe("chunkMessage", () => {
  it("returns short text as one chunk", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("keeps every chunk under the limit and loses no words", () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(" "));
  });

  it("prefers paragraph breaks", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    expect(chunkMessage(text, 400)).toEqual(["a".repeat(300), "b".repeat(300)]);
  });

  it("closes and reopens a code fence split across messages", () => {
    const code = Array.from({ length: 80 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const chunks = chunkMessage(`Here:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(600);
      expect(fenceStateAfter(c)).toBeNull();
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
  });

  it("hard-splits a single huge word", () => {
    const chunks = chunkMessage("x".repeat(1000), 300);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.join("")).toBe("x".repeat(1000));
  });
});

describe("renderChecklist", () => {
  const todos = [
    { content: "Read the code", status: "completed" as const },
    { content: "Fix the bug", status: "in_progress" as const, activeForm: "Fixing the bug" },
    { content: "Open a PR", status: "pending" as const },
  ];
  it("renders progress with ✅ 🔄 ⬜", () => {
    expect(renderChecklist(todos)).toBe("**Checklist** · 1/3\n✅ ~~Read the code~~\n🔄 **Fixing the bug**\n⬜ Open a PR");
  });
  it("marks a stopped checklist", () => {
    expect(renderChecklist(todos, true)).toContain("⏹️ Fix the bug");
    expect(renderChecklist(todos, true)).toContain("stopped");
  });
});

describe("commands", () => {
  it("parses known ! commands after the mention is stripped", () => {
    expect(parseCommand(stripBotMention("<@123> !help", "123"))).toEqual({ name: "help", args: "" });
    expect(parseCommand(stripBotMention("<@!123> !fork #eng try again", "123"))).toEqual({ name: "fork", args: "#eng try again" });
    expect(parseCommand(stripBotMention("<@&999> !STATUS", "123", ["999"]))).toEqual({ name: "status", args: "" });
    expect(parseCommand("!feedback it was\ngreat")).toEqual({ name: "feedback", args: "it was\ngreat" });
  });
  it("ignores unknown commands and normal text", () => {
    expect(parseCommand("!deploy now")).toBeNull();
    expect(parseCommand("please !help me")).toBeNull();
    expect(parseCommand("!helpme")).toBeNull();
  });
  it("splits a leading channel", () => {
    expect(splitLeadingChannel("<#42> do it")).toEqual({ channel: "<#42>", rest: "do it" });
    expect(splitLeadingChannel("#eng-team do it")).toEqual({ channel: "#eng-team", rest: "do it" });
    expect(splitLeadingChannel("do it")).toEqual({ channel: null, rest: "do it" });
  });
  it("parses channel references", () => {
    expect(parseChannelRef("<#123456789012345678>")).toEqual({ id: "123456789012345678" });
    expect(parseChannelRef("123456789012345678")).toEqual({ id: "123456789012345678" });
    expect(parseChannelRef("#General")).toEqual({ name: "general" });
  });
});

describe("persona and footer", () => {
  it("names working sessions after their task, within Discord's limits", () => {
    expect(personaName()).toBe("Claude");
    expect(personaName("Fix login")).toBe("Claude [Fix login]");
    expect(personaName("x".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(personaName("discord bot")).not.toMatch(/discord/i);
  });
  it("footers name the model and configure command", () => {
    expect(footer("claude-opus-5")).toBe("-# claude-opus-5 · /claude configure");
  });
  it("makes short titles", () => {
    expect(titleFrom("<@1> can you **fix** the flaky login test please thanks")).toBe("can you fix the flaky");
    expect(titleFrom("")).toBe("Task");
  });
  it("formats durations", () => {
    expect(relTime(5_000)).toBe("5s");
    expect(relTime(6 * 60_000)).toBe("6m");
    expect(relTime(125 * 60_000)).toBe("2h 5m");
  });
});
