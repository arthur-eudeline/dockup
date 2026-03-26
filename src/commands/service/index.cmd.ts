import { Command } from "commander";

import { ServiceInitCommand } from "./init.cmd";
import { ServiceRemoveCommand } from "./remove.cmd";
import { ServiceTestCommand } from "./test.cmd";

export const ServiceIndexCommand = new Command()
  .name("service")
  .alias("cron")
  .description("Manage the dockup service in charge of doing daily backups")
  .addCommand(ServiceInitCommand)
  .addCommand(ServiceTestCommand)
  .addCommand(ServiceRemoveCommand);
