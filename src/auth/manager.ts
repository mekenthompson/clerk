import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { ClerkConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";

export interface AuthStatus {
  authenticated: boolean;
  subscriptionType?: string;
  expiresAt?: number;
  timeUntilExpiry?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

// Claude Code OAuth constants (from source analysis)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64url(randomBytes(32));
}

function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(
  authCode: string,
  codeVerifier: string,
  state: string,
): Promise<CredentialsFile> {
  const body = JSON.stringify({
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    claudeAiOauth: {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 28800) * 1000,
      scopes: ((data.scope as string) ?? SCOPES.join(" ")).split(" "),
      subscriptionType: (data.subscription_type as string) ?? undefined,
      rateLimitTier: (data.rate_limit_tier as string) ?? undefined,
    },
  };
}

function promptForInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function extractCodeFromInput(input: string): string {
  // User may paste the full callback: "CODE#STATE" — extract just the code part
  const hashIndex = input.indexOf("#");
  if (hashIndex > 0) {
    return input.substring(0, hashIndex);
  }
  return input;
}

export function formatTimeUntilExpiry(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "expired";

  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function getAuthStatus(name: string, agentDir: string): AuthStatus {
  const credPath = resolve(agentDir, ".claude", ".credentials.json");

  if (!existsSync(credPath)) {
    return { authenticated: false };
  }

  let creds: CredentialsFile;
  try {
    creds = JSON.parse(readFileSync(credPath, "utf-8"));
  } catch {
    return { authenticated: false };
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { authenticated: false };
  }

  const expiresAt = oauth.expiresAt;
  const isExpired = expiresAt != null && expiresAt <= Date.now();

  return {
    authenticated: !isExpired,
    subscriptionType: oauth.subscriptionType,
    expiresAt: oauth.expiresAt,
    timeUntilExpiry:
      expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
    rateLimitTier: oauth.rateLimitTier,
  };
}

export function getAllAuthStatuses(
  config: ClerkConfig,
): Record<string, AuthStatus> {
  const agentsDir = resolveAgentsDir(config);
  const statuses: Record<string, AuthStatus> = {};

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    statuses[name] = getAuthStatus(name, agentDir);
  }

  return statuses;
}

/**
 * Generate an auth URL and persist the PKCE state so `completeLogin` can
 * finish the flow later (even from a different process).
 */
export function startLogin(
  name: string,
  agentDir: string,
): { authUrl: string; stateFile: string } {
  const claudeConfigDir = resolve(agentDir, ".claude");
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });

  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthUrl(challenge, state);

  // Persist PKCE verifier so completeLogin can use it
  const stateFile = resolve(claudeConfigDir, ".auth-pending.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ verifier, state, agentDir, name, createdAt: Date.now() }),
    { mode: 0o600 },
  );

  return { authUrl, stateFile };
}

/**
 * Complete the login using a code + the persisted PKCE state.
 */
export async function completeLogin(
  name: string,
  agentDir: string,
  rawCode: string,
): Promise<{ success: boolean; error?: string }> {
  const claudeConfigDir = resolve(agentDir, ".claude");
  const stateFile = resolve(claudeConfigDir, ".auth-pending.json");

  if (!existsSync(stateFile)) {
    return {
      success: false,
      error: "No pending auth found. Run 'clerk auth login' first.",
    };
  }

  let pending: { verifier: string; state: string };
  try {
    pending = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { success: false, error: "Corrupted auth state file" };
  }

  const code = extractCodeFromInput(rawCode);

  try {
    const creds = await exchangeCodeForTokens(code, pending.verifier, pending.state);
    const credPath = resolve(claudeConfigDir, ".credentials.json");
    writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

    // Ensure config.json exists for Claude Code
    const configPath = resolve(claudeConfigDir, "config.json");
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        JSON.stringify({ hasCompletedOnboarding: true }, null, 2),
        { mode: 0o600 },
      );
    }

    // Clean up pending state
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(stateFile);
    } catch { /* ignore */ }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Login an agent via OAuth PKCE flow (interactive).
 *
 * 1. Generates PKCE challenge + state (persisted to disk)
 * 2. Prints auth URL for user to open in browser
 * 3. Prompts user to paste the authorization code
 * 4. Exchanges code for tokens via POST to token endpoint
 * 5. Saves credentials to agent's .claude/.credentials.json
 */
export async function loginAgent(
  name: string,
  agentDir: string,
): Promise<{ success: boolean; error?: string }> {
  const { authUrl } = startLogin(name, agentDir);

  console.log(`\nOpen this URL in your browser to sign in:\n`);
  console.log(`  ${authUrl}\n`);

  const rawCode = await promptForInput(
    "Paste the authorization code from the page: ",
  );
  if (!rawCode) {
    return { success: false, error: "No code provided" };
  }

  return completeLogin(name, agentDir, rawCode);
}

export async function loginAllAgents(
  config: ClerkConfig,
): Promise<Record<string, { success: boolean; error?: string }>> {
  const agentsDir = resolveAgentsDir(config);
  const results: Record<string, { success: boolean; error?: string }> = {};

  for (const name of Object.keys(config.agents)) {
    console.log(`\n--- Authenticating agent: ${name} ---`);
    const agentDir = resolve(agentsDir, name);
    results[name] = await loginAgent(name, agentDir);
    if (results[name].success) {
      console.log(`  ✓ ${name} authenticated`);
    } else {
      console.log(`  ✗ ${name} failed: ${results[name].error}`);
    }
  }

  return results;
}

export async function refreshAgent(
  name: string,
  agentDir: string,
): Promise<{ success: boolean; error?: string }> {
  return loginAgent(name, agentDir);
}
