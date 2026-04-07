# Clerk

Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents.

Clerk manages multiple long-running Claude Code sessions, each with its own persona, memory, tools, and Telegram topic — all using your official Claude Pro/Max subscription.

## What Clerk Does

- **Scaffolds agent directories** from templates (persona, behavior, skills, memory)
- **Manages authentication** per agent via official Claude Code OAuth
- **Generates systemd + tmux units** for headless operation with interactive access
- **One bot per agent**: each agent runs the official Telegram plugin with its own bot token
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
- **Uses the official plugin**: `plugin:telegram@claude-plugins-official` — approved, no prompts
- **Independent lifecycle**: start, stop, restart agents independently
- **Simple .env**: each agent's `telegram/.env` has its own `TELEGRAM_BOT_TOKEN`

## Quick Start

### Prerequisites

- Linux with systemd (Ubuntu, Debian, Fedora, etc.)
- [Node.js 22+](https://nodejs.org)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code CLI](https://code.claude.com) (`npm install -g @anthropic-ai/claude-code`)
- Claude Pro or Max subscription
- [tmux](https://github.com/tmux/tmux) (`sudo apt install tmux`)
- One Telegram bot per agent ([create via @BotFather](https://t.me/BotFather))
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

For each bot, disable privacy mode so it can see all messages in the group:

```
/mybots -> select bot -> Bot Settings -> Group Privacy -> Turn off
```

Add all bots to your Telegram forum group as admins.

### Install and Setup

```bash
npm install -g clerk-ai
clerk setup
```

The interactive wizard walks you through: config file, bot tokens (one per agent), DM pairing, group detection, topic creation, agent scaffolding, and onboarding.

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
clerk init [--example <name>]       # Scaffold agents + install systemd units
clerk vault init                    # Create encrypted vault
clerk vault set <key>               # Store a secret
clerk vault get <key>               # Retrieve a secret
clerk vault list                    # List secret key names

# Authentication
clerk auth login <name|all>         # Show onboarding instructions for agent(s)
clerk auth status                   # Token status for all agents
clerk auth refresh <name>           # Show instructions to refresh tokens

# Agent lifecycle
clerk agent list                    # Status of all agents
clerk agent create <name>           # Scaffold + install one agent
clerk agent start <name|all>        # Start agent(s)
clerk agent stop <name|all>         # Stop agent(s)
clerk agent restart <name|all>      # Restart agent(s)
clerk agent attach <name>           # Interactive tmux session
clerk agent logs <name> [-f]        # View/follow logs
clerk agent destroy <name> [-y]     # Remove agent (with confirmation)

# Telegram
clerk topics sync                   # Create forum topics from config
clerk topics list                   # Show topic-to-agent mapping

# Memory (Hindsight)
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

Docker Compose support is planned. For now, use the host-native systemd + tmux approach.

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
