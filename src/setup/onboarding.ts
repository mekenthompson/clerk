import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Search for an existing .claude.json (onboarding state) from the user's
 * personal Claude installation. Returns the path if found, null otherwise.
 */
export function findExistingClaudeJson(): string | null {
  const home = process.env.HOME ?? "/root";

  const candidates = [
    resolve(home, ".claude-home", ".claude.json"),
    resolve(home, ".claude", ".claude.json"),
    resolve(home, ".claude-home", "config.json"),
    resolve(home, ".claude", "config.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Copy onboarding state (.claude.json or config.json) to the agent's
 * CLAUDE_CONFIG_DIR so it skips the onboarding wizard.
 */
export function copyOnboardingState(
  sourcePath: string,
  agentDir: string,
): void {
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const destPath = join(claudeDir, "config.json");
  if (!existsSync(destPath)) {
    copyFileSync(sourcePath, destPath);
  }
}

/**
 * Build an access.json for an agent's telegram directory.
 * Uses the official Telegram plugin format with dmPolicy, allowFrom,
 * and groups sections.
 */
export function buildAccessJson(
  userId: string,
  forumChatId: string,
  topicId?: number,
): string {
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom: [userId],
    groups: {
      [forumChatId]: {
        requireMention: false,
        allowFrom: [],
      },
    },
  };

  return JSON.stringify(access, null, 2) + "\n";
}

/**
 * Try to copy .credentials.json from an existing Claude installation
 * to the agent's CLAUDE_CONFIG_DIR.
 */
export function copyExistingCredentials(agentDir: string): boolean {
  const home = process.env.HOME ?? "/root";
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const candidates = [
    resolve(home, ".claude-home", ".credentials.json"),
    resolve(home, ".claude", ".credentials.json"),
  ];

  const destPath = join(claudeDir, ".credentials.json");
  if (existsSync(destPath)) {
    return true; // Already has credentials
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        copyFileSync(candidate, destPath);
        return true;
      } catch {
        // Continue trying other candidates
      }
    }
  }

  return false;
}

/**
 * Write the access.json file for an agent.
 */
export function writeAccessJson(
  agentDir: string,
  userId: string,
  forumChatId: string,
  topicId?: number,
): void {
  const telegramDir = join(agentDir, "telegram");
  mkdirSync(telegramDir, { recursive: true });

  const accessPath = join(telegramDir, "access.json");
  writeFileSync(accessPath, buildAccessJson(userId, forumChatId, topicId), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Build and write the daemon-access.json file that the clerk-telegram-daemon
 * uses for access control. Combines allowFrom from all agents and groups.
 */
export function writeDaemonAccessJson(
  userId: string,
  forumChatId: string,
): void {
  const home = process.env.HOME ?? "/root";
  const clerkDir = join(home, ".clerk");
  mkdirSync(clerkDir, { recursive: true });

  const access = {
    allowFrom: [userId],
    groups: {
      [forumChatId]: {
        requireMention: false,
        allowFrom: [userId],
      },
    },
  };

  const accessPath = join(clerkDir, "daemon-access.json");
  writeFileSync(accessPath, JSON.stringify(access, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Write the daemon.env template file if it doesn't exist.
 */
export function writeDaemonEnv(botToken: string): void {
  const home = process.env.HOME ?? "/root";
  const clerkDir = join(home, ".clerk");
  mkdirSync(clerkDir, { recursive: true });

  const envPath = join(clerkDir, "daemon.env");
  if (existsSync(envPath)) return; // Don't overwrite existing config

  const content = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `CLERK_SOCKET_PATH=/tmp/clerk-telegram.sock`,
    `CLERK_ACCESS_PATH=${join(clerkDir, "daemon-access.json")}`,
    `CLERK_INBOX_PATH=${join(clerkDir, "inbox")}`,
    "",
  ].join("\n");

  writeFileSync(envPath, content, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Write the .env file with the bot token for an agent.
 */
export function writeAgentEnv(agentDir: string, botToken: string): void {
  const telegramDir = join(agentDir, "telegram");
  mkdirSync(telegramDir, { recursive: true });

  const envPath = join(telegramDir, ".env");
  writeFileSync(envPath, `TELEGRAM_BOT_TOKEN=${botToken}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}
