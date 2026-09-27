import { all, get, run } from "./db.js";

/**
 * Memory follows places, not people. Each channel keeps its own notes. From a public channel
 * Claude can also save workspace (guild-wide) notes, which it reads in every channel. A private
 * channel reads workspace notes but saves only to its own. A DM keeps its own notes.
 */
export type MemoryScope = "channel" | "workspace" | "dm";

export interface MemoryEntry {
  id: number;
  scope: MemoryScope;
  scopeId: string;
  content: string;
  createdBy: string | null;
  updatedAt: number;
}

export interface MemoryPlace {
  guildId: string | null;
  /** Channel id (the parent channel for a thread) or the DM user's id. */
  placeId: string;
  kind: "public" | "private" | "dm";
  /** Channel-only guest access: no memory at all. */
  noMemory?: boolean;
}

const MAX_ENTRY = 1500;

function rows(where: string, ...params: unknown[]): MemoryEntry[] {
  return all<{
    id: number; scope: MemoryScope; scope_id: string; content: string; created_by: string | null; updated_at: number;
  }>(`SELECT id, scope, scope_id, content, created_by, updated_at FROM memory WHERE ${where} ORDER BY id`, ...params)
    .map((r) => ({
      id: r.id, scope: r.scope, scopeId: r.scope_id, content: r.content, createdBy: r.created_by, updatedAt: r.updated_at,
    }));
}

/** Everything readable from a place: its own notes plus the workspace notes. */
export function readableMemory(place: MemoryPlace): MemoryEntry[] {
  if (place.noMemory) return [];
  if (place.kind === "dm") return rows("scope = 'dm' AND scope_id = ?", place.placeId);
  const own = rows("scope = 'channel' AND scope_id = ?", place.placeId);
  const ws = place.guildId ? rows("scope = 'workspace' AND scope_id = ?", place.guildId) : [];
  return [...ws, ...own];
}

export function canWriteWorkspace(place: MemoryPlace): boolean {
  return place.kind === "public" && !!place.guildId && !place.noMemory;
}

export function saveMemory(place: MemoryPlace, target: "channel" | "workspace", content: string, by: string | null): MemoryEntry {
  if (place.noMemory) throw new Error("Memory is off in this channel while guests are present.");
  const text = content.trim().slice(0, MAX_ENTRY);
  if (!text) throw new Error("Nothing to remember.");
  let scope: MemoryScope;
  let scopeId: string;
  if (place.kind === "dm") {
    scope = "dm";
    scopeId = place.placeId;
  } else if (target === "workspace") {
    if (!canWriteWorkspace(place)) throw new Error("Workspace notes can only be saved from a public channel. Saved nothing.");
    scope = "workspace";
    scopeId = place.guildId!;
  } else {
    scope = "channel";
    scopeId = place.placeId;
  }
  const now = Date.now();
  const { lastInsertRowid } = run(
    "INSERT INTO memory (guild_id, scope, scope_id, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    place.guildId ?? "", scope, scopeId, text, by, now, now,
  );
  return { id: lastInsertRowid, scope, scopeId, content: text, createdBy: by, updatedAt: now };
}

/** Anyone in a place can correct or remove what that place can read and write. */
function writable(place: MemoryPlace, id: number): MemoryEntry {
  const entry = rows("id = ?", id)[0];
  if (!entry) throw new Error(`No memory entry #${id}.`);
  const ok =
    (entry.scope === "dm" && place.kind === "dm" && entry.scopeId === place.placeId) ||
    (entry.scope === "channel" && entry.scopeId === place.placeId) ||
    (entry.scope === "workspace" && canWriteWorkspace(place) && entry.scopeId === place.guildId);
  if (!ok) throw new Error(`Memory entry #${id} can't be changed from here.`);
  return entry;
}

export function updateMemory(place: MemoryPlace, id: number, content: string): void {
  writable(place, id);
  run("UPDATE memory SET content = ?, updated_at = ? WHERE id = ?", content.trim().slice(0, MAX_ENTRY), Date.now(), id);
}

export function deleteMemory(place: MemoryPlace, id: number): void {
  writable(place, id);
  run("DELETE FROM memory WHERE id = ?", id);
}

export function hasChannelMemory(channelId: string): boolean {
  return !!get("SELECT 1 FROM memory WHERE scope = 'channel' AND scope_id = ? LIMIT 1", channelId);
}

export function formatMemory(entries: MemoryEntry[]): string {
  if (!entries.length) return "(no notes yet)";
  return entries
    .map((e) => `- #${e.id} [${e.scope === "workspace" ? "workspace" : e.scope === "dm" ? "this DM" : "this channel"}] ${e.content}`)
    .join("\n");
}
