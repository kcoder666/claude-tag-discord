# claude-tag-discord

**Tag `@Claude` in any Discord channel and hand it real work.** A self-hosted Discord take on
Anthropic's [Claude Tag](https://claude.com/product/tag) for Slack, built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), so every session is the full Claude Code
harness: files, shell, web, MCP, skills, in a sandbox.

> **Unofficial.** This is an independent open-source project. It is not made, endorsed or supported by Anthropic,
> and it is not the Claude Tag product. "Claude" is Anthropic's trademark; the bot only uses the name to say which
> model is answering.

> **Project status:** feature-complete against the list below and covered by unit tests. Its Agent SDK integration
> (sessions, tools, hooks, sandbox) has been exercised against the real Claude Code runtime. **It has not yet been
> run end-to-end against a live Discord server**, so treat the first deployment as a beta and please open issues.

- Mention Claude with a task: it reacts 👀, works in a **thread** under your message, and shows a **live checklist**.
- **Multiplayer:** anyone can steer a running task by replying in the thread. No re-mention needed.
- A **channel session** reads top-level messages. It stays quiet unless it's useful: a short reply, a new task, or a
  hand-off to a thread that's already working on it.
- **Memory** per channel, plus server-wide notes, **routines** (cron, channel watches, PR subscriptions),
  **approvals** with buttons, **spend caps** with alerts, per-channel **instructions** and **models**.
