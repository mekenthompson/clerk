# Clerk

Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents.

Clerk manages multiple long-running Claude Code sessions, each with its own persona, memory, tools, and Telegram topic — all using your official Claude Pro/Max subscription.

## Recommended Setup (Best Practice)

Clerk is designed to run **24/7 on a small Linux server** that you talk to from Telegram. This is the path we recommend for almost everyone — it has the fewest moving parts and the most reliable behavior.

### Hardware

- **A small Ubuntu 24.04 LTS server** with 4 GB RAM and 20 GB disk. Hetzner CX22 (€4/mo), DigitalOcean $6 droplet, or a spare home server all work.
- **Ubuntu 24.04 LTS is the only fully supported target.** Other systemd-based distros (Debian, Fedora) usually work but are not part of the test matrix.
- **Not your laptop.** Agents need to be online when you're not. Putting them on a sleeping laptop defeats the point.
- **Single user account with sudo.** Run everything as one regular user (not root). Clerk uses systemd *user* services so it never needs root for daily life.

### One-time install

```bash
# 1. Install dependencies (Ubuntu 24.04)
sudo apt update && sudo apt install -y tmux expect docker.io
curl -fsSL https://bun.sh/install | bash         # Bun
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && \
  source ~/.bashrc && nvm install 22             # Node 22 via nvm
npm install -g @anthropic-ai/claude-code         # Claude Code CLI
sudo usermod -aG docker $USER && newgrp docker   # Docker without sudo

# 2. Install Clerk
git clone https://github.com/mekenthompson/clerk.git ~/code/clerk
cd ~/code/clerk && bun install && bun link

# 3. Run the interactive setup wizard
clerk setup
```

`clerk setup` walks you through everything: Telegram pairing, Claude OAuth, vault creation, Hindsight memory, scaffolding a default `assistant` agent, and starting it as a systemd user service.

### Daily life

Once set up, you don't touch the server. You talk to your agent from Telegram:

- Send messages in the agent's forum topic — it replies
- `/agents`, `/auth`, `/memory <query>` for management
- Agents auto-restart on reboot, auto-recall memory, and auto-update when you redeploy

### When something looks broken

```bash
clerk doctor         # Diagnoses dependencies, vault, hindsight, MCP wireup, services
clerk agent logs assistant -f
systemctl --user status clerk-assistant
```

### When you change `clerk.yaml`

```bash
clerk agent reconcile all --restart
```

This re-applies your config to existing agents (rewriting `.mcp.json` and `settings.json` without touching `CLAUDE.md` or `SOUL.md`) and restarts them. Use this whenever you add a new MCP server, enable memory, change the tool allowlist, etc. — never edit the agent's generated files by hand.

### What we deliberately avoid

- **Anything other than Ubuntu 24.04 LTS for production.** Other distros may work but aren't tested. Don't run agents on macOS or a laptop you sleep.
- **Sharing one Telegram bot token across agents.** Telegram's long-poll lock means messages get dropped at random. One bot per agent, always.
- **Running as root or via Docker-in-Docker.** Clerk's agents are systemd *user* units. Hindsight is the only Docker container we run, and only because the upstream image bundles Postgres.
- **Hand-editing files in `~/.clerk/agents/<name>/`.** Use `clerk agent reconcile` instead. Anything you edit in `clerk.yaml` is the source of truth.

