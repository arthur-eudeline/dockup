#!/usr/bin/env bun
import chalk from "chalk";
import { Command } from "commander";

import { BackupCommand } from "./commands/backup.cmd";
import { ConfigCommand } from "./commands/config/index.cmd";
import { ResticCommand } from "./commands/restic.cmd";
import { RestoreCommand } from "./commands/restore.cmd";
import { ServiceIndexCommand } from "./commands/service/index.cmd";
import { DOCKUP_ASCII } from "./lib/help-art";

const VERSION = "0.0.1";

const program = new Command()
  .name("dockup")
  .version(VERSION)
  .description(
    `Docker container backup system using docker labels to configure backup strategy at container level (like traefik). Based on Restic.`
  )
  .addCommand(ResticCommand)
  .addCommand(BackupCommand)
  .addCommand(ConfigCommand)
  .addCommand(RestoreCommand)
  .addCommand(ServiceIndexCommand)
  .addHelpText("beforeAll", DOCKUP_ASCII)
  .addHelpText("before", `Version : ${chalk.yellow(VERSION)}\n`)
  .addHelpText("afterAll", " ");

program.parse(Bun.argv);
