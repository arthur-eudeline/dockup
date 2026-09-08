import { intro, outro, spinner } from "@clack/prompts";
import { $ } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { runStandalone } from "../../lib/cli";
import { ShellCommandFailureError } from "../../lib/errors";
import { SERVICE_NAME } from "../../lib/service";

export const ServiceTestCommand = new Command()
  .name("test")
  .description("Trigger the service now to test it")
  .action(() =>
    runStandalone(
      Effect.gen(function* _test() {
        intro("Testing dockup auto backup service");

        const s = spinner();
        s.start("Running service...");

        yield* Effect.tryPromise({
          try: () => $`sudo systemctl start ${SERVICE_NAME}`,
          catch: (e) => new ShellCommandFailureError({ cause: e, message: `Failed to run service ${SERVICE_NAME}` }),
        }).pipe(
          Effect.tapBoth({
            onSuccess: () => Effect.sync(() => s.stop(chalk.green("Service started."))),
            onFailure: () => Effect.sync(() => s.stop(chalk.red("Failed to run the service."))),
          })
        );

        outro("Done");
      })
    )
  );
