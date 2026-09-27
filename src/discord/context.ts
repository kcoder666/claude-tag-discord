import fs from "node:fs/promises";
import path from "node:path";
import type { Collection, Message, TextBasedChannel, ThreadChannel } from "discord.js";
import type { UserContent } from "../agent/session.js";
import { formatDiscordMessage } from "../agent/prompts.js";
import { log } from "../core/log.js";

export type ContentBlockParam = Exclude<UserContent, string>[number];

/** Claude Tag's attachment limits. */
export const ATTACHMENT_LIMITS = {
  perMessage: 5,
  imageBytes: 3.75 * 1024 * 1024,
  pdfBytes: 5 * 1024 * 1024,
  otherBytes: 100 * 1024 * 1024,
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type AttachmentPlan =
  | { kind: "image"; mediaType: string }
  | { kind: "pdf" }
  | { kind: "file" }
  | { kind: "skip"; reason: string };

/** How one attachment reaches Claude: inline image, inline PDF, a file in the workspace, or skipped. */
export function planAttachment(a: { name: string; size: number; contentType: string | null }, index: number): AttachmentPlan {
  if (index >= ATTACHMENT_LIMITS.perMessage) return { kind: "skip", reason: `only the first ${ATTACHMENT_LIMITS.perMessage} attachments are read` };
  const type = (a.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) {
    return a.size <= ATTACHMENT_LIMITS.imageBytes ? { kind: "image", mediaType: type } : { kind: "skip", reason: "image over 3.75MB" };
  }
  if (type === "application/pdf" || a.name.toLowerCase().endsWith(".pdf")) {
    return a.size <= ATTACHMENT_LIMITS.pdfBytes ? { kind: "pdf" } : { kind: "skip", reason: "PDF over 5MB" };
  }
  return a.size <= ATTACHMENT_LIMITS.otherBytes ? { kind: "file" } : { kind: "skip", reason: "file over 100MB" };
}

export function authorName(m: Message): string {
  return m.member?.displayName ?? m.author.globalName ?? m.author.username;
}

export function isOwnMessage(m: Message, botId: string): boolean {
  return m.author.id === botId || (!!m.webhookId && m.author.username.startsWith("Claude"));
}

/** Text Claude sees for a message, with attachment names. */
export function describeMessage(m: Message, botId: string, opts: { mentioned?: boolean } = {}): string {
  const own = isOwnMessage(m, botId);
  return formatDiscordMessage({
    id: m.id,
    author: own ? "Claude (you)" : authorName(m),
    authorId: own ? botId : m.author.id,
    content: m.content || (m.embeds[0]?.description ?? ""),
    createdAt: m.createdAt,
    mentioned: opts.mentioned,
    isBot: m.author.bot && !own,
    attachments: [...m.attachments.values()].map((a) => a.name),
    replyTo: m.reference?.messageId ?? null,
  });
}

/**
 * Build the user content for a message: the formatted text plus attachments. Images and PDFs go
 * inline; other files are saved into the workspace (`attachments/`) and referenced by path.
 */
export async function messageContent(
  m: Message, botId: string, opts: { mentioned?: boolean; cwd?: string; preamble?: string } = {},
): Promise<ContentBlockParam[]> {
  const blocks: ContentBlockParam[] = [];
  const notes: string[] = [];
  let i = 0;
  for (const a of m.attachments.values()) {
    const plan = planAttachment({ name: a.name, size: a.size, contentType: a.contentType }, i++);
    if (plan.kind === "skip") {
      notes.push(`${a.name}: skipped (${plan.reason})`);
      continue;
    }
    if (plan.kind === "file" && !opts.cwd) {
      notes.push(`${a.name}: not available here (${a.url})`);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (plan.kind === "image") {
        blocks.push({ type: "image", source: { type: "base64", media_type: plan.mediaType as "image/png", data: buf.toString("base64") } });
      } else if (plan.kind === "pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: a.name });
      } else {
        const dir = path.join(opts.cwd!, "attachments");
        await fs.mkdir(dir, { recursive: true });
        const safe = `${m.id}-${a.name.replace(/[^\w.-]+/g, "_")}`;
        await fs.writeFile(path.join(dir, safe), buf);
        notes.push(`${a.name}: saved to ${path.join("attachments", safe)}`);
      }
    } catch (e) {
      log.warn(`attachment ${a.name} failed`, e);
      notes.push(`${a.name}: could not be downloaded`);
    }
  }
  const text = [opts.preamble, describeMessage(m, botId, opts), notes.length ? `Attachment notes:\n- ${notes.join("\n- ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return [{ type: "text", text }, ...blocks];
}

/**
 * Earlier messages of a thread (or channel), oldest first, as context. Other bots' messages are
 * dropped; Claude's own are kept.
 */
export async function fetchWindow(
  channel: TextBasedChannel | ThreadChannel, botId: string, limit: number, beforeId?: string,
): Promise<Message[]> {
  const out: Message[] = [];
  let before = beforeId;
  while (out.length < limit) {
    const batch: Collection<string, Message> = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), before });
    if (!batch.size) break;
    for (const m of batch.values()) {
      if (m.author.bot && !isOwnMessage(m, botId)) continue;
      if (m.system && !m.content) continue;
      out.push(m);
    }
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return out.reverse();
}

export function formatWindow(msgs: Message[], botId: string): string {
  return msgs.map((m) => describeMessage(m, botId)).join("\n");
}
