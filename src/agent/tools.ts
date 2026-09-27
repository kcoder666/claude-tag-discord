import {
  createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  deleteMemory, formatMemory, readableMemory, saveMemory, updateMemory, type MemoryPlace,
} from "../core/memory.js";
import {
  createRoutine, deleteRoutine, describeRoutine, listRoutines, updateRoutine,
} from "../core/routines.js";

/**
 * What the tools need from the rest of the bot. The Discord layer implements it per session, so
 * this file stays free of Discord types.
 */
export interface ToolHost {
  kind: "thread" | "channel" | "dm";
  guildId: string | null;
  /** Parent channel (config + memory owner), or the DM channel. */
  channelId: string;
  threadId: string | null;
  memoryPlace(): MemoryPlace;
  /** The person whose message the session is acting on most recently. */
  requesterId(): string | null;
  allowedModels(): string[];

  postMessage(text: string): Promise<void>;
  attachFile(filePath: string, name?: string, comment?: string): Promise<void>;
  publishPage(html: string, title: string): Promise<string>;
  postToChannel(channelRef: string, text: string): Promise<string>;
  searchMessages(query: string, limit: number): Promise<string>;
  readChannelHistory(channelRef: string | undefined, limit: number): Promise<string>;
  listSessions(): Promise<string>;
  readSessionTranscript(sessionRef: string, limit: number): Promise<string>;
  setModel(target: "thread" | "channel", model: string): Promise<string>;
  setRespondAutomatically(on: boolean): Promise<string>;
  setTaskTitle(title: string): Promise<void>;
  routinesChanged(): void;

  // channel session only
  respondInThread(messageId: string, text: string): Promise<string>;
  startTask(messageId: string, title: string, brief: string): Promise<string>;
  handoff(threadId: string, note: string): Promise<string>;
  react(messageId: string, emoji: string): Promise<void>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

async function guard(fn: () => Promise<string> | string) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
}

export const TAG_SERVER = "tag";

