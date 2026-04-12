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

export function generateUnit(name: string, agentDir: string, useAutoaccept = false): string {
  const logFile = resolve(agentDir, "service.log");
  const autoacceptExp = resolve(import.meta.dirname, "../../bin/autoaccept.exp");

  // When using dev channels (forked plugin), use expect to handle the
  // interactive confirmation prompts. TIOCSTI-based keystroke injection
  // is disabled on Ubuntu 24.04+ kernels, so expect is the reliable
  // approach. It's standard on every Linux distro (apt install expect).
  //
  // We wrap the expect invocation in `script` so systemd still gets a
  // single log file with the full output.
  const execStart = useAutoaccept
    ? `/usr/bin/script -qfc "/usr/bin/expect -f ${autoacceptExp} ${agentDir}/start.sh" ${logFile}`
    : `/usr/bin/script -qfc "/bin/bash -l ${agentDir}/start.sh" ${logFile}`;

  return `[Unit]
Description=clerk agent: ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
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
    const useAutoaccept = config.agents[agentName].channels?.telegram?.plugin === "clerk";
    const content = generateUnit(agentName, agentDir, useAutoaccept);
    installUnit(agentName, content);
  }

  daemonReload();
}

export function daemonReload(): void {
  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reload systemd user daemon: ${message}`);
  }
}
