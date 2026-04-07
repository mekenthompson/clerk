import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, ConfigError } from "../config/loader.js";
import { startWebServer } from "../web/server.js";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Start the web dashboard for monitoring agents")
    .option("-p, --port <port>", "Port to listen on", "8080")
    .action(async (opts) => {
      try {
        const parentOpts = program.opts();
        const config = loadConfig(parentOpts.config);
        const port = parseInt(opts.port, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number"));
          process.exit(1);
        }

        console.log(chalk.bold("\nStarting Clerk dashboard...\n"));
        console.log(chalk.gray(`  Agents: ${Object.keys(config.agents).join(", ")}`));
        console.log(chalk.gray(`  Port:   ${port}\n`));

        startWebServer(config, port);

        console.log(
          chalk.green(`\n  Dashboard: http://localhost:${port}\n`)
        );
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(chalk.red(`Config error: ${err.message}`));
          if (err.details) {
            for (const d of err.details) {
              console.error(chalk.gray(d));
            }
          }
          process.exit(1);
        }
        throw err;
      }
    });
}
