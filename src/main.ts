#!/usr/bin/env bun
import chalk from "chalk";
import { Command } from "commander";

import { BackupCommand } from "./commands/backup.cmd";
import { ConfigCommand } from "./commands/config/index.cmd";
import { ResticCommand } from "./commands/restic.cmd";
import { RestoreCommand } from "./commands/restore.cmd";
import { ServiceIndexCommand } from "./commands/service/index.cmd";
import { UpgradeCommand } from "./commands/upgrade.cmd";
import { DOCKUP_ASCII } from "./lib/help-art";
import { VERSION } from "./lib/version";

// Last-resort safety net: a command runner (src/lib/cli.ts) is expected to
// handle its own errors, but nothing should ever crash with a raw stack trace.
process.on("unhandledRejection", (reason) => {
  console.error(chalk.red("\nUnexpected error:"), reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  process.exitCode = 1;
});

const program = new Command()
  .name("dockup")
  // `-v` rather than commander's default `-V`, which nobody types.
  .version(VERSION, "-v, --version", "output the dockup version")
  .description(
    `Docker container backup system using docker labels to configure backup strategy at container level (like traefik). Based on Restic.`
  )
  .addCommand(ResticCommand)
  .addCommand(BackupCommand)
  .addCommand(ConfigCommand)
  .addCommand(RestoreCommand)
  .addCommand(ServiceIndexCommand)
  .addCommand(UpgradeCommand)
  .addHelpText("beforeAll", DOCKUP_ASCII)
  .addHelpText("before", `Version : ${chalk.yellow(VERSION)}\n`)
  .addHelpText("afterAll", " ");

try {
  await program.parseAsync(Bun.argv);
} catch (error) {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