export function buildTagServer(host: ToolHost): McpSdkServerConfigWithInstance {
  const tools: SdkMcpToolDefinition<any>[] = [
    // ── memory ──
    tool("memory_list", "List the memory notes readable here (this channel's and the workspace's).", {}, async () =>
      guard(() => formatMemory(readableMemory(host.memoryPlace())))),
    tool(
      "memory_save",
      "Save a note. scope 'channel' (default) is read only here; 'workspace' is read in every channel and can only be saved from a public channel. In a DM, notes stay in the DM.",
      { content: z.string().min(1).max(1500), scope: z.enum(["channel", "workspace"]).optional() },
      async ({ content, scope }) =>
        guard(() => {
          const e = saveMemory(host.memoryPlace(), scope ?? "channel", content, host.requesterId());
          return `Saved note #${e.id} (${e.scope}).`;
        }),
    ),
    tool("memory_update", "Correct a memory note by id.", { id: z.number().int(), content: z.string().min(1).max(1500) }, async ({ id, content }) =>
      guard(() => {
        updateMemory(host.memoryPlace(), id, content);
        return `Updated note #${id}.`;
      })),
    tool("memory_delete", "Delete a memory note by id.", { id: z.number().int() }, async ({ id }) =>
      guard(() => {
        deleteMemory(host.memoryPlace(), id);
        return `Deleted note #${id}.`;
      })),

    // ── routines ──
    tool(
      "routine_create",
      "Schedule recurring work. Convert the person's words into a 5-field cron expression (minute hour day month weekday) in their timezone. Results post in this thread when created from a thread, otherwise top-level with the work in a thread. For a channel watch, write a prompt that reads the other channels with read_channel_history and posts only if relevant.",
      {
        name: z.string().min(1).max(100),
        cron: z.string().min(1),
        timezone: z.string().optional().describe("IANA timezone, e.g. Europe/Berlin. Defaults to the server timezone."),
        prompt: z.string().min(1).max(4000).describe("What to do on each run, self-contained."),
        post_in_this_thread: z.boolean().optional(),
      },
      async (a) =>
        guard(() => {
          const r = createRoutine({
            guildId: host.guildId, channelId: host.channelId,
            threadId: a.post_in_this_thread !== false && host.threadId ? host.threadId : null,
            kind: "schedule", name: a.name, cron: a.cron, timezone: a.timezone, prompt: a.prompt,
            ownerKind: host.kind === "dm" ? "dm" : "channel", createdBy: host.requesterId() ?? "unknown",
          });
          host.routinesChanged();
          return `Created ${describeRoutine(r)}`;
        }),
    ),
    tool(
      "routine_subscribe_pr",
      "Wake up when a GitHub pull request changes: CI result, a review, new commits, merge or close. Stops after merge/close.",
      {
        repo: z.string().describe("owner/name"),
        pr_number: z.number().int().positive(),
        prompt: z.string().min(1).max(4000).describe("What to do when it changes, e.g. 'fix failing CI' or 'summarize the review'."),
      },
      async (a) =>
        guard(() => {
          const r = createRoutine({
            guildId: host.guildId, channelId: host.channelId, threadId: host.threadId, kind: "pr",
            name: `${a.repo}#${a.pr_number}`, repo: a.repo, prNumber: a.pr_number, prompt: a.prompt,
            ownerKind: host.kind === "dm" ? "dm" : "channel", createdBy: host.requesterId() ?? "unknown",
          });
          host.routinesChanged();
          return `Subscribed: ${describeRoutine(r)}`;
        }),
    ),
    tool("routine_list", "List this channel's routines.", {}, async () =>
      guard(() => listRoutines(host.channelId).map(describeRoutine).join("\n") || "No routines in this channel.")),
    tool(
      "routine_update",
      "Pause, resume, reschedule, rename or change the prompt of a routine in this channel.",
      {
        id: z.number().int(), enabled: z.boolean().optional(), cron: z.string().optional(),
        timezone: z.string().optional(), prompt: z.string().max(4000).optional(), name: z.string().max(100).optional(),
      },
      async ({ id, ...patch }) =>
        guard(() => {
          const r = updateRoutine(host.channelId, id, patch);
          host.routinesChanged();
          return `Updated ${describeRoutine(r)}`;
        }),
    ),
    tool("routine_delete", "Stop and delete a routine in this channel.", { id: z.number().int() }, async ({ id }) =>
      guard(() => {
        deleteRoutine(host.channelId, id);
        host.routinesChanged();
        return `Deleted routine #${id}.`;
      })),

    // ── messaging and files ──
    tool(
      "post_message",
      "Post a short interim update in the current conversation while you keep working. Your final answer is posted automatically; don't repeat it here.",
      { text: z.string().min(1).max(4000) },
      async ({ text }) => guard(async () => (await host.postMessage(text), "Posted.")),
    ),
    tool(
      "attach_file",
      "Upload a file from your workspace to the conversation (reports, CSVs, images, charts, patches). Max 25MB.",
      { path: z.string(), name: z.string().optional(), comment: z.string().max(1500).optional() },
      async (a) => guard(async () => (await host.attachFile(a.path, a.name, a.comment), "Attached.")),
    ),
    tool(
      "publish_page",
      "Host a self-contained HTML page (inline CSS/JS) at an unguessable URL and get the link. Republish with the same title to update it.",
      { title: z.string().min(1).max(100), html: z.string().min(1) },
      async (a) => guard(() => host.publishPage(a.html, a.title)),
    ),
    tool(
      "post_to_channel",
      "Post a message to another channel, only when someone asked for it. Allowed only into public channels, and not from private channels. From a DM, the person must approve before it posts. An attribution line is added.",
      { channel: z.string().describe("Channel id, <#id> mention, or #name"), text: z.string().min(1).max(3500) },
      async (a) => guard(() => host.postToChannel(a.channel, a.text)),
    ),

    // ── search and history ──
    tool(
      "search_messages",
      "Keyword search over messages in this server's public channels (and this channel). Returns matches with channel, author, time and message id.",
      { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      async (a) => guard(() => host.searchMessages(a.query, a.limit ?? 20)),
    ),
    tool(
      "read_channel_history",
      "Read recent messages of this conversation, or of another channel you can see (public channels only when you're in a public place).",
      { channel: z.string().optional().describe("Channel/thread id, <#id> or #name; omit for the current one"), limit: z.number().int().min(1).max(100).optional() },
      async (a) => guard(() => host.readChannelHistory(a.channel, a.limit ?? 30)),
    ),
    tool("list_sessions", "List past working sessions (threads) in this channel with their titles.", {}, async () =>
      guard(() => host.listSessions())),
    tool(
      "read_session_transcript",
      "Read the transcript of a past session in this channel, by thread id from list_sessions.",
      { thread_id: z.string(), limit: z.number().int().min(1).max(200).optional() },
      async (a) => guard(() => host.readSessionTranscript(a.thread_id, a.limit ?? 60)),
    ),

    // ── settings ──
    tool(
      "set_model",
      "Switch models. target 'thread' changes this conversation only; 'channel' makes it the channel's default for new sessions.",
      { target: z.enum(["thread", "channel"]), model: z.string() },
      async (a) => guard(() => host.setModel(a.target, a.model)),
    ),
    tool(
      "set_respond_automatically",
      "Turn 'respond automatically' on or off for this channel (whether you reply to messages nobody tagged you in).",
      { on: z.boolean() },
      async ({ on }) => guard(() => host.setRespondAutomatically(on)),
    ),
    tool("set_task_title", "Rename this working session (2–5 words). Shown as your name in the thread.", { title: z.string().min(1).max(60) }, async ({ title }) =>
      guard(async () => (await host.setTaskTitle(title), "Renamed."))),
  ];

  if (host.kind === "channel") {
    tools.push(
      tool(
        "respond_in_thread",
        "Give a short reply in a thread under a top-level message.",
        { message_id: z.string(), text: z.string().min(1).max(3500) },
        async (a) => guard(() => host.respondInThread(a.message_id, a.text)),
      ),
      tool(
        "start_task",
        "Start a working session in a thread under a message, for anything that needs real work.",
        {
          message_id: z.string(),
          title: z.string().min(1).max(60).describe("2–5 words"),
          brief: z.string().min(1).max(6000).describe("The ask plus the context the session needs."),
        },
        async (a) => guard(() => host.startTask(a.message_id, a.title, a.brief)),
      ),
      tool(
        "handoff",
        "Pass a message to the session already working in another thread.",
        { thread_id: z.string(), note: z.string().min(1).max(4000) },
        async (a) => guard(() => host.handoff(a.thread_id, a.note)),
      ),
      tool(
        "react",
        "React to a message with an emoji (unicode, e.g. 👍).",
        { message_id: z.string(), emoji: z.string().min(1).max(32) },
        async (a) => guard(async () => (await host.react(a.message_id, a.emoji), "Reacted.")),
      ),
    );
  }

  return createSdkMcpServer({ name: TAG_SERVER, version: "1.0.0", tools });
}

/** Tool names the channel session uses to act on a message (used to guarantee mentions get a response). */
export const CHANNEL_ACTION_TOOLS = ["respond_in_thread", "start_task", "handoff", "react"].map((t) => `mcp__${TAG_SERVER}__${t}`);
