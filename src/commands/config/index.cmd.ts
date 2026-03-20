import { Command } from "commander";

import { ConfigCheckCommand } from "./check.cmd";
import { ConfigSetCommand } from "./set.cmd";

export const ConfigCommand = new Command()
  .name("config")
  .description("Set and check the dockup configuration")
  .addCommand(ConfigSetCommand)
  .addCommand(ConfigCheckCommand);
