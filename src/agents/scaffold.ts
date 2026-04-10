import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../config/schema.js";
import {
  getTemplatePath,
  getBaseTemplatePath,
  renderTemplate,
  copySkills,
} from "./templates.js";
import { getHindsightSettingsEntry, getClerkMcpSettingsEntry } from "../memory/scaffold-integration.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { loadTopicState } from "../telegram/state.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
  preTrustWorkspace,
  createMinimalClaudeConfig,
  loadUserConfig,
} from "../setup/onboarding.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
}

/**
 * Resolve a bot token value. If it's a vault reference, try to resolve it
 * via CLERK_VAULT_PASSPHRASE or fall back to TELEGRAM_BOT_TOKEN env var.
 * Returns the resolved token or undefined if unresolvable.
 */
function resolveBotToken(rawToken: string): string | undefined {
  if (!isVaultReference(rawToken)) {
    return rawToken;
  }

  // Try vault resolution via passphrase
  const passphrase = process.env.CLERK_VAULT_PASSPHRASE;
  if (passphrase) {
    try {
      const { openVault } = require("../vault/vault.js") as typeof import("../vault/vault.js");
      const { resolvePath } = require("../config/loader.js") as typeof import("../config/loader.js");
      const vaultPath = resolvePath(process.env.CLERK_VAULT_PATH ?? "~/.clerk/vault.enc");
      const secrets = openVault(passphrase, vaultPath);
      const key = parseVaultReference(rawToken);
      if (secrets[key]) {
        return secrets[key];
      }
    } catch { /* vault not available */ }
  }

  // Fall back to TELEGRAM_BOT_TOKEN env var
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  return undefined;
}

/**
 * Set up plugin symlinks and config files in the agent's CLAUDE_CONFIG_DIR.
 *
 * Symlinks the official Telegram plugin marketplace from the user's global
 * ~/.claude/plugins/ and copies plugin config files if they exist.
 */
export function setupPlugins(agentDir: string): void {
  const home = process.env.HOME ?? "/root";
  const globalPluginsDir = join(home, ".claude", "plugins");
  const agentPluginsDir = join(agentDir, ".claude", "plugins");
  const agentMarketplacesDir = join(agentPluginsDir, "marketplaces");

  // Create plugin directories
  mkdirSync(agentMarketplacesDir, { recursive: true });

  // Symlink the official marketplace
  const globalMarketplace = join(globalPluginsDir, "marketplaces", "claude-plugins-official");
  const agentMarketplace = join(agentMarketplacesDir, "claude-plugins-official");

  if (existsSync(globalMarketplace) && !existsSync(agentMarketplace)) {
    try {
      symlinkSync(globalMarketplace, agentMarketplace);
    } catch { /* symlink may fail if target doesn't exist */ }
  }

  // Copy plugin config files if they exist
  const configFiles = ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"];
  for (const file of configFiles) {
    const globalFile = join(globalPluginsDir, file);
    const agentFile = join(agentPluginsDir, file);
    if (existsSync(globalFile) && !existsSync(agentFile)) {
      try {
        copyFileSync(globalFile, agentFile);
      } catch { /* ignore copy failures */ }
    }
  }
}

/**
 * Pre-approved MCP tool names for the clerk enhanced Telegram plugin.
 * When use_clerk_plugin is enabled we pre-approve these so the agent
 * never has to prompt for MCP tool permissions.
 */
const CLERK_TELEGRAM_MCP_TOOLS = [
  "mcp__clerk-telegram",
  "mcp__clerk-telegram__reply",
  "mcp__clerk-telegram__react",
  "mcp__clerk-telegram__edit_message",
  "mcp__clerk-telegram__send_typing",
  "mcp__clerk-telegram__pin_message",
  "mcp__clerk-telegram__forward_message",
  "mcp__clerk-telegram__download_attachment",
];

/**
 * Pre-approved MCP tool names for the Hindsight memory server.
 * When the memory backend is hindsight we pre-approve the wildcard so
 * the agent can recall and store memories without prompting.
 */
const HINDSIGHT_MCP_TOOLS = [
  "mcp__hindsight",
  "mcp__hindsight__*",
];

