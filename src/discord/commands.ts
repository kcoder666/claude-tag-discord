import type { Message, TextBasedChannel, ThreadChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { config } from "../config.js";
import { logActivity, run } from "../core/db.js";
import { log } from "../core/log.js";
import { describeRoutine, listRoutines } from "../core/routines.js";
import type { SessionManager } from "../agent/manager.js";
import { fetchWindow, formatWindow } from "./context.js";
import { parseChannelRef, splitLeadingChannel, titleFrom, type CommandName } from "./format.js";
import { isPublicChannel, type Place } from "./place.js";
import type { Target } from "./poster.js";

export const HELP = `**Claude commands** — mention me, then:
\`!help\` this list · \`!configure\` settings for this channel
\`!status\` what I'm doing here (sent to you privately)
\`!restart\` archive this session and start fresh (top level: restarts the channel session)
\`!mute\` / \`!unmute\` stop replying in this thread unless mentioned (a 👎 on my reply also mutes)
\`!feedback <text>\` tell the operators something
\`!routines [#channel]\` list scheduled routines
\`!fork [#channel] <prompt>\` continue this thread's work in a new thread (public channels)
Slash commands: \`/claude\` (help, status, configure, routines, memory, model, account) · \`/claude-admin\` for admins.`;

async function reply(msg: Message, text: string): Promise<void> {
  await msg.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
}

/** A "private note": DM the person, falling back to a short-lived reply. */
async function privateNote(msg: Message, text: string): Promise<void> {
  if (msg.channel.type === ChannelType.DM) return reply(msg, text);
  try {
    await msg.author.send({ content: `${text}\n-# about ${msg.url}`, allowedMentions: { parse: [] } });
    await msg.react("📬").catch(() => {});
  } catch {
    const m = await msg.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
    setTimeout(() => void m.delete().catch(() => {}), 20_000).unref();
  }
}

export async function runCommand(
  name: CommandName, args: string, msg: Message, place: Place, manager: SessionManager,
): Promise<void> {
  const threadKey = place.kind === "thread" ? place.threadId! : place.kind === "dm" ? `dm:${msg.author.id}` : `channel:${place.channelId}`;
  switch (name) {
    case "help":
      return reply(msg, HELP);
    case "configure":
      return reply(msg, "Run `/claude configure` here to open this channel's settings (only you will see them).");
    case "status":
      return privateNote(msg, `**Status** — ${manager.status(threadKey)}`);
    case "restart":
      await manager.restart(threadKey);
      return reply(
        msg,
        place.kind === "channel"
          ? "🔄 Started a fresh channel session."
          : "🔄 Archived that session. My next reply here starts fresh and rereads the thread.",
      );
    case "mute":
    case "unmute": {
      if (place.kind !== "thread") {
        return reply(msg, "Muting works per thread. To keep me quiet at the top level, turn off *Respond automatically* in `/claude configure`.");
      }
      const ok = manager.setMuted(place.threadId!, name === "mute");
      if (!ok) return reply(msg, "I'm not active in this thread.");
      return reply(msg, name === "mute" ? "🔇 Muted. I'll only reply here when mentioned. `!unmute` to undo." : "🔊 Unmuted.");
    }
    case "feedback": {
      if (!args) return reply(msg, "Usage: `@Claude !feedback <what went well or badly>`");
      run(
        "INSERT INTO feedback (guild_id, channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        place.guildId, place.channelId, msg.author.id, args.slice(0, 4000), Date.now(),
      );
      if (config.feedbackChannelId) {
        const ch = await msg.client.channels.fetch(config.feedbackChannelId).catch(() => null);
        if (ch?.isTextBased() && "send" in ch) {
          await ch.send({ content: `📝 Feedback from <@${msg.author.id}> in ${msg.url}:\n>>> ${args.slice(0, 1800)}`, allowedMentions: { parse: [] } }).catch(() => {});
        }
      }
      await msg.react("✅").catch(() => {});
      return;
    }
    case "routines": {
      let channelId = place.channelId;
      const ref = args.trim();
      if (ref) {
        const { id, name: chName } = parseChannelRef(ref);
        const found = id ?? msg.guild?.channels.cache.find((c) => c.name.toLowerCase() === chName)?.id;
        if (!found) return reply(msg, `Can't find ${ref}.`);
        channelId = found;
      }
      const list = listRoutines(channelId);
      return reply(msg, list.length ? `**Routines in <#${channelId}>**\n${list.map(describeRoutine).join("\n")}` : `No routines in <#${channelId}>.`);
    }
    case "fork":
      return fork(args, msg, place, manager);
  }
}

async function fork(args: string, msg: Message, place: Place, manager: SessionManager): Promise<void> {
  if (place.kind !== "thread") return reply(msg, "Use `!fork` inside a thread to continue its work in a new thread.");
  if (!place.isPublic) return reply(msg, "`!fork` works in public channels only.");
  const { channel: ref, rest: prompt } = splitLeadingChannel(args);
  if (!prompt) return reply(msg, "Usage: `@Claude !fork [#channel] <what to do next>`");

  let target: TextBasedChannel | null = null;
  if (ref) {
    const { id, name } = parseChannelRef(ref);
    const found = id ? await msg.client.channels.fetch(id).catch(() => null) : msg.guild?.channels.cache.find((c) => c.name.toLowerCase() === name) ?? null;
    target = found && found.isTextBased() ? found : null;
  } else {
    const thread = msg.channel as ThreadChannel;
    target = thread.parent && thread.parent.isTextBased() ? thread.parent : null;
  }
  if (!target || target.isThread() || target.type === ChannelType.DM || !("guild" in target) || target.guild.id !== place.guildId) {
    return reply(msg, "Pick a text channel in this server.");
  }
  if (!isPublicChannel(target)) return reply(msg, "`!fork` can only continue into a public channel.");

  const source = msg.channel as ThreadChannel;
  const history = await fetchWindow(source, msg.client.user.id, 60);
  let background = formatWindow(history, msg.client.user.id);
  if (background.length > 20_000) background = `…${background.slice(-20_000)}`;

  const title = titleFrom(prompt);
  const announce = await (target as Target).send({
    content: `🍴 **Fork:** ${prompt.slice(0, 1500)}\n-# Forked from ${source.url} by <@${msg.author.id}>`,
    allowedMentions: { parse: [] },
  });
  try {
    const thread = await manager.startTask(
      announce, title,
      `${prompt}\n\nThis continues work from another thread (${source.url}). Its messages, as background:\n${background}`,
      msg.author.id,
    );
    await reply(msg, `🍴 Continuing in ${thread.url}`);
    logActivity(place.guildId, place.channelId, "fork", `${source.id} → ${thread.id}`);
  } catch (e) {
    log.error("fork failed", e);
    await reply(msg, `Couldn't fork: ${(e as Error).message}`);
  }
}
