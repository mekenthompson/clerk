---
name: clerk-manage
description: Manage clerk agents from within a Claude Code session
---

# Clerk Agent Management

When the user invokes `/clerk` or asks to manage their clerk agents, use the Bash tool to run the appropriate `clerk` CLI command from the table below.

**Prerequisite:** The `clerk` CLI must be installed and available on PATH.

## Available Commands

| User says | Run |
|---|---|
| `/clerk agents` or `/clerk list` | `clerk agent list` |
| `/clerk start <name>` | `clerk agent start <name>` |
| `/clerk stop <name>` | `clerk agent stop <name>` |
| `/clerk restart <name>` | `clerk agent restart <name>` |
| `/clerk status` | `clerk auth status` |
| `/clerk memory <query>` | `clerk memory search "<query>"` |
| `/clerk memory <query> --agent <name>` | `clerk memory search "<query>" --agent <name>` |
| `/clerk vault list` | `clerk vault list` |
| `/clerk topics` | `clerk topics list` |

## Behavior

1. Run the matching `clerk` command using the Bash tool.
2. If the command fails with "command not found", tell the user that `clerk` is not installed or not on PATH and suggest running `npm install -g @anthropic/clerk` or checking their installation.
3. Format the output cleanly for the user. For list commands, present results as a table or bulleted list. For start/stop/restart, confirm the action taken.
4. If the user just types `/clerk` with no subcommand, show this help summary:

```
Clerk commands:
  /clerk agents         List all configured agents
  /clerk start <name>   Start an agent
  /clerk stop <name>    Stop an agent
  /clerk restart <name> Restart an agent
  /clerk status         Show auth status
  /clerk memory <query> Search agent memory
  /clerk vault list     List vault secrets
  /clerk topics         List Telegram topics
```
