# Clerk Compliance Attestation

## Summary

Clerk is a multi-agent orchestration tool for Claude Code. This document provides a point-in-time attestation that Clerk's architecture is designed to comply with Anthropic's terms of service and usage policies for Claude Code.

**Attestation date:** 2026-04-07T13:00:00Z
**Model used for analysis:** Claude Opus 4.6 (1M context)
**Reviewed against:** Anthropic's published documentation and policies as of April 7, 2026

---

## What Clerk Is

Clerk is scaffolding and lifecycle management for multiple Claude Code sessions. It:

1. Creates directory structures and configuration files for each agent
2. Generates systemd units to keep agents running
3. Assigns one Telegram bot per agent, each using the official Telegram plugin
4. Provides a CLI for managing agent lifecycle (start, stop, restart, logs)
5. Manages an encrypted vault for secrets

## What Clerk Is NOT

Clerk does **not**:

- Intercept, proxy, or modify Claude's inference requests or responses
- Handle, proxy, or intercept Claude Code's OAuth authentication
- Replace Claude Code's runtime — each agent IS a real `claude` CLI session
- Use the Anthropic Agent SDK or direct API access
- Route subscription credentials through any intermediary
- Modify Claude Code's binary or internal behavior

---

## Compliance Analysis

### 1. Clerk Is Not a Third-Party Harness

**Anthropic's policy (as of April 4, 2026):** Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Third-party harnesses that use Claude subscriptions to power their own products are prohibited.

**Source:** [Anthropic clarifies ban on third-party tool access to Claude](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/); [Legal and compliance - Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance)

**Clerk's compliance:** Clerk does not route requests through subscription credentials. Each Claude Code agent session:
- Runs the official `claude` CLI binary directly
- Authenticates via Claude Code's own OAuth flow (the user completes this in the terminal)
- Maintains its own `.credentials.json` managed entirely by Claude Code
- Makes inference requests directly to Anthropic's servers via Claude Code's built-in client

Clerk never touches, reads, or proxies the access token, refresh token, or any authentication credential used for inference. The authentication relationship is directly between the user's Claude Code session and Anthropic.

### 2. Uses the Official Telegram Plugin

**Anthropic's documentation:** Claude Code supports an official plugin marketplace including a Telegram channel plugin. The `--channels plugin:telegram@claude-plugins-official` flag loads the approved, published Telegram plugin.

**Source:** [Plugins - Claude Code Docs](https://code.claude.com/docs/en/plugins); [Channels - Claude Code Docs](https://code.claude.com/docs/en/channels)

**Clerk's compliance:** Each agent uses `claude --channels plugin:telegram@claude-plugins-official` — the official, Anthropic-approved Telegram plugin from the marketplace. Clerk does not use a custom or forked channel. Each agent:
- Gets its own Telegram bot token in `telegram/.env`
- Uses the official plugin's access.json format for group configuration
- Runs the plugin exactly as Anthropic intended, with no modifications

### 4. MCP Servers Are Explicitly Supported

**Anthropic's documentation:** "Claude Code supports the Model Context Protocol (MCP) for connecting to external tools and data sources."

**Source:** [Connect Claude Code to tools via MCP - Claude Code Docs](https://code.claude.com/docs/en/mcp)

**Clerk's compliance:** Both the clerk-channel plugin and the clerk-mcp management server are standard MCP servers. They use the official `@modelcontextprotocol/sdk` package and follow the documented MCP protocol.

### 5. systemd/tmux Process Management Is Standard Operations

**Anthropic's documentation:** "For an always-on setup you run Claude in a background process or persistent terminal." The Telegram channel documentation specifically notes using persistent terminals.

**Source:** [Channels - Claude Code Docs](https://code.claude.com/docs/en/channels)

**Clerk's compliance:** Clerk generates systemd user units that keep Claude Code sessions running. This is standard Linux process management — the same as running Claude Code in tmux, screen, or any other process supervisor. Anthropic explicitly acknowledges this use case in their channels documentation.

### 6. No Modification of Claude Code

Clerk does not:
- Patch, modify, or replace the `claude` binary
- Inject code into Claude Code's runtime
- Override Claude Code's internal behavior
- Bypass Claude Code's permission system (unless the user explicitly opts in via `dangerous_mode` config)

Each agent runs an unmodified `claude` CLI session with standard command-line flags.

---

## Architecture Evidence

### Each agent is a real Claude Code session:
```
ExecStart=/usr/bin/script -qfc "/bin/bash -l {agentDir}/start.sh" {logFile}
```

### start.sh runs the official claude CLI with the official Telegram plugin:
```bash
exec claude --channels plugin:telegram@claude-plugins-official
```

### Each agent has its own bot token:
```
# telegram/.env
TELEGRAM_BOT_TOKEN=<agent-specific-token>
```

### Message flow (per agent):
```
User → Telegram API → Official Telegram Plugin → Claude Code
Claude Code → Official Telegram Plugin → Telegram API → User
```

At no point does any Clerk component sit between Claude Code and Anthropic's inference API. There is no daemon or router — each agent's official plugin polls Telegram independently.

---

## Referenced Anthropic Documentation

| Document | URL | Accessed |
|----------|-----|----------|
| Channels | https://code.claude.com/docs/en/channels | 2026-04-07 |
| Channels Reference | https://code.claude.com/docs/en/channels-reference | 2026-04-07 |
| Legal and Compliance | https://code.claude.com/docs/en/legal-and-compliance | 2026-04-07 |
| MCP | https://code.claude.com/docs/en/mcp | 2026-04-07 |
| Plugins | https://code.claude.com/docs/en/plugins | 2026-04-07 |

## Limitations of This Attestation

- This attestation reflects Anthropic's published documentation and policies as of April 7, 2026
- Anthropic may change their terms of service, usage policies, or technical requirements at any time
- This analysis was performed by an AI model (Claude Opus 4.6) and should be reviewed by legal counsel for formal compliance verification

## Recommendation

Users and organizations deploying Clerk should:
1. Review Anthropic's current terms of service before deployment
2. Monitor Anthropic's policy updates for changes affecting plugins or multi-agent usage
3. Consult legal counsel if compliance is critical to their use case