If your situation rules out the recommended path (you're on macOS, you only have a laptop, you want to use Ollama instead of OpenAI for embeddings, etc.), the rest of this README covers the manual flags and lower-level commands. But if you can take the recommended path, take it — every gotcha we know about is already paved over by the wizard.

---

## What Clerk Does

- **Scaffolds agent directories** from templates (persona, behavior, skills, memory)
- **Manages authentication** per agent via official Claude Code OAuth
- **Generates systemd + tmux units** for headless operation with interactive access
- **One bot per agent**: each agent runs a Telegram plugin with its own bot token
- **Two Telegram channel modes**:
  - **Official plugin** (default): `plugin:telegram@claude-plugins-official`
  - **Clerk enhanced plugin** (`use_clerk_plugin: true`): forked Telegram plugin with HTML formatting, smart chunking, message coalescing, bot commands, and pre-approved MCP tools. Loaded as a development channel via `.mcp.json` with an `expect`-based auto-accept wrapper for the interactive confirmation prompts.
- **Integrates Hindsight** for per-agent semantic memory with knowledge graphs
- **Encrypts secrets** via AES-256-GCM vault
- **Provides a CLI and web dashboard** for lifecycle management

## What Clerk Is NOT

Clerk is **not a harness or wrapper**. It never intercepts Claude's authentication or inference. Each agent is a real Claude Code session, officially authenticated with your subscription. Clerk is scaffolding and lifecycle management.

### Anthropic Compliance

Clerk is designed to work within Anthropic's published guidelines:

- **Not a third-party harness**: Clerk never routes subscription credentials or inference requests. Each agent runs the unmodified `claude` CLI binary and authenticates directly with Anthropic via Claude Code's own OAuth flow.
- **Uses the official Telegram plugin**: Each agent uses `claude --channels plugin:telegram@claude-plugins-official` — Anthropic's own approved marketplace plugin. No custom channel, no daemon.
- **No credential interception**: Authentication is handled entirely by Claude Code. Clerk never touches access tokens, refresh tokens, or OAuth flows.

For full compliance analysis with citations and evidence, see [docs/compliance-attestation.md](docs/compliance-attestation.md).

## Architecture: One Bot Per Agent

Each agent gets its own Telegram bot. This is the simplest, most reliable architecture:

```
Telegram Forum Group
┌──────────┬────────────┬────────────┐
│ Fitness  │ Executive  │  General   │
│ Topic    │  Topic     │  Topic     │
└────┬─────┴──────┬─────┴──────┬─────┘
     │            │            │
     ▼            ▼            ▼
  @CoachBot    @ExecBot    @AssistBot
     │            │            │
  claude        claude       claude
  --channels    --channels   --channels
  plugin:tg     plugin:tg    plugin:tg
  systemd       systemd      systemd
  + tmux        + tmux       + tmux
```

Why one bot per agent:
- **No routing complexity**: each bot only sees messages in the group (privacy mode off)
- **Required by Telegram**: `getUpdates` holds an exclusive long-poll lock per token — two processes on the same token drop messages
- **Independent lifecycle**: start, stop, restart agents independently
- **Simple .env**: each agent's `telegram/.env` has its own `TELEGRAM_BOT_TOKEN`

### Two Channel Modes

Clerk supports two Telegram channel implementations per agent:

| Mode | Flag | How it launches | Best for |
|------|------|-----------------|----------|
| **Official plugin** | default | `claude --channels plugin:telegram@claude-plugins-official` | Simplicity, Anthropic-approved marketplace plugin, minimal dependencies |
| **Clerk enhanced plugin** | `use_clerk_plugin: true` | `claude --dangerously-load-development-channels server:clerk-telegram` (via `.mcp.json`) | HTML formatting, smart chunking, message coalescing, bot commands, pre-approved MCP permissions |

The enhanced plugin lives in `telegram-plugin/` as a forked MCP server. It requires:

- `expect` installed (`apt install expect`) — used by `bin/autoaccept.exp` to answer Claude Code's interactive dev-channel confirmation prompts
- A per-agent `.mcp.json` (Clerk writes this automatically) pointing at the plugin entry point with `TELEGRAM_STATE_DIR`, `CLERK_CONFIG`, and `CLERK_CLI_PATH` in its env

## Quick Start

### Prerequisites

- **Ubuntu 24.04 LTS** (the only fully supported target)
- [Node.js 22+](https://nodejs.org) — install via `nvm` so start.sh can source it
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code CLI](https://code.claude.com) (`npm install -g @anthropic-ai/claude-code`)
- Claude Pro or Max subscription
- [tmux](https://github.com/tmux/tmux) (`sudo apt install tmux`)
- [expect](https://core.tcl-lang.org/expect) (`sudo apt install expect`) — only required when `use_clerk_plugin: true`
- One Telegram bot **per agent** ([create via @BotFather](https://t.me/BotFather)) — each bot's long-poller holds an exclusive lock, so sharing a token between agents does not work
- A Telegram group with forum/topics enabled

### Create Bots via @BotFather

For each agent, create a bot:

```
/newbot
Name: Clerk Coach
Username: clerk_coach_bot

/newbot
Name: Clerk Exec
Username: clerk_exec_bot

/newbot
Name: Clerk Assistant
Username: clerk_assistant_bot
```

For each bot, disable privacy mode so it can see all messages in the group. **Do this BEFORE adding the bot to the group** — Telegram caches the privacy state per membership, so changing it after the bot joins does not take effect until you remove and re-add the bot.

```
/mybots -> select bot -> Bot Settings -> Group Privacy -> Turn off
```

If you already added the bot and then flipped privacy mode, remove the bot from the group and re-add it.

Add all bots to your Telegram forum group as admins.

## Onboarding Lessons

A few gotchas that trip people up during first-time setup:

1. **Telegram privacy mode must be OFF before adding the bot to the group.** Telegram caches the privacy state per-membership; flipping it after the fact does nothing until you kick and re-add the bot.
2. **One bot token per agent.** Telegram's long-poll API holds an exclusive lock on `getUpdates`. Two processes sharing a token will drop messages at random. Create a separate bot per agent.
3. **`tools.allow: [all]` is translated, not literal.** Claude Code rejects `"allow": ["all"]` as an invalid permission entry. Clerk writes `"defaultMode": "acceptEdits"` with an empty allow list instead — equivalent behavior, valid schema.
4. **`start.sh` sources nvm.** Systemd user services inherit a minimal `PATH`, so `node` is not found unless `start.sh` sources `~/.nvm/nvm.sh`. Clerk's generated script does this automatically.
5. **TIOCSTI keystroke injection is disabled on modern Linux.** Ubuntu 24.04+ and most hardened kernels block `TIOCSTI` by default. For `use_clerk_plugin: true` mode, Clerk uses an `expect` script (`bin/autoaccept.exp`) to answer the interactive dev-channel prompts. Install `expect` via `apt install expect`.
6. **Dev channels read from `.mcp.json`, not `settings.json`.** When launching with `--dangerously-load-development-channels server:NAME`, Claude Code resolves the MCP server command from a project-level `.mcp.json` in the working directory. Clerk writes this automatically when `use_clerk_plugin: true`.
7. **MCP tool permissions are pre-approved.** In `use_clerk_plugin` mode, Clerk pre-populates `permissions.allow` with all `mcp__clerk-telegram__*` tool names so the agent never blocks on a permission prompt at runtime.
8. **Manual OAuth is missing `subscriptionType`.** `claude auth login` (the official path) calls Anthropic's profile/me endpoint after token exchange and writes `subscriptionType` + `rateLimitTier` into `.credentials.json`. If you hand-craft credentials, you may need to add these fields yourself. Clerk does not hardcode `"max"` — use whatever the API returns.

### Install and Setup

```bash
git clone https://github.com/mekenthompson/clerk.git ~/code/clerk
cd ~/code/clerk && bun install && bun link
clerk setup
```

The interactive wizard walks you through: config file, bot tokens (one per agent), DM pairing, group detection, topic creation, memory setup, agent scaffolding, and onboarding.

#### Memory (Hindsight)

`clerk setup` automatically starts a [Hindsight](https://github.com/vectorize-io/hindsight) Docker container for semantic memory. This gives every agent persistent memory with knowledge graphs, semantic search, and cross-agent reflection.

- **MCP endpoint**: `http://127.0.0.1:8888/mcp/` by default (Streamable HTTP transport)
- **Auto-port-detection**: if 8888 is already taken (Coolify, another service, etc.), Clerk falls back to 18888 automatically and writes the chosen URL into `clerk.yaml` under `memory.config.url`
- **Web UI**: `http://127.0.0.1:9999` (or 19999)
- **Requires**: An OpenAI API key (or Anthropic/Ollama) for LLM-powered memory features. The setup wizard will prompt for this. If `CLERK_VAULT_PASSPHRASE` is set and you've stored `openai-api-key` in the vault, `clerk memory setup` will pull from the vault automatically.
- **Apply to existing agents**: after `clerk memory setup` updates `clerk.yaml`, run `clerk agent reconcile all --restart` so the running agents pick up the new MCP wireup.

Requirements: Docker must be installed. The setup wizard will check for Docker and start the `clerk-hindsight` container automatically.

To manage Hindsight separately:

```bash
clerk memory setup            # Start the Hindsight container
clerk memory setup --status   # Check container status
clerk memory setup --stop     # Stop and remove the container
clerk memory docker-compose   # Output a docker-compose snippet
```

For non-interactive / CI usage:

```bash
TELEGRAM_BOT_TOKEN=your-token USER_ID=12345 clerk setup --non-interactive --config clerk.yaml
```

### Manual Setup (Advanced)

If you prefer to set up each step manually:

#### 1. Create your config

```bash
clerk init --example clerk
```

This copies an example `clerk.yaml` into your current directory. Edit it to set your bot tokens and forum_chat_id:

```bash
$EDITOR clerk.yaml
```

#### 2. Set up secrets

```bash
# Create an encrypted vault for sensitive values
clerk vault init

# Store bot tokens
clerk vault set coach-bot-token
clerk vault set exec-bot-token
clerk vault set assistant-bot-token
```

#### 3. Create Telegram forum topics

```bash
export TELEGRAM_BOT_TOKEN=your-first-bot-token
clerk topics sync
```

#### 4. Initialize and start

```bash
clerk init
clerk agent start coach
```

#### 5. Complete Claude Code onboarding (once per agent)

```bash
clerk agent attach coach
# Select theme, log in (browser OAuth), trust the project
# Detach: Ctrl+B, then D
```

Repeat for each agent.

### Interacting with agents

- **Send a message** in a Telegram forum topic — the assigned bot/agent responds
- **Attach to a session**: `clerk agent attach coach` (tmux, Ctrl+B D to detach)
- **View logs**: `clerk agent logs coach -f`
- **Web dashboard**: `clerk web` then open http://localhost:8080
- **Check auth**: `clerk auth status`

## Configuration

Everything is defined in one file:

```yaml
# clerk.yaml
clerk:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"   # Default fallback
  forum_chat_id: "-1001234567890"

agents:
  coach:
    bot_token: "vault:coach-bot-token"     # Per-agent bot token
    template: health-coach
    topic_name: "Fitness"
    topic_emoji: "🏋️"
    soul:
      name: Coach
      style: motivational, direct
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]
    memory:
      collection: fitness

  exec-assistant:
    bot_token: "vault:exec-bot-token"
    template: executive-assistant
    topic_name: "Executive"
    topic_emoji: "📋"
    tools:
      allow: [calendar, notion, web-search, hindsight]
      deny: [bash, edit, write]

  assistant:
    bot_token: "vault:assistant-bot-token"
    template: default
    topic_name: "General"
    topic_emoji: "💬"
    tools:
      allow: [all]
```

If `bot_token` is omitted from an agent, it falls back to the global `telegram.bot_token`.

Add a new agent: add a few lines to `clerk.yaml`, create a bot via @BotFather, run `clerk agent create <name>`, authenticate, start.

## CLI Reference

```bash
# Setup
clerk setup                         # Interactive wizard (recommended path)
clerk doctor [--json]               # Health check: deps, vault, memory, MCP, services
clerk update [--check] [--no-restart]
                                    # Pull latest source, reinstall deps, reconcile + restart
clerk init [--example <name>]       # Scaffold agents + install systemd units
clerk vault init                    # Create encrypted vault
clerk vault set <key>               # Store a secret
clerk vault get <key>               # Retrieve a secret
clerk vault remove <key>            # Delete a secret
clerk vault list                    # List secret key names

# Authentication
clerk auth login <name>             # Show onboarding instructions for an agent
clerk auth status [--json]          # Token status for all agents
clerk auth refresh <name>           # Show instructions to refresh tokens

# Agent lifecycle
clerk agent list [--json]           # Status of all agents
clerk agent create <name>           # Scaffold + install one agent
clerk agent reconcile <name|all> [--restart]
                                    # Re-apply clerk.yaml to existing agent(s)
clerk agent start <name|all>        # Start agent(s)
clerk agent stop <name|all>         # Stop agent(s)
clerk agent restart <name|all>      # Restart agent(s)
clerk agent attach <name>           # Interactive tmux session
clerk agent logs <name> [-f]        # View/follow logs
clerk agent grant <name> <tool>     # Add a tool (or 'all') to tools.allow and reconcile
clerk agent dangerous <name>        # Enable full tool access (tools.allow: [all]) and reconcile
clerk agent permissions <name>      # Show current permissions.allow list
clerk agent destroy <name> [-y]     # Remove agent (with confirmation)

# Telegram
clerk topics sync                   # Create forum topics from config
clerk topics list                   # Show topic-to-agent mapping
clerk topics cleanup                # Close orphaned topics no longer in clerk.yaml

# Memory (Hindsight)
clerk memory setup                  # Start Hindsight Docker container
clerk memory setup --status         # Check container status
clerk memory setup --stop           # Stop and remove container
clerk memory docker-compose [--provider <openai|anthropic|ollama>]
                                    # Output docker-compose snippet
clerk memory search <query> [--agent <name>]
clerk memory stats                  # Per-agent collection info
clerk memory reflect                # Cross-agent synthesis plan

# Systemd
clerk systemd install               # Generate + enable all units
clerk systemd status                # Show all service statuses
clerk systemd uninstall             # Disable + remove units

# Dashboard
clerk web [--port 8080]             # Start web dashboard
```

All commands support `--config <path>` to specify a custom clerk.yaml location. Use `clerk <command> --help` for detailed options.

## Agent Personas

Each agent has a **SOUL.md** that defines its personality and a **CLAUDE.md** that defines its behavior, available tools, and interaction patterns.

## Templates

| Template | Description |
|----------|-------------|
| `default` | General-purpose assistant with all tools |
| `health-coach` | Fitness, nutrition, sleep, and wellness coaching |
| `executive-assistant` | Calendar, tasks, briefings, and executive support |
| `coding` | Software engineering with full tool access |

Create your own templates in `templates/<name>/` with `CLAUDE.md.hbs`, `SOUL.md.hbs`, and optional `skills/`.

## Memory

Clerk integrates [Hindsight](https://github.com/vectorize-io/hindsight) for semantic memory:

- Per-agent memory collections (isolated by default)
- 4-strategy retrieval: semantic + BM25 + entity graph + temporal
- Cross-encoder reranking
- Knowledge graph with entity resolution
- Auto-updating mental models
- Optional cross-agent synthesis via `clerk memory reflect`

Set `isolation: strict` on any agent to prevent its memories from being included in cross-agent reflection.

## Security

- **Encrypted vault**: AES-256-GCM with scrypt key derivation for secrets
- **File permissions**: Sensitive files (.env, credentials, settings) created with mode 0600
- **Agent name validation**: Strict regex prevents command injection
- **Path traversal protection**: Template and config paths are contained
- **Web dashboard**: Binds to localhost only, optional bearer token auth via `CLERK_WEB_TOKEN`
- **No credential interception**: Each agent authenticates directly with Claude Code OAuth

## Clerk MCP Server

Each agent automatically gets a clerk management MCP server configured during scaffolding. This provides 8 tools that agents can call without needing Bash access:

- `clerk_agent_list`, `clerk_agent_start`, `clerk_agent_stop`, `clerk_agent_restart`
- `clerk_auth_status`, `clerk_topics_list`
- `clerk_memory_search`, `clerk_memory_stats`

This means agents with restricted tools (`deny: [bash]`) can still manage other agents.

## In-Session Skill

The `/clerk` skill provides an alternative management interface within conversations:

```
/clerk agents          # List all agents
/clerk start coding    # Start the coding agent
/clerk memory "topic"  # Search memories
```

## Session Optimization

Long-running agents benefit from careful context management. See [docs/session-optimization.md](docs/session-optimization.md) for guidance on:

- Keeping SOUL.md and CLAUDE.md concise (under 500 and 800 words)
- Using Hindsight auto-recall to restore context after compaction
- Scheduling daily session resets for fresh context
- Minimizing tool count per agent to save token budget
- Proactive memory saves before compaction occurs

## Docker Support

Hindsight memory runs in Docker automatically via `clerk setup`. The container (`clerk-hindsight`) is started with `--restart unless-stopped` so it persists across reboots. Data is stored in the `clerk-hindsight-data` Docker volume.

For docker-compose users, generate a snippet with:

```bash
clerk memory docker-compose
clerk memory docker-compose --provider openai
```

Agent processes themselves use the host-native systemd + tmux approach.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
