# Design notes

Research on Anthropic's Claude Tag (Slack) and the decisions behind this Discord version. The README has the
user-facing summary and the feature-parity table.

## 1. What Claude Tag is (research summary, June 2026)

Sources: anthropic.com/news/introducing-claude-tag, claude.com/product/tag, the docs at
claude.com/docs/claude-tag/* (overview, concepts/how-it-works, concepts/agent-identity,
users/getting-started, users/memory, users/proactivity, users/commands, users/when-claude-responds,
users/models, admins/customize, admins/restrict-access, concepts/personal-connectors),
support.claude.com/en/articles/15594475, and code.claude.com/docs/en/slack. Public beta since
2026-06-23 (Team and Enterprise plans).

**Core model**
- **Tag `@Claude`** in a channel with a task. It reacts with an emoji within seconds, shows
  "is thinking…", and works in a **thread** under the message. Everything it does is visible to the channel.
- **Multiplayer:** there is one Claude per channel. **Anyone can steer a running session by replying in
  the thread**, with no re-mention needed; new replies are folded into the work in progress.
- **Sessions:** each thread has its own session in an **ephemeral sandbox**, released a few minutes after
  it goes idle. The transcript persists, so a new reply resumes in a fresh sandbox. Files that exist only
  in the sandbox are lost, which is why Claude pushes and posts deliverables as it goes.
- **Channel session:** a separate long-lived session reads top-level messages and handles top-level
  mentions, so context carries across separate top-level asks. For each message it decides to do
  **nothing** (the usual case), give a **short reply in a thread**, **start a working session** in the
  thread, or **hand the message off** to a session already working in another thread. It is replaced
  after about 1h idle, or once about a day old and quiet, or when the channel's configuration changes.
- **Checklist:** longer tasks get a live task list that is **edited in place** (edits don't notify
  anyone). Results come back as a reply, a file or chart, a page kept current, a hosted web page, or a
  draft PR.
- **Reply names:** "Claude" for ambient replies, "Claude [short task description]" for working sessions.
  The footer names the **model** and has a **Configure** link.
- **Context:** Claude reads its thread and channel history (including pins), searches workspace public
  channels by keyword, and handles attachments (at most 5 per message; images up to 3.75MB, PDFs up to
  5MB, other files up to 100MB). A mention partway into a thread gives it a window of earlier messages;
  other bots' replies are filtered out.
- **Edits and deletes:** an edit sends Claude a note with the before and after text, but never starts a
  task, even if the edit adds a mention. Deleting a reply sends no notice. Deleting the thread's **first
  message closes the session** (it is archived).
- **When it responds:** always in DMs and in threads it has joined. At the top level only when mentioned,
  or when "Respond automatically" (per channel, default ON) and it judges a reply warranted. Bot
  messages are context only. After about **100 top-level messages without Claude posting**, it stops
  reading the channel until someone mentions it again.
- **Quieting:** "only respond when mentioned" per thread; `!mute`; a **👎 reaction mutes the thread and
  abandons any in-progress reply**; `/remove @Claude` to remove it.
- **Commands** (`@Claude !cmd`):
  - `!help`
  - `!configure`: link to the channel settings
  - `!restart`: archive the session and start a fresh one that rereads the thread. At the top level it
    replaces the channel session.
  - `!status`: private note, e.g. "still working, started 6m ago, muted: no"
  - `!mute` / `!unmute`: per thread only. At the top level it posts a hint instead.
  - `!feedback [text]`
  - `!routines [#channel]`
  - `!fork [#channel] <prompt>`: continue in a new thread with the original thread as background, and
    link both threads. Public channels only.
- **Memory:** notes are kept **per channel**. **Workspace notes** can be saved only from **public
  channels** and are read in every channel. Private channels read workspace notes but write only their
  own. DMs keep their own notes. Anyone in a channel can read or correct them. "remember for this
  channel: …" saves to memory, and "what do you remember about this channel?" lists it. Claude can also
  list and read past session transcripts. **Custom instructions outrank memory.**
- **Routines:** scheduled jobs from natural language, run in UTC. Without a timezone, the user's
  timezone is used. Other routine types:
  - **channel watches**: e.g. "watch #a #b, post here daily if relevant"
  - **PR subscriptions**: wake on CI, review, or merge for one PR
  Results post in the originating thread, or top-level with the work in a thread under it. Anyone in the
  channel can list, pause, reschedule, or stop routines. They keep running if their creator leaves; the
  creator gets a completion/failure notice.
- **Cross-channel posting:** Claude can post to another *public* channel it's in, with an attribution
  line ("Sent by Claude in #x on behalf of @y"). Not allowed from private channels. From a DM, it posts
  only after an **Approve and post** button.
- **Models:** "switch to X for this thread", or "make it the default for this channel". Only allowed
  models; the footer confirms the switch.
- **Identity and access:** in channels it acts with **service-account credentials that an admin attaches
  per scope** (org → workspace → channel). DMs run on the **user's own account** and bill to them.
  Credentials never enter the sandbox: an **Agent Proxy** injects them at egress for allowed hosts and
  blocks every other host, naming the blocked host in the thread. Web search is separate from sandbox
  egress.
- **Admin controls:**
  - enable/disable per scope
  - restrict who can use it (roles)
  - allow/disable DMs
  - guest channels: Restrict (default) / Channel only / Full access
  - search scope: all public channels / only channels Claude is in
  - blocked and auto-join channel-name patterns (`*`, `?`; up to 50)
  - custom instructions per scope, stacking down the scopes
  - default model per scope
  - **auto-mode allow rules**: plain sentences that stack
  - environment: setup script, env vars, network level
  - plugins and skills
  - "Channel member edits" allow/block
  - channel managers
- **Spend:** channel work bills to the org. There is an org monthly cap, a default per-channel cap, and
  per-channel caps. **Alerts at 75% and 95%**, and work that would go over is declined. Usage analytics
  are available by channel and by kind of work. There is an audit page listing scheduled work, memory
  files, and network events.
- **Personal connectors in channels:** Claude asks for approval first (Allow / Allow with review /
  Don't allow). A sensitive-content check holds results for review, and a Stop button is available.
  This is the lowest priority for the clone.
- First time in a channel it posts a short **intro** and suggests tasks.

---

## 2. Decisions already made

- **Stack:** TypeScript (ESM, NodeNext), Node ≥ 22.13 (dev machine has Node 26), **pnpm**,
  **discord.js v14**, **`@anthropic-ai/claude-agent-sdk`** (0.3.x) as the engine (it *is* the Claude
  Code harness, like the real product's sandbox), **`node:sqlite`** (built-in, FTS5 verified working —
  no native deps), **croner** for timezone-aware cron, **zod** v4, **vitest**, **tsx**.
  `@anthropic-ai/sdk` was removed on purpose — see auth.
- **Auth / Claude subscription (the user's explicit ask):** *every* model call goes through the Agent
  SDK so one credential covers everything. `src/core/auth.ts` resolves:
  `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` (subscription token from `claude setup-token`) →
  local `claude /login`; `AUTH_MODE` forces one. DMs use the sender's personal API key if they saved one
  (`/claude account set-key`), else fall back to the bot credential (`DM_FALLBACK_TO_BOT_CREDENTIAL`).
  **Policy caveat to put in the README and tell the user:** the Agent SDK docs say *"Unless previously
  approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for
  their products, including agents built on the Claude Agent SDK."* So: support the **operator's own**
  subscription token for a self-hosted bot, but **never** build a "log in with your Claude account" flow
  for Discord users. With a subscription, `total_cost_usd` is an estimate — `ENFORCE_SPEND_LIMITS` can
  be turned off.
- **Default model** `claude-opus-5` (per the claude-api skill). The channel session also defaults to it
  at `effort: "low"` (`CHANNEL_MODEL`, `CHANNEL_EFFORT`) rather than silently downgrading models.
  `ALLOWED_MODELS` defaults to `claude-opus-5,claude-sonnet-5,claude-haiku-4-5`.
- **Discord mappings:**
  - Slack workspace → guild
  - scopes → `guild:<id>` plus `channel:<id>` (threads use their parent channel)
  - Configure page → ephemeral `/claude configure` panel (buttons, select menu, modals)
  - "only you can see" notes → ephemeral slash-command replies, or a DM for `!` commands
  - Slack guests → configurable **guest role ids**
  - workspace search → the bot's **own FTS5 index** of messages it sees (Discord bots have no search API)
  - "Claude [task]" persona → **channel webhooks** with a per-message username (fall back to plain bot
    posts without Manage Webhooks)
  - footer → a `-# model · /claude configure` subtext line
  - hosted pages → optional built-in HTTP server at `PUBLIC_BASE_URL` with unguessable ids
  - auto-join patterns → N/A (a Discord bot sees channels by permission)
  - Slack Connect → N/A
- **Sandbox / Agent Proxy equivalent:** use the SDK's `sandbox` option.
  - `network.allowedDomains` = scope domains ∪ connection hosts ∪ `TRUSTED_DOMAINS` (for the "trusted"
    level)
  - `filesystem.allowWrite: [cwd]`
  - `credentials.envVars`: each connection's secret as `{ name, mode: "mask", injectHosts: hosts }`, so
    the proxy swaps a sentinel for the real value only on egress to those hosts, plus the Anthropic
    credential vars as `mode: "deny"`
  - **Note from the SDK typings:** "On macOS and Windows `mask` currently degrades to `deny`". Linux or
    Docker is needed for true injection. Document this, and ship a Dockerfile.
  - `WebFetch` isn't covered by the sandbox, so gate it in `canUseTool` by host.
- **Permissions:** `PERMISSION_MODE=default` (our policy in `canUseTool`) or `auto` (Claude Code auto
  mode).
  - Allow automatically: our MCP tools, Read/Glob/Grep/TodoWrite/WebSearch, edits inside cwd, sandboxed
    Bash (`autoAllowBashIfSandboxed`), and admin-configured MCP servers.
  - Ask everything else: **Approve/Deny buttons in the thread**, clickable only by allowed non-guest
    members, deny on timeout.
  - Allow rules go into the system prompt. With the sandbox off, risky Bash (rm -rf, force-push, sudo,
    deploy, publish, `curl | sh` …) always asks.
- **Env hygiene:** `buildSessionEnv` passes only an allowlist of host env vars. `DISCORD_TOKEN`,
  `SECRET_KEY`, and `GITHUB_TOKEN` never reach the agent. Do **not** override `CLAUDE_CONFIG_DIR`,
  because it breaks local-login keychain auth. Transcripts live under `~/.claude/projects/<encoded cwd>`,
  so keep **each thread's workspace path stable** (`DATA_DIR/workspaces/<threadId>`). On idle, delete
  the workspace *contents*, then `resume: sdkSessionId` with the same cwd.

---

## 3. Verified Agent SDK facts (read from the installed `sdk.d.ts` — trust these over web summaries)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` returns `Query`, an async
  generator with `interrupt()`, `setModel()`, `setPermissionMode()`, and `close()`.
- `SDKUserMessage = { type: "user", message: MessageParam, parent_tool_use_id: string | null, priority?, ... }`
- Messages:
  - `{ type: "system", subtype: "init", session_id, model, ... }`
  - `{ type: "assistant", message: BetaMessage /* content blocks incl. tool_use */ }`
  - `{ type: "result", subtype: "success" | "error_*", result (success), errors (error), total_cost_usd /* cumulative per query */, is_error, queued_turn_count?, structured_output? }`
- `CanUseTool = (toolName, input, { signal, suggestions, decisionReason, title, displayName, mcpServer, ... }) => Promise<PermissionResult>`
- `PermissionResult = { behavior: "allow", updatedInput? } | { behavior: "deny", message, interrupt? }`
- `PermissionMode = 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`
- Useful `Options`:
  - `cwd, model, effort, env` (**env REPLACES process.env**), `abortController`
  - `systemPrompt: { type: "preset", preset: "claude_code", append }`
  - `tools` (string[]; `[]` disables built-ins), `allowedTools`, `disallowedTools`
  - `mcpServers`, `canUseTool`, `permissionMode`, `settingSources`, `maxTurns`, `maxBudgetUsd`
  - `resume`, `persistSession`
  - `outputFormat: { type: "json_schema", schema }`
  - `sandbox: SandboxSettings`, `plugins: [{ type: "local", path }]`, `thinking`, `stderr`
- `tool(name, description, zodRawShape, handler(args, extra) => Promise<CallToolResult>)` and
  `createSdkMcpServer({ name, version?, tools })`.
- Session helpers: `listSessions({dir})`, `getSessionMessages(id, {dir, limit, offset})`,
  `getSessionInfo`, `renameSession`, `forkSession`, `deleteSession`.
- `SandboxSettings` fields:
  - `enabled, failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands`
  - `network{ allowedDomains, deniedDomains, … }`, `filesystem{ allowWrite, denyWrite, denyRead, allowRead }`
  - `credentials{ envVars[{ name, mode: "deny"|"mask", injectHosts }], files[...] }`

## 4. Changes made while building

- **Hard rules in a PreToolUse hook.** A live test against the Claude Code runtime showed that Claude Code
  auto-approves commands it considers read-only (`echo`, `cat`, …) before `canUseTool` is consulted, and that `Read`
  could reach any host path. `hardRule()` now runs as a PreToolUse hook. File tools must stay inside the session's
  workspace, and with the sandbox off every Bash call is forced to "ask". The sandbox also gets `denyRead` for the
  data dir, the bot's install dir and credential dotfiles, with `allowRead` for the session's own workspace. Verified
  live on macOS Seatbelt: reading the bot's dir fails, workspace writes work, unlisted hosts get a 403 from the proxy.
- **Our MCP tools go through `canUseTool`** (which allows them) rather than a bare `allowedTools` entry, which the SDK
  warns would shadow the callback.
- **Webhook name** is `claude-tag-discord` rather than "Claude Tag", to avoid looking like the Anthropic product.
- **DM model preference** (`/claude account model`) is stored per user and applies to new DM sessions.
