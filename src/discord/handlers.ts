import {
  ChannelType, Events,
  type Client, type Message, type MessageReaction, type PartialMessage, type PartialMessageReaction,
  type PartialUser, type User,
} from "discord.js";
import { log } from "../core/log.js";
import { indexMessage, removeIndexedMessage, updateIndexedMessage } from "../core/search.js";
import type { SessionManager } from "../agent/manager.js";
import { checkAccess } from "./access.js";
import { runCommand } from "./commands.js";
import { authorName, isOwnMessage } from "./context.js";
import { parseCommand, stripBotMention } from "./format.js";
import { placeOfMessage, scopeFor } from "./place.js";
import { handleInteraction } from "./slash.js";

function mentionsBot(msg: Message, botId: string): boolean {
  if (msg.mentions.users.has(botId)) return true;
  // Mentioning the bot's managed role (what Discord often autocompletes to) counts too.
  return msg.mentions.roles.some((r) => r.tags?.botId === botId);
}

function botRoleIds(msg: Message, botId: string): string[] {
  return [...msg.mentions.roles.filter((r) => r.tags?.botId === botId).keys()];
}

function sessionKeyOf(msg: Message | PartialMessage): string | null {
  const ch = msg.channel;
  if (ch.type === ChannelType.DM) return msg.author ? `dm:${msg.author.id}` : null;
  if (ch.isThread()) return ch.id;
  return `channel:${ch.id}`;
}

export function registerHandlers(client: Client, manager: SessionManager): void {
  client.on(Events.MessageCreate, (msg) => void onMessage(msg, client, manager));
  client.on(Events.MessageUpdate, (before, after) => void onEdit(before, after, client, manager));
  client.on(Events.MessageDelete, (msg) => void onDelete(msg, manager));
  client.on(Events.ThreadDelete, (thread) => manager.closeThread(thread.id, "thread deleted"));
  client.on(Events.MessageReactionAdd, (r, u) => void onReaction(r, u, manager));
  client.on(Events.InteractionCreate, (i) => void handleInteraction(i, manager));
}

async function onMessage(msg: Message, client: Client, manager: SessionManager): Promise<void> {
  const botId = client.user!.id;
  if (isOwnMessage(msg, botId)) return;
  if (msg.partial) msg = await msg.fetch();
  const place = placeOfMessage(msg);
  if (!place) return;

  if (place.guildId && !msg.author.bot && msg.content) {
    try {
      indexMessage({
        messageId: msg.id, guildId: place.guildId, channelId: msg.channelId, channelName: place.channelName,
        author: authorName(msg), content: msg.content, createdAt: msg.createdTimestamp, isPublic: place.isPublic,
      });
    } catch (e) {
      log.warn("index failed", e);
    }
  }
  // Other bots' messages are context only.
  if (msg.author.bot || msg.system) return;

  const mentioned = place.kind === "dm" || mentionsBot(msg, botId);
  const scope = scopeFor(place);
  const access = checkAccess(place, scope, msg.member);
  if (!access.ok) {
    if (mentioned && !access.silent) await msg.reply({ content: access.reason, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    return;
  }

  try {
    if (mentioned) {
      const cmd = parseCommand(stripBotMention(msg.content, botId, botRoleIds(msg, botId)));
      if (cmd) return await runCommand(cmd.name, cmd.args, msg, place, manager);
    }
    if (place.kind === "dm") return await manager.handleDm(msg, place);
    if (place.kind === "thread") return await manager.handleThreadMessage(msg, place, mentioned);
    return await manager.handleTopLevel(msg, place, mentioned);
  } catch (e) {
    log.error(`handling ${msg.id} failed`, e);
    if (mentioned) await msg.reply({ content: `⚠️ ${(e as Error).message}`, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  }
}

async function onEdit(
  before: Message | PartialMessage, after: Message | PartialMessage, client: Client, manager: SessionManager,
): Promise<void> {
  try {
    if (after.partial) after = await after.fetch();
    if (after.author.bot || isOwnMessage(after, client.user!.id)) return;
    if (before.content === after.content) return;
    updateIndexedMessage(after.id, after.content);
    const key = sessionKeyOf(after);
    if (key) manager.noteEdit(key, authorName(after), after.id, before.content ?? "", after.content);
  } catch (e) {
    log.warn("edit handling failed", e);
  }
}

async function onDelete(msg: Message | PartialMessage, manager: SessionManager): Promise<void> {
  removeIndexedMessage(msg.id);
  // A thread started from a message shares that message's id: deleting it closes the session.
  if (manager.hasJoined(msg.id)) manager.closeThread(msg.id, "starter message deleted");
}

async function onReaction(
  reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, manager: SessionManager,
): Promise<void> {
  try {
    if (user.bot) return;
    if (reaction.partial) reaction = await reaction.fetch();
    if (reaction.emoji.name !== "👎") return;
    const msg = reaction.message;
    const own = manager.isBotMessage(msg.id);
    if (!own) return;
    const ch = msg.channel;
    if (ch.isThread() && manager.hasJoined(ch.id)) {
      manager.setMuted(ch.id, true);
      await ch.send({ content: `🔇 Muted by <@${user.id}>. I'll only reply here when mentioned; \`@Claude !unmute\` to undo.`, allowedMentions: { parse: [] } });
    } else if (own.sessionKey) {
      await manager.stop(own.sessionKey);
    }
  } catch (e) {
    log.warn("reaction handling failed", e);
  }
}
