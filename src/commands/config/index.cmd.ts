import { Command } from "commander";

import { ConfigCheckCommand } from "./check.cmd";
import { ConfigInitCommand } from "./init.cmd";

export const ConfigCommand = new Command()
  .name("config")
  .description("Set and check the dockup configuration")
  .addCommand(ConfigInitCommand)
  .addCommand(ConfigCheckCommand);
