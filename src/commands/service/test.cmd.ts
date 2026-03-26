import { intro, outro, spinner } from "@clack/prompts";
import { $ } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { ShellCommandFailureError } from "../../lib/errors";
import { SERVICE_NAME } from "../../lib/service";

export const ServiceTestCommand = new Command()
  .name("test")
  .description("Trigger the service now to test it")
  .action(async () => {
    intro("Testing dockup auto backup service");

    const s = spinner();
    s.start("Running service...");

    const program = Effect.tryPromise({
      try: () => $`sudo systemctl start ${SERVICE_NAME}`,
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `Failed to run service ${SERVICE_NAME}`,
        }),
    }).pipe(
      Effect.tap(() => s.stop(chalk.green("Service successful"))),
      Effect.catchAll(() => {
        s.error(chalk.red("Failed to run the service"));
        return Effect.void;
      })
    );

    await Effect.runPromise(program);
    outro("Done");
  });
