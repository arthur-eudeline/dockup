import { Command } from "commander";
import { Effect } from "effect";

import { runCommand } from "../lib/cli";
import { restic } from "../lib/restic";

export const ResticCommand = new Command()
  .name("restic")
  .description("Restic commands, providing required env variables read from dockup config")
  .argument("[args...]")
  .allowExcessArguments()
  .allowUnknownOption()
  .action((args: string[]) =>
    runCommand(
      restic(args).pipe(
        // Mirror restic's own exit code onto the process; runCommand keeps its
        // 0 for the wrapper itself and won't override a non-zero set here.
        Effect.tap((code) =>
          Effect.sync(() => {
            if (code !== 0) process.exitCode = code;
          })
        ),
        Effect.asVoid
      )
    )
  );