- Runs on an **Anthropic API key** or **your own Claude subscription** (see [Authentication](#authentication)).

---

## Contents

- [How it works](#how-it-works)
- [Feature parity with Claude Tag](#feature-parity-with-claude-tag)
- [Setup](#setup)
- [Authentication](#authentication)
- [Using it](#using-it)
- [Administration](#administration)
- [Security model](#security-model)
- [Configuration reference](#configuration-reference)
- [Development](#development)

## How it works

```
Discord ──▶ handlers ──▶ SessionManager ──▶ AgentSession (Claude Agent SDK, streaming input)
                │               │                    │
                │               │                    ├── built-in tools (Read/Edit/Bash/WebSearch…)
                │               │                    ├── in-process MCP server "tag" (memory, routines,
                │               │                    │   post/attach/publish, search, settings, triage)
                │               │                    ├── canUseTool policy + PreToolUse hard rules
                │               │                    └── sandbox: fs + network allowlist + secret masking
                │               ├── channel session per channel  (key channel:<id>, no built-in tools)
                │               ├── thread session per thread    (key <threadId>, workspace data/workspaces/<id>)
                │               └── DM session per user          (key dm:<userId>)
                └── SQLite (node:sqlite + FTS5): scopes, secrets, memory, sessions, routines, usage, index
```

- **One Claude per channel.** A long-lived channel session gets each top-level message (bursts are batched) and
  decides, through tools, whether to do nothing, reply in a thread, start a task, or hand off. If a message
  mentioned Claude and the channel session didn't act on it, a task starts anyway, so a mention always gets a response.
- **Thread sessions** run in streaming-input mode. A reply that arrives while Claude is working is folded into the
  work in progress. Each thread has a stable workspace directory. After `SANDBOX_IDLE_MINUTES` idle the process
  stops and the workspace is wiped, but the transcript persists, so the next reply resumes the same conversation
  (files are gone, as in Claude Tag). This is why Claude is told to deliver as it goes.
- **Channel sessions** rotate after an hour idle, once a day old and quiet, or when the channel's configuration
  changes.

## Feature parity with Claude Tag

| Claude Tag (Slack) | This bot (Discord) | Status |
|---|---|---|
| `@Claude` a task → emoji ack, "thinking…", work in a thread | 👀 reaction, typing indicator, thread under the message | ✅ |
| Anyone steers by replying in the thread | Replies are pushed into the running session | ✅ |
| Channel session: nothing / short reply / working session / hand-off | Same, via `respond_in_thread`, `start_task`, `handoff`, `react` tools | ✅ |
| Mentions always get a response | Unanswered mentions auto-start a task | ✅ |
| Ephemeral sandbox, persistent transcript, resume in a fresh sandbox | Idle release + `resume` with a stable workspace path | ✅ |
| Live checklist edited in place | TodoWrite → one message edited in place, with a **Stop** button | ✅ |
| "Claude [task]" names, model footer, Configure link | Channel webhooks with per-message names; `-# model · /claude configure` | ✅ (needs *Manage Webhooks*; otherwise posts as the bot) |
| Results: reply, file, hosted page, draft PR | Reply, `attach_file`, `publish_page` (optional HTTP server), git/PRs via repositories + connections | ✅ (hosted pages need `PUBLIC_BASE_URL`) |
| Reads thread/channel history, attachments (5/msg, images 3.75MB, PDFs 5MB, files 100MB) | Same limits; images/PDFs inline, other files saved to the workspace | ✅ |
| Workspace search | The bot's own FTS5 index of messages it has seen (Discord has no search API for bots) | ⚠️ only messages seen since the bot joined |
| Mid-thread mention gets a window of earlier messages; other bots filtered | `THREAD_CONTEXT_WINDOW` messages; other bots dropped | ✅ |
| Edits send a before/after note, never start a task | Same | ✅ |
| Deleting the thread's first message closes the session | Same | ✅ |
| Respond automatically (per channel, default on) | Same; toggle in `/claude configure` or by asking | ✅ |
| Stops reading after ~100 top-level messages without posting | `STOP_READING_AFTER`, reset by a mention | ✅ |
| 👎 mutes the thread and abandons the reply | Same | ✅ |
| `!help !configure !restart !status !mute !unmute !feedback !routines !fork` | Same; "private" notes go by DM | ✅ |
| Memory: per channel, workspace notes only from public channels, DMs separate, anyone can correct | Same rules; `/claude memory` to view/delete | ✅ |
| Custom instructions outrank memory | Instructions stack server → channel and precede memory in the prompt | ✅ |
| Routines: schedules, channel watches, PR subscriptions; anyone can manage; creator notified | croner (per-routine timezone) and GitHub polling; creator DM'd on completion/failure | ✅ (timezone defaults to the server's `DEFAULT_TIMEZONE`, since Discord has no user timezone) |
| Cross-channel posting with attribution; not from private; DM needs "Approve and post" | Same | ✅ |
| Switch model per thread / channel default, allowed list | `set_model` tool and `/claude model` | ✅ |
| Channel work on admin-attached credentials; secrets never in the sandbox (Agent Proxy) | Connections are injected by the SDK sandbox proxy only for their hosts | ✅ on Linux/Docker · ⚠️ on macOS/Windows the SDK degrades masking to *deny* |
| Blocked host named in the thread | Posted as a `-#` note and logged to the audit | ✅ |
| DMs on the user's own account | The user's own **API key** (`/claude account set-key`), else the bot's credential if allowed | ⚠️ by design: no "log in with Claude" (see policy below) |
| Admin: enable per scope, roles, DMs, guests, search scope, blocked channel patterns, instructions, default model, allow rules, environment, plugins, member edits | `/claude-admin edit` (JSON) at server and channel scope | ✅ (plugins = local paths) |
| Guest channels: Restrict / Channel only / Full | Guest **roles** stand in for Slack guests | ✅ |
| Spend: org cap, per-channel caps, 75%/95% alerts, decline over budget, usage by channel/kind | Same, on the SDK's cost estimates; `/claude-admin usage` | ✅ (estimates; see subscriptions) |
| Audit of scheduled work, memory, network events | `/claude-admin audit` | ✅ (text, not a web page) |
| First-time intro in a channel | Posted on the first mention | ✅ |
| Personal connectors in channels (Allow / Allow with review) | — | ❌ not implemented |
| Auto-join channel patterns, Slack Connect | — | N/A on Discord |

## Setup

### 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
2. Under **Privileged Gateway Intents** enable **Message Content**. **Server Members** is optional but recommended,
   because guest and allowed-role checks rely on it. Without it, set `GUILD_MEMBERS_INTENT=false`.
3. Copy the bot token into `DISCORD_TOKEN`.
4. Invite it with scopes `bot applications.commands` and these permissions: View Channels, Send Messages,
   Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Attach Files, Embed Links,
   Manage Webhooks (permission integer `309774634048`):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=309774634048
   ```

### 2. Run it

**Docker (recommended: Linux is needed for secret masking):**

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, a credential, SECRET_KEY
docker compose up -d --build
```

**Locally (Node ≥ 22.13, pnpm):**

```bash
pnpm install
cp .env.example .env
pnpm dev                  # or: pnpm build && pnpm start
```

Slash commands are registered on startup (instantly in `DEV_GUILD_ID` if set, otherwise globally, which can take
up to an hour). `pnpm register-commands` does the same without starting the bot.

The sandbox needs `bubblewrap` and `socat` on Linux (included in the Docker image) and uses the built-in Seatbelt
on macOS. If the container can't create user namespaces, see the commented `security_opt` in
`docker-compose.yml`.

## Authentication

Every model call goes through the Agent SDK, so one credential covers everything. The bot picks the first that is
set, or the one `AUTH_MODE` forces:

| Credential | Env | Billing |
|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY` | Per token, on your Console account |
| Your Claude Pro/Max subscription | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Counts against your subscription's usage limits |
| Local login | neither set; uses the account `claude /login` stored on the host | That account |

### ⚠️ Using a Claude subscription: read this first

The Agent SDK documentation says:

> *Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate
> limits for their products, including agents built on the Claude Agent SDK.*
> — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

So this project:

- **supports only the operator's own subscription token**, for a bot you host yourself for your own use;
- **never** offers Discord users a "log in with your Claude account" flow. DMs use a user's own *API key* or the
  bot's credential, never a user's subscription.

If you run the bot for a community or anyone beyond yourself, use an **API key**. Whether a given setup is allowed
is between you and Anthropic's terms ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms),
[Usage Policy](https://www.anthropic.com/legal/aup)); when in doubt, use an API key.

On a subscription, `total_cost_usd` is a list-price **estimate**, not money billed. Spend limits still work
against the estimate. Set `ENFORCE_SPEND_LIMITS=false` if you'd rather rely on the subscription's own limits.

## Using it

- **Ask:** `@Claude why is CI red on main?` → a thread with a checklist, updates, and a final answer.
- **Steer:** reply in the thread (`actually, only look at the backend`). It's folded into the running work.
- **Approvals:** actions outside the policy (unsandboxed or risky shell, unknown MCP tools, fetches to unlisted
  hosts) post **Approve / Deny** buttons. Any allowed, non-guest member can decide; unanswered requests are denied
  after `APPROVAL_TIMEOUT_MINUTES`.
- **Memory:** `remember for this channel: deploys are Tuesdays` · `what do you remember?` · `/claude memory`.
- **Routines:** `every weekday at 9am Berlin time, summarize new issues` · `watch #support and #sales, post here daily
  if anything mentions pricing` · `tell me when PR acme/app#42 passes CI` · `!routines`.
- **Models:** `switch to claude-sonnet-5 for this thread` · `make it the default for this channel` · `/claude model`.
- **Elsewhere:** `post a summary in #announcements` (public channels only, with attribution).
- **Quiet:** 👎 on a reply mutes the thread; `!mute` / `!unmute`; turn *Respond automatically* off in `/claude configure`.

`/claude help|status|configure|routines|memory|feedback|model|account` · `@Claude !help` for the `!` commands.

## Administration

`/claude-admin` (needs *Manage Server*, or a user id in `OWNER_IDS`):

- `show` / `edit` `scope: server|this channel` edits the scope as JSON. Channel settings override or extend the
  server's (instructions and allow rules stack; domains, repositories and plugins are unions).
- `secret set|remove` manages **connections**: a named secret, the env var it's exposed as, and the hosts it may be
  sent to. The value is entered in a modal and stored AES-256-GCM encrypted with `SECRET_KEY`.
- `usage` shows this month's estimated spend by channel, kind and work. `audit` shows routines, memory and recent
  activity (tasks, approvals, blocked hosts, settings changes, cross-posts). `reset-channel` replaces the channel
  session.

Example server scope:

```json
{
  "instructions": "We use pnpm and conventional commits. Never push to main.",
  "model": "claude-opus-5",
  "allowRules": ["Opening draft pull requests on repositories listed below"],
  "repositories": ["acme/app", "acme/infra"],
  "domains": ["api.linear.app"],
  "networkAccess": "trusted",
  "mcpServers": { "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } },
  "environment": { "setupScript": "git config --global user.name 'Claude'", "env": { "CI": "1" } },
  "guestRoleIds": ["123456789012345678"],
  "guestMode": "restrict",
  "blockedChannelPatterns": ["legal-*", "*-private"],
  "allowedRoleIds": [],
  "searchScope": "all_public",
  "memberEdits": "allow",
  "monthlyLimitUsd": 200,
  "channelLimitUsd": 50,
  "alertChannelId": "123456789012345678"
}
```

`networkAccess` sets what sandboxed commands can reach: `trusted` (package registries and GitHub, plus your
domains and connection hosts), `none` (only your domains and connection hosts), or `full`.

## Security model

- **Tenancy:** channel work runs on the operator's credential. Each thread has its own workspace, and commands
  can't read other workspaces, the bot's database, its install directory (`.env`), or common credential stores
  (`~/.ssh`, `~/.aws`, `~/.claude`, …). Enforcement is the sandbox's `denyRead` / `allowRead`, plus a PreToolUse hook
  that keeps file tools inside the workspace.
- **Secrets never enter the sandbox:** `DISCORD_TOKEN`, `SECRET_KEY` and `GITHUB_TOKEN` are never passed to Claude
  Code. Only an allowlist of host env vars is. The Claude credential is hidden from commands (`deny`), and each
  connection is `mask`ed and injected by the sandbox proxy only on egress to its hosts. **On macOS/Windows the SDK
  degrades `mask` to `deny`,** so connections only work on Linux (use Docker).
- **Network:** sandboxed commands reach only allowed hosts (`strictAllowlist`); the blocked host is named in the
  thread. `WebFetch` runs outside the sandbox, so it's gated by host in the permission policy.
- **Permissions (`PERMISSION_MODE=default`):** allowed automatically are Claude's own tools, admin-configured MCP
  servers, read-only tools and edits inside the workspace, and sandboxed shell commands. Everything else asks in
  the thread. With `SANDBOX_ENABLED=false`, **every** shell command asks. `PERMISSION_MODE=auto` uses Claude
  Code's auto-mode classifier instead.
- **Prompt injection:** message text is wrapped in `<discord_message>` elements that content can't forge, and
  Claude is told that messages, files and web pages are data, not instructions. That lowers the risk; it doesn't
  remove it. Keep dangerous connections scoped to the channels that need them.
- **Hosted pages** are served with `Content-Security-Policy: sandbox` under unguessable ids.

## Configuration reference

All settings are environment variables; see [`.env.example`](.env.example) for the full annotated list. The most
important:

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `AUTH_MODE` | — | Claude credential (see above) |
| `SECRET_KEY` | — | Encrypts secrets at rest (set it!) |
| `DEFAULT_MODEL` | `claude-opus-5` | Model for new sessions |
| `ALLOWED_MODELS` | `claude-opus-5,claude-sonnet-5,claude-haiku-4-5` | Models members can switch to |
| `CHANNEL_MODEL` / `CHANNEL_EFFORT` | default model / `low` | The always-on channel session |
| `TASK_EFFORT` | `high` | Effort for working sessions |
| `SANDBOX_ENABLED` | `true` | Sandbox shell commands |
| `PERMISSION_MODE` | `default` | `default` or `auto` |
| `SANDBOX_IDLE_MINUTES` | `5` | Release a thread's sandbox after this idle time |
| `STOP_READING_AFTER` | `100` | Top-level messages without Claude before it stops reading |
| `ENFORCE_SPEND_LIMITS` | `true` | Apply the server/channel caps |
| `PUBLIC_BASE_URL` / `HTTP_PORT` | — / `8787` | Hosted pages |
| `GITHUB_TOKEN` | — | Bot-side PR polling only (never given to Claude) |
| `DEV_GUILD_ID` | — | Register slash commands in one server instantly |
| `DATA_DIR` | `./data` | Database, workspaces, pages |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test          # vitest: scopes, memory rules, spend, search, permissions, sandbox, routines, formatting…
pnpm dev
```

Layout: `src/core` (config-free logic and SQLite), `src/agent` (sessions, prompts, tools, permissions, sandbox,
manager), `src/discord` (client, handlers, commands, slash commands, posting, context), `src/artifacts.ts`
(hosted pages), `src/index.ts`. [`docs/design.md`](docs/design.md) has the research notes and design decisions.

## License

MIT
