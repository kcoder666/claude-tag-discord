import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import {
  canWriteWorkspace, deleteMemory, formatMemory, readableMemory, saveMemory, updateMemory, type MemoryPlace,
} from "../src/core/memory.js";

const pub: MemoryPlace = { guildId: "g", placeId: "c-public", kind: "public" };
const priv: MemoryPlace = { guildId: "g", placeId: "c-private", kind: "private" };
const other: MemoryPlace = { guildId: "g", placeId: "c-other", kind: "public" };
const dm: MemoryPlace = { guildId: null, placeId: "user-1", kind: "dm" };

beforeEach(() => {
  useMemoryDb();
});

describe("memory rules", () => {
  it("saves workspace notes only from public channels", () => {
    expect(canWriteWorkspace(pub)).toBe(true);
    expect(canWriteWorkspace(priv)).toBe(false);
    expect(canWriteWorkspace(dm)).toBe(false);
    expect(saveMemory(pub, "workspace", "Deploys happen on Tuesdays", "u").scope).toBe("workspace");
    expect(() => saveMemory(priv, "workspace", "secret", "u")).toThrow(/public channel/);
  });

  it("every channel reads workspace notes, but only its own channel notes", () => {
    saveMemory(pub, "workspace", "W", "u");
    saveMemory(pub, "channel", "P", "u");
    saveMemory(priv, "channel", "Q", "u");
    expect(readableMemory(pub).map((e) => e.content)).toEqual(["W", "P"]);
    expect(readableMemory(priv).map((e) => e.content)).toEqual(["W", "Q"]);
    expect(readableMemory(other).map((e) => e.content)).toEqual(["W"]);
  });

  it("keeps DM notes in the DM and doesn't read workspace notes there", () => {
    saveMemory(pub, "workspace", "W", "u");
    const e = saveMemory(dm, "workspace", "I prefer metric units", "user-1");
    expect(e.scope).toBe("dm");
    expect(readableMemory(dm).map((x) => x.content)).toEqual(["I prefer metric units"]);
    expect(readableMemory(pub).map((x) => x.content)).toEqual(["W"]);
  });

  it("turns memory off under channel-only guest access", () => {
    saveMemory(pub, "channel", "P", "u");
    const guarded = { ...pub, noMemory: true };
    expect(readableMemory(guarded)).toEqual([]);
    expect(() => saveMemory(guarded, "channel", "x", "u")).toThrow(/guests/);
  });

  it("only lets a place correct notes it can write", () => {
    const own = saveMemory(pub, "channel", "old", "u");
    const ws = saveMemory(pub, "workspace", "ws", "u");
    updateMemory(pub, own.id, "new");
    expect(readableMemory(pub).find((e) => e.id === own.id)?.content).toBe("new");
    expect(() => updateMemory(other, own.id, "hijack")).toThrow(/can't be changed/);
    expect(() => deleteMemory(priv, ws.id)).toThrow(/can't be changed/);
    deleteMemory(other, ws.id); // another public channel may correct workspace notes
    expect(readableMemory(pub).map((e) => e.content)).toEqual(["new"]);
  });

  it("trims and rejects empty notes", () => {
    expect(() => saveMemory(pub, "channel", "   ", "u")).toThrow(/Nothing/);
    expect(saveMemory(pub, "channel", "x".repeat(3000), "u").content).toHaveLength(1500);
  });

  it("formats notes with their scope", () => {
    saveMemory(pub, "workspace", "W", "u");
    saveMemory(pub, "channel", "P", "u");
    expect(formatMemory(readableMemory(pub))).toBe("- #1 [workspace] W\n- #2 [this channel] P");
    expect(formatMemory([])).toBe("(no notes yet)");
  });
});
