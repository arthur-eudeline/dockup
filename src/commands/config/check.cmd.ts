import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { readConfig } from "../../lib/config";

export const ConfigCheckCommand = new Command()
  .name("check")
  .description("Check the validity of the dockup configuration")
  .action(async () => {
    const runnable = readConfig.pipe(
      Effect.catchAll((e): Effect.Effect<void> => {
        console.error(`${chalk.bgRed(" ERROR ")} : ${e.message}`);
        process.exit(1);
      }),
      Effect.tap((): void => {
        console.log(`${chalk.bgGreen(" OK ")} : Dockup configuration is valid`);
        process.exit(0);
      })
    );

    await Effect.runPromise(runnable);
  });
