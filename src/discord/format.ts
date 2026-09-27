/** Pure formatting helpers (no discord.js), so they can be unit-tested. */

export const DISCORD_LIMIT = 2000;

/**
 * Split text into Discord-sized messages, breaking at paragraph or line boundaries, and closing
 * and reopening a ``` fence that would otherwise straddle two messages.
 */
export function chunkMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  let openFence: string | null = null;
  while (rest.length) {
    const prefix = openFence ? `${openFence}\n` : "";
    const budget = max - prefix.length - 4; // room to close a fence
    if (prefix.length + rest.length <= max) {
      out.push(prefix + rest);
      break;
    }
    let cut = rest.lastIndexOf("\n\n", budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf("\n", budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    let piece = prefix + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\n+/, "").replace(/^ /, "");
    openFence = fenceStateAfter(piece);
    if (openFence) piece += "\n```";
    out.push(piece);
  }
  return out;
}

/** The opening fence (e.g. "```ts") still open at the end of `s`, or null. */
export function fenceStateAfter(s: string): string | null {
  let open: string | null = null;
  for (const line of s.split("\n")) {
    const m = line.match(/^\s*(```+)(.*)$/);
    if (!m) continue;
    open = open ? null : `\`\`\`${m[2]!.trim()}`;
  }
  return open;
}

export interface TodoLike {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function renderChecklist(todos: TodoLike[], stopped = false): string {
  const lines = todos.map((t) => {
    if (t.status === "completed") return `✅ ~~${t.content}~~`;
    if (t.status === "in_progress") return stopped ? `⏹️ ${t.content}` : `🔄 **${t.activeForm || t.content}**`;
    return `⬜ ${t.content}`;
  });
  const done = todos.filter((t) => t.status === "completed").length;
  const header = `**Checklist** · ${done}/${todos.length}${stopped ? " · stopped" : ""}`;
  const body = [header, ...lines].join("\n");
  return body.length > DISCORD_LIMIT ? `${body.slice(0, DISCORD_LIMIT - 1)}…` : body;
}

/** Webhook usernames are limited to 80 characters and can't contain "discord". */
export function personaName(title?: string | null): string {
  if (!title) return "Claude";
  const clean = title.replace(/discord/gi, "d1scord").replace(/\s+/g, " ").trim();
  const name = `Claude [${clean}]`;
  return name.length > 80 ? `${name.slice(0, 78)}…]` : name;
}

export function footer(model: string): string {
  return `-# ${model} · /claude configure`;
}

export const COMMANDS = ["help", "configure", "restart", "status", "mute", "unmute", "feedback", "routines", "fork"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** Remove user/role mentions of the bot so "<@123> !help" reads as "!help". */
export function stripBotMention(text: string, botId: string, botRoleIds: string[] = []): string {
  let s = text.replace(new RegExp(`<@!?${botId}>`, "g"), "");
  for (const r of botRoleIds) s = s.replace(new RegExp(`<@&${r}>`, "g"), "");
  return s.trim();
}

export function parseCommand(text: string): { name: CommandName; args: string } | null {
  const m = text.trim().match(/^!([a-z]+)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!(COMMANDS as readonly string[]).includes(name)) return null;
  return { name: name as CommandName, args: m[2]!.trim() };
}

/** "#general", "<#123>" or "123" → channel id or name. */
export function parseChannelRef(ref: string): { id?: string; name?: string } {
  const s = ref.trim();
  const mention = s.match(/^<#(\d+)>$/);
  if (mention) return { id: mention[1] };
  if (/^\d{15,22}$/.test(s)) return { id: s };
  return { name: s.replace(/^#/, "").toLowerCase() };
}

/** Split "!fork #chan do this" → { channel: "#chan", rest: "do this" }. */
export function splitLeadingChannel(args: string): { channel: string | null; rest: string } {
  const m = args.match(/^(<#\d+>|#[\w-]+)\s*([\s\S]*)$/);
  return m ? { channel: m[1]!, rest: m[2]!.trim() } : { channel: null, rest: args };
}

/** A short task title from free text, for when Claude didn't give one. */
export function titleFrom(text: string): string {
  const words = text.replace(/<[@#!&]?\d+>/g, "").replace(/[`*_>#~|]/g, "").split(/\s+/).filter(Boolean);
  const t = words.slice(0, 5).join(" ");
  return (t.length > 50 ? `${t.slice(0, 49)}…` : t) || "Task";
}

export function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
