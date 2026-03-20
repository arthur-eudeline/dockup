#!/usr/bin/env bun
import { Command } from "commander";

import { BackupCommand } from "./commands/backup.cmd";
import { ConfigCommand } from "./commands/config/index.cmd";
import { restoreCommand } from "./commands/config/restore.cmd";
import { ResticCommand } from "./commands/restic.cmd";
import { DOCKUP_ASCII } from "./lib/help-art";

const program = new Command()
  .name("dockup")
  .description(
    `Docker container backup system using docker labels to configure backup strategy at container level (like traefik). Based on Restic.`
  )
  .addCommand(ResticCommand)
  .addCommand(BackupCommand)
  .addCommand(ConfigCommand)
  .addCommand(restoreCommand)
  .addHelpText("beforeAll", DOCKUP_ASCII)
  .addHelpText("afterAll", " ");

program.parse(Bun.argv);
