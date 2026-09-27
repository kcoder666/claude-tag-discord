import { all, run } from "./db.js";

/**
 * Discord bots can't use Discord's message search, so the bot keeps its own full-text index of
 * the messages it sees. That stands in for Slack workspace search: keyword search across public
 * channels, without reading a channel's full history.
 */
export function indexMessage(m: {
  messageId: string; guildId: string; channelId: string; channelName: string;
  author: string; content: string; createdAt: number; isPublic: boolean;
}): void {
  if (!m.content.trim()) return;
  run(
    "INSERT INTO msg_index (content, author, channel_name, channel_id, guild_id, message_id, created_at, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    m.content.slice(0, 4000), m.author, m.channelName, m.channelId, m.guildId, m.messageId, m.createdAt, m.isPublic ? 1 : 0,
  );
}

export function updateIndexedMessage(messageId: string, content: string): void {
  run("UPDATE msg_index SET content = ? WHERE message_id = ?", content.slice(0, 4000), messageId);
}

export function removeIndexedMessage(messageId: string): void {
  run("DELETE FROM msg_index WHERE message_id = ?", messageId);
}

export interface SearchHit {
  message_id: string;
  channel_id: string;
  channel_name: string;
  author: string;
  content: string;
  created_at: number;
}

/** Turn free text into a safe FTS5 query: each word quoted, all required. */
export function toFtsQuery(q: string): string {
  const words = q.match(/[\p{L}\p{N}_#@.-]+/gu) ?? [];
  return words.slice(0, 12).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
}

export function searchMessages(opts: {
  guildId: string; query: string; allowedChannelIds?: Set<string>; currentChannelId?: string; limit?: number;
}): SearchHit[] {
  const fts = toFtsQuery(opts.query);
  if (!fts) return [];
  const hits = all<SearchHit & { is_public: number }>(
    `SELECT message_id, channel_id, channel_name, author, content, created_at, is_public
     FROM msg_index WHERE msg_index MATCH ? AND guild_id = ? ORDER BY rank LIMIT 200`,
    fts, opts.guildId,
  );
  return hits
    .filter((h) => h.channel_id === opts.currentChannelId || (h.is_public === 1 && (!opts.allowedChannelIds || opts.allowedChannelIds.has(h.channel_id))))
    .slice(0, opts.limit ?? 20);
}
