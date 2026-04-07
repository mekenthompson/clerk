import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { resolveAgentsDir } from "../config/loader.js";
import {
  loginAgent,
  loginAllAgents,
  startLogin,
  completeLogin,
  getAuthStatus,
  getAllAuthStatuses,
  refreshAgent,
} from "../auth/manager.js";
import { withConfigError, getConfig } from "./helpers.js";

function printAuthTable(
  headers: string[],
  rows: string[][],
  widths: number[]
): void {
  const headerLine = headers
    .map((h, i) => chalk.bold(h.padEnd(widths[i])))
    .join("  ");
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage OAuth authentication per agent");

  // clerk auth login <name|all>
  auth
    .command("login <name>")
    .description(
      "Login an agent via OAuth (or 'all' to login all agents sequentially)"
    )
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (name === "all") {
          console.log(chalk.bold("\nLogging in all agents...\n"));
          const results = await loginAllAgents(config);

          for (const [agentName, result] of Object.entries(results)) {
            if (result.success) {
              console.log(chalk.green(`  ${agentName}: authenticated`));
            } else {
              console.error(chalk.red(`  ${agentName}: failed`));
            }
          }
          console.log();
          return;
        }

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        console.log(chalk.bold(`\nLogging in agent: ${name}\n`));
        const result = await loginAgent(name, agentDir);

        if (result.success) {
          console.log(chalk.green(`\nAgent "${name}" authenticated successfully.\n`));
        } else {
          console.error(chalk.red(`\nFailed to authenticate agent "${name}": ${result.error}\n`));
          process.exit(1);
        }
      })
    );

  // clerk auth status
  auth
    .command("status")
    .description("Show authentication status for all agents")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const statuses = getAllAuthStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        const headers = ["Name", "Subscription", "Expires In", "Rate Limit", "Status"];
        const widths = [16, 14, 12, 26, 8];

        const rows = agentNames.map((name) => {
          const status = statuses[name];

          if (!status.authenticated) {
            return [
              name,
              "\u2014",
              "\u2014",
              "\u2014",
              chalk.red("\u2717"),
            ];
          }

          const expiry = status.timeUntilExpiry ?? "\u2014";
          const isExpiringSoon =
            status.expiresAt != null &&
            status.expiresAt - Date.now() < 60 * 60 * 1000 &&
            status.expiresAt > Date.now();

          const expiryDisplay = isExpiringSoon
            ? chalk.yellow(expiry)
            : chalk.green(expiry);

          return [
            name,
            status.subscriptionType ?? "\u2014",
            expiryDisplay,
            status.rateLimitTier ?? "\u2014",
            chalk.green("\u2713"),
          ];
        });

        console.log();
        printAuthTable(headers, rows, widths);
        console.log();
      })
    );

  // clerk auth refresh <name>
  auth
    .command("refresh <name>")
    .description("Force re-login to refresh OAuth tokens for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          console.error(
            chalk.gray(
              `  Available agents: ${Object.keys(config.agents).join(", ")}`
            )
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        console.log(chalk.bold(`\nRefreshing auth for agent: ${name}\n`));
        const result = await refreshAgent(name, agentDir);

        if (result.success) {
          console.log(chalk.green(`\nAgent "${name}" refreshed successfully.\n`));
        } else {
          console.error(chalk.red(`\nFailed to refresh agent "${name}": ${result.error}\n`));
          process.exit(1);
        }
      })
    );

  // clerk auth start <name> — generate URL without waiting for input (for headless/remote use)
  auth
    .command("start <name>")
    .description(
      "Generate an auth URL for an agent (use 'clerk auth complete' to finish)"
    )
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        const { authUrl } = startLogin(name, agentDir);

        console.log(
          chalk.bold(`\nAuth URL for ${name}:\n`)
        );
        console.log(`  ${authUrl}\n`);
        console.log(
          chalk.gray(
            `  After signing in, run: clerk auth complete ${name} <code>\n`
          )
        );
      })
    );

  // clerk auth complete <name> <code> — finish auth with a code
  auth
    .command("complete <name> <code>")
    .description("Complete auth for an agent using the code from the browser")
    .action(
      withConfigError(async (name: string, code: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);

        if (!config.agents[name]) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in clerk.yaml`)
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);
        const result = await completeLogin(name, agentDir, code);

        if (result.success) {
          console.log(
            chalk.green(`\nAgent "${name}" authenticated successfully.\n`)
          );
        } else {
          console.error(
            chalk.red(
              `\nFailed to authenticate agent "${name}": ${result.error}\n`
            )
          );
          process.exit(1);
        }
      })
    );
}
