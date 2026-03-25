import { intro, log, outro, spinner } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { effectRuntime } from "../../lib/effect";
import { registerService, SERVICE_PATH, TIMER_PATH, writeServiceFile, writeTimerFile } from "../../lib/service";

export const ServiceSetupCommand = new Command()
  .name("setup")
  .description("Register a systemd service that will trigger auto updates every day at 02:00 AM.")
  .action(async () => {
    const program = Effect.gen(function* program() {
      intro("Setting up the backup service");

      yield* writeServiceFile();
      log.step(`service file writtent at ${chalk.yellow(SERVICE_PATH)}`);

      yield* writeTimerFile();
      log.step(`timer file written at ${chalk.yellow(TIMER_PATH)}`);

      const s = spinner();
      s.start("Registering service...");
      yield* registerService().pipe(
        Effect.tap(() => s.stop("Service registered.")),
        Effect.catchAll(() => {
          s.error(`Failed to register service.`);
          return Effect.void;
        })
      );

      outro(chalk.green("Service registered. Backups will be trigered at 02:00 AM every day from now on"));
    }).pipe(
      Effect.catchTags({
        SHELL_COMMAND_FAILURE_ERROR: (e) => {
          console.error(e);
          return Effect.void;
        },
      }),
      Effect.ensureErrorType<never>()
    );

    await effectRuntime.runPromise(program);
  });
