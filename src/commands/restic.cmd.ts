import { Command } from "commander";

import { effectRuntime } from "../lib/effect";
import { restic } from "../lib/restic";

export const ResticCommand = new Command()
  .name("restic")
  .description("Restic commands, providing required env variables read from dockup config")
  .argument("[args...]")
  .allowExcessArguments()
  .allowUnknownOption()
  .action(async (args: string[]) => {
    await effectRuntime.runPromise(restic(args));
  });
