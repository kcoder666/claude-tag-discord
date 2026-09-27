import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryDb } from "../src/core/db.js";
import { indexMessage, removeIndexedMessage, searchMessages, toFtsQuery, updateIndexedMessage } from "../src/core/search.js";

let n = 0;
function add(channelId: string, content: string, isPublic = true, guildId = "g") {
  indexMessage({ messageId: `m${++n}`, guildId, channelId, channelName: channelId, author: "ann", content, createdAt: n, isPublic });
}

beforeEach(() => {
  useMemoryDb();
  n = 0;
});

describe("toFtsQuery", () => {
  it("quotes each word and drops FTS syntax", () => {
    expect(toFtsQuery('deploy "prod" OR NOT x*')).toBe('"deploy" "prod" "OR" "NOT" "x"');
    expect(toFtsQuery("  ")).toBe("");
    expect(toFtsQuery("v1.2 release-notes #eng")).toBe('"v1.2" "release-notes" "#eng"');
  });
});

describe("searchMessages", () => {
  it("finds public messages and hides private channels except the current one", () => {
    add("pub", "the deploy failed on friday");
    add("priv", "deploy credentials rotated", false);
    add("pub", "lunch plans");
    expect(searchMessages({ guildId: "g", query: "deploy" }).map((h) => h.channel_id)).toEqual(["pub"]);
    expect(searchMessages({ guildId: "g", query: "deploy", currentChannelId: "priv" }).map((h) => h.channel_id).sort()).toEqual(["priv", "pub"]);
  });

  it("restricts to allowed channels and to the guild", () => {
    add("a", "roadmap draft");
    add("b", "roadmap final");
    add("a", "roadmap", true, "other-guild");
    expect(searchMessages({ guildId: "g", query: "roadmap", allowedChannelIds: new Set(["b"]) }).map((h) => h.channel_id)).toEqual(["b"]);
    expect(searchMessages({ guildId: "g", query: "roadmap" })).toHaveLength(2);
  });

  it("tracks edits and deletes", () => {
    add("a", "old words");
    updateIndexedMessage("m1", "new words");
    expect(searchMessages({ guildId: "g", query: "old" })).toHaveLength(0);
    expect(searchMessages({ guildId: "g", query: "new" })).toHaveLength(1);
    removeIndexedMessage("m1");
    expect(searchMessages({ guildId: "g", query: "new" })).toHaveLength(0);
  });

  it("survives hostile queries", () => {
    add("a", "hello");
    expect(() => searchMessages({ guildId: "g", query: '") OR 1=1 --' })).not.toThrow();
  });
});
