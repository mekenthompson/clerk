import { execSync } from "node:child_process";

/**
 * Check if Docker is available on the system.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the clerk-hindsight container is currently running.
 */
export function isHindsightRunning(): boolean {
  try {
    const output = execSync(
      'docker ps --filter name=clerk-hindsight --format "{{.Status}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the clerk-hindsight container exists (running or stopped).
 */
export function isHindsightContainerExists(): boolean {
  try {
    const output = execSync(
      'docker ps -a --filter name=clerk-hindsight --format "{{.Names}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the Hindsight Docker container.
 *
 * @param provider - Optional LLM provider (e.g., "ollama", "openai", "anthropic")
 */
export function startHindsight(provider?: string, apiKey?: string): void {
  const envArgs: string[] = [];
  if (provider) envArgs.push("-e", `LLM_PROVIDER=${provider}`);
  if (apiKey) envArgs.push("-e", `HINDSIGHT_API_LLM_API_KEY=${apiKey}`);
  const args = [
    "run", "-d",
    "--name", "clerk-hindsight",
    "--restart", "unless-stopped",
    "-p", "8888:8888",
    "-p", "9999:9999",
    "-v", "clerk-hindsight-data:/home/hindsight/.pg0",
    ...envArgs,
    "ghcr.io/vectorize-io/hindsight:latest",
  ];

  execSync(`docker ${args.join(" ")}`, { stdio: "pipe" });
}

/**
 * Stop and remove the Hindsight Docker container.
 */
export function stopHindsight(): void {
  try {
    execSync("docker stop clerk-hindsight", { stdio: "pipe" });
  } catch { /* container may already be stopped */ }
  try {
    execSync("docker rm clerk-hindsight", { stdio: "pipe" });
  } catch { /* container may already be removed */ }
}

/**
 * Get the status of the Hindsight Docker container.
 * Returns a human-readable status string, or null if not found.
 */
export function getHindsightStatus(): string | null {
  try {
    const output = execSync(
      'docker ps -a --filter name=clerk-hindsight --format "{{.Status}}"',
      { stdio: "pipe", encoding: "utf-8" },
    );
    const status = output.trim();
    return status.length > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Get the MCP server config for Hindsight via HTTP endpoint.
 * Hindsight exposes MCP via Streamable HTTP at localhost:8888/mcp.
 */
export function getHindsightMcpUrl(): {
  url: string;
} {
  return {
    url: "http://localhost:8888/mcp/",
  };
}

/**
 * Generate a docker-compose snippet for Hindsight.
 */
export function generateHindsightComposeSnippet(provider?: string): string {
  const envLines = provider
    ? [`      - LLM_PROVIDER=${provider}`]
    : [];

  return [
    "services:",
    "  clerk-hindsight:",
    "    image: ghcr.io/vectorize-io/hindsight:latest",
    "    container_name: clerk-hindsight",
    "    ports:",
    "      - \"8888:8888\"",
    "      - \"9999:9999\"",
    ...(envLines.length > 0
      ? ["    environment:", ...envLines]
      : []),
    "    volumes:",
    "      - clerk-hindsight-data:/home/hindsight/.pg0",
    "    restart: unless-stopped",
    "",
    "volumes:",
    "  clerk-hindsight-data:",
  ].join("\n");
}
