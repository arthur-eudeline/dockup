import { Command } from "commander";

import { ServiceSetupCommand } from "./setup.cmd";

export const ServiceIndexCommand = new Command().name("service").addCommand(ServiceSetupCommand);
