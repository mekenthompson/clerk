import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ClerkConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";

const SYSTEMD_USER_DIR = resolve(
  process.env.HOME ?? "/root",
  ".config/systemd/user"
);

function unitName(name: string): string {
  return `clerk-${name}`;
}

function unitFilePath(name: string): string {
  return resolve(SYSTEMD_USER_DIR, `${unitName(name)}.service`);
}

export function generateUnit(name: string, agentDir: string): string {
  const logFile = resolve(agentDir, "service.log");
  return `[Unit]
Description=clerk agent: ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/script -qfc "/bin/bash -l ${agentDir}/start.sh" ${logFile}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=15
WorkingDirectory=${agentDir}

[Install]
WantedBy=default.target
`;
}

export function installUnit(name: string, unitContent: string): void {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(unitFilePath(name), unitContent, { mode: 0o644 });
}

export function uninstallUnit(name: string): void {
  const path = unitFilePath(name);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function installAllUnits(config: ClerkConfig): void {
  const agentsDir = resolveAgentsDir(config);

  for (const agentName of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, agentName);
    const content = generateUnit(agentName, agentDir);
    installUnit(agentName, content);
  }

  daemonReload();
}

// ---------------------------------------------------------------------------
// Daemon unit (clerk-telegram-daemon)
// ---------------------------------------------------------------------------

const DAEMON_UNIT_NAME = "clerk-telegram-daemon";

function daemonUnitFilePath(): string {
  return resolve(SYSTEMD_USER_DIR, `${DAEMON_UNIT_NAME}.service`);
}

export function generateDaemonUnit(): string {
  const home = process.env.HOME ?? "/root";
  // Resolve clerk-daemon path relative to this package
  const daemonScript = resolve(import.meta.dirname, "../../clerk-daemon/daemon.ts");
  const envFile = resolve(home, ".clerk/daemon.env");
  return `[Unit]
Description=clerk telegram daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/bun ${daemonScript}
EnvironmentFile=${envFile}
Restart=always
RestartSec=5
WorkingDirectory=${resolve(import.meta.dirname, "../../clerk-daemon")}

[Install]
WantedBy=default.target
`;
}

export function installDaemonUnit(): void {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  const content = generateDaemonUnit();
  writeFileSync(daemonUnitFilePath(), content, { mode: 0o644 });
}

export function uninstallDaemonUnit(): void {
  const path = daemonUnitFilePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function daemonReload(): void {
  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reload systemd user daemon: ${message}`);
  }
}
