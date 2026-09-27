import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type ActionRowBuilder,
  type ButtonBuilder,
  type Client,
  type DMChannel,
  type Message,
  type MessageActionRowComponentBuilder,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
  type Webhook,
  type ForumChannel,
  type MediaChannel,
} from "discord.js";
import { run } from "../core/db.js";
import { log } from "../core/log.js";
import { chunkMessage, footer as footerLine, personaName } from "./format.js";

export type Target = TextChannel | NewsChannel | ThreadChannel | DMChannel;

type Row = ActionRowBuilder<MessageActionRowComponentBuilder> | ActionRowBuilder<ButtonBuilder>;

export interface PostOptions {
  text?: string;
  /** Task title for the "Claude [title]" persona; null/undefined posts as plain "Claude". */
  title?: string | null;
  model?: string;
  files?: AttachmentBuilder[];
  components?: Row[];
  sessionKey?: string | null;
  /** Suppress @-mention pings in the message. */
  quiet?: boolean;
}

/** Messages longer than this are attached as a Markdown file instead of split into many messages. */
const ATTACH_OVER = 8000;

/**
 * Sends everything Claude says. Where possible it posts through a channel webhook so each working
 * session appears under its own name ("Claude [Fix login bug]"). Messages with buttons go through
 * the bot itself, because only the bot's messages can carry interactive components reliably.
 */
export class Poster {
  private hooks = new Map<string, Webhook | null>();

  constructor(private readonly client: Client) {}

  private async webhookFor(target: Target): Promise<{ hook: Webhook; threadId?: string } | null> {
    if (target.type === ChannelType.DM) return null;
    const parent = target.isThread() ? target.parent : target;
    if (!parent || !("fetchWebhooks" in parent)) return null;
    const cached = this.hooks.get(parent.id);
    if (cached === null) return null;
    let hook = cached;
    if (!hook) {
      try {
        const me = parent.guild.members.me;
        if (!me || !parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
          this.hooks.set(parent.id, null);
          return null;
        }
        const p = parent as TextChannel | NewsChannel | ForumChannel | MediaChannel;
        const existing = await p.fetchWebhooks();
        hook = existing.find((w) => w.owner?.id === this.client.user?.id && w.name === "claude-tag-discord")
          ?? (await p.createWebhook({ name: "claude-tag-discord", avatar: this.client.user?.displayAvatarURL() }));
        this.hooks.set(parent.id, hook);
      } catch (e) {
        log.warn(`webhooks unavailable in #${parent.name}; posting as the bot`, e);
        this.hooks.set(parent.id, null);
        return null;
      }
    }
    return { hook, threadId: target.isThread() ? target.id : undefined };
  }

  /** Post text (chunked), files and buttons. Returns every message sent. */
  async post(target: Target, o: PostOptions): Promise<Message[]> {
    let text = (o.text ?? "").trim();
    const files = [...(o.files ?? [])];
    if (text.length > ATTACH_OVER) {
      files.push(new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "response.md" }));
      text = `${text.slice(0, 1500).trimEnd()}\n\n… *(full response attached as response.md)*`;
    }
    const chunks = text ? chunkMessage(text) : [];
    if (o.model) {
      const f = footerLine(o.model);
      if (chunks.length && chunks[chunks.length - 1]!.length + f.length + 1 <= 2000) chunks[chunks.length - 1] += `\n${f}`;
      else chunks.push(f);
    }
    if (!chunks.length && !files.length) return [];
    if (!chunks.length) chunks.push("");

    const allowedMentions = o.quiet ? { parse: [] as never[] } : { parse: ["users" as const], repliedUser: false };
    const sent: Message[] = [];
    const wh = o.components?.length ? null : await this.webhookFor(target);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const payload = {
        content: chunks[i] || undefined,
        files: last ? files : [],
        components: last ? o.components ?? [] : [],
        allowedMentions,
      };
      let m: Message;
      if (wh) {
        try {
          m = await wh.hook.send({
            ...payload,
            threadId: wh.threadId,
            username: personaName(o.title),
            avatarURL: this.client.user?.displayAvatarURL(),
          });
        } catch (e) {
          log.warn("webhook send failed; falling back to the bot", e);
          const parentId = target.isThread() ? target.parentId : target.id;
          if (parentId) this.hooks.delete(parentId);
          m = await target.send(payload);
        }
      } else {
        m = await target.send(payload);
      }
      sent.push(m);
      recordBotMessage(m, o.sessionKey ?? null);
    }
    return sent;
  }
}

export function recordBotMessage(m: Message, sessionKey: string | null): void {
  run(
    "INSERT OR IGNORE INTO bot_messages (message_id, channel_id, session_key, created_at) VALUES (?, ?, ?, ?)",
    m.id, m.channelId, sessionKey, Date.now(),
  );
}