/**
 * Attempt to locate the clerk CLI binary. Used to populate CLERK_CLI_PATH
 * in the .mcp.json env for the clerk-telegram MCP server. Falls back to
 * the literal string "clerk" if `which clerk` is unavailable.
 */
function resolveClerkCliPath(): string {
  try {
    const result = execSync("which clerk", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (result) {
      return result;
    }
  } catch {
    /* clerk not on PATH */
  }
  return "clerk";
}

/**
 * Scaffold (or reconcile) the directory structure for a single agent.
 *
 * Idempotent: creates missing files and directories but never overwrites
 * existing ones.
 */
export function scaffoldAgent(
  name: string,
  agentConfig: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  clerkConfig?: ClerkConfig,
  userIdOverride?: string,
  clerkConfigPath?: string,
): ScaffoldResult {
  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const templatePath = getTemplatePath(agentConfig.template);
  const basePath = getBaseTemplatePath();

  // Load user config for Telegram user ID
  const userConfig = loadUserConfig();
  const userId = userIdOverride ?? userConfig?.userId;

  // Resolve topic ID: config takes priority, then topics.json state file
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve bot token: per-agent token takes priority, then global telegram token
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);

  // Compute the effective permissions.allow list for settings.json.
  //
  // Special handling:
  //   - If the user writes `tools.allow: [all]`, Claude Code rejects the
  //     literal string "all" in the permissions.allow list. The correct
  //     equivalent is to use defaultMode: "acceptEdits" with an empty
  //     allow list.
  //   - If use_clerk_plugin is enabled, pre-approve the clerk-telegram
  //     MCP tool names so the agent never has to confirm MCP tool
  //     permissions at runtime.
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    ? []
    : rawAllow.filter((t) => t !== "all");
  const memoryBackend = clerkConfig?.memory?.backend;
  const hindsightEnabled = memoryBackend === "hindsight";
  const permissionAllow = [
    ...baseAllow,
    ...(agentConfig.use_clerk_plugin === true ? CLERK_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
  ];

  // Build the template rendering context
  const context: Record<string, unknown> = {
    name,
    agentDir,
    topicId,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    tools,
    permissionAllow,
    defaultModeAcceptEdits: hasAllWildcard,
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? rawBotToken,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    skipPermissionPrompt: agentConfig.skip_permission_prompt === true,
    useClerkPlugin: agentConfig.use_clerk_plugin === true,
  };

  // --- Create directory structure ---
  const dirs = [
    agentDir,
    join(agentDir, ".claude"),
    join(agentDir, "memory"),
    join(agentDir, "skills"),
    join(agentDir, "telegram"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Render and write base templates ---
  writeIfMissing(
    join(agentDir, "start.sh"),
    () => renderTemplate(join(basePath, "start.sh.hbs"), context),
    created,
    skipped,
  );
  // Make start.sh executable
  if (existsSync(join(agentDir, "start.sh"))) {
    chmodSync(join(agentDir, "start.sh"), 0o755);
  }

  writeIfMissing(
    join(agentDir, ".claude", "settings.json"),
    () => renderTemplate(join(basePath, "settings.json.hbs"), context),
    created,
    skipped,
    0o600,
  );

  // --- Merge MCP configs into settings.json ---
  if (clerkConfig) {
    const settingsPath = join(agentDir, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      // Hindsight memory MCP
      const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
      if (hindsightEntry && !settings.mcpServers[hindsightEntry.key]) {
        settings.mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }

      // Clerk management MCP
      const clerkMcpEntry = getClerkMcpSettingsEntry();
      if (!settings.mcpServers[clerkMcpEntry.key]) {
        settings.mcpServers[clerkMcpEntry.key] = clerkMcpEntry.value;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }
  }

  // --- Write project-level .mcp.json for clerk-telegram development channel ---
  //
  // When use_clerk_plugin is enabled, Claude Code's
  // `--dangerously-load-development-channels server:NAME` flag resolves
  // the MCP server definition from the project-level .mcp.json in the
  // working directory — NOT from settings.json mcpServers. Write it here
  // so the enhanced Telegram plugin can be launched as a dev channel.
  if (agentConfig.use_clerk_plugin === true) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    if (!existsSync(mcpJsonPath)) {
      const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
      const clerkCliPath = resolveClerkCliPath();
      const resolvedConfigPath = clerkConfigPath
        ? resolve(clerkConfigPath)
        : resolve(process.cwd(), "clerk.yaml");

      const mcpServers: Record<string, McpServerConfig> = {
        "clerk-telegram": {
          command: "bun",
          args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
          env: {
            TELEGRAM_STATE_DIR: join(agentDir, "telegram"),
            CLERK_CONFIG: resolvedConfigPath,
            CLERK_CLI_PATH: clerkCliPath,
          },
        },
      };

      // Add hindsight memory MCP if configured
      if (hindsightEnabled && clerkConfig) {
        const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
        if (hindsightEntry) {
          mcpServers[hindsightEntry.key] = hindsightEntry.value;
        }
      }

      const mcpJson = { mcpServers };

      writeFileSync(
        mcpJsonPath,
        JSON.stringify(mcpJson, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
      created.push(mcpJsonPath);
    }
  }

  // --- Render template-specific files ---
  const templateFiles: Array<{ src: string; dest: string }> = [
    { src: "CLAUDE.md.hbs", dest: "CLAUDE.md" },
    { src: "SOUL.md.hbs", dest: "SOUL.md" },
  ];

  for (const { src, dest } of templateFiles) {
    const srcPath = join(templatePath, src);
    if (existsSync(srcPath)) {
      writeIfMissing(
        join(agentDir, dest),
        () => renderTemplate(srcPath, context),
        created,
        skipped,
      );
    }
  }

  // --- Claude Code config (onboarding state) ---
  // Try to copy from existing Claude installation; fall back to minimal config
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    copyOnboardingState(existingClaudeJson, agentDir);
    copyExistingCredentials(agentDir);
    if (!existsSync(join(agentDir, ".claude", "config.json"))) {
      // copyOnboardingState didn't write (file existed), write default
      writeIfMissing(
        join(agentDir, ".claude", "config.json"),
        () =>
          JSON.stringify(
            { hasCompletedOnboarding: true, numStartups: 1 },
            null,
            2,
          ) + "\n",
        created,
        skipped,
        0o600,
      );
    }
  } else {
    // No existing Claude install — create minimal config
    createMinimalClaudeConfig(agentDir);
  }

  // Pre-trust the agent's workspace directory
  preTrustWorkspace(agentDir);

  // --- Memory index ---
  writeIfMissing(
    join(agentDir, "memory", "MEMORY.md"),
    () => "# Memory Index\n\nThis file is auto-maintained. Do not edit manually.\n",
    created,
    skipped,
  );

  // --- Telegram .env ---
  writeIfMissing(
    join(agentDir, "telegram", ".env"),
    () => {
      if (resolvedBotToken) {
        return `TELEGRAM_BOT_TOKEN=${resolvedBotToken}\n`;
      }
      return `# Set your bot token: TELEGRAM_BOT_TOKEN=your-token-here\n`;
    },
    created,
    skipped,
    0o600,
  );

  // --- Telegram access.json ---
  writeIfMissing(
    join(agentDir, "telegram", "access.json"),
    () => buildAccessJson(agentConfig, telegramConfig, topicId, userId),
    created,
    skipped,
    0o600,
  );

  // --- Copy skill files from template ---
  copySkills(templatePath, join(agentDir, "skills"));

  // --- Set up plugin symlinks ---
  setupPlugins(agentDir);

  return { agentDir, created, skipped };
}

/**
 * Write a file only if it doesn't already exist.
 * Tracks what was created vs skipped for reporting.
 */
function writeIfMissing(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, contentFn(), mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  created.push(filePath);
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  resolvedTopicId?: number,
  userId?: string,
): string {
  const allowFrom = userId ? [userId] : [];
  if (allowFrom.length === 0) {
    console.warn(
      "  WARNING: No user ID available for access.json allowFrom. " +
      "DM the bot /start and run `clerk setup` again to pair your Telegram account."
    );
  }
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom,
    groups: {
      [telegramConfig.forum_chat_id]: {
        requireMention: false,
        allowFrom,
      },
    },
  };
  return JSON.stringify(access, null, 2) + "\n";
}
