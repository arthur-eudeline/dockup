import { intro, log, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect, Fiber } from "effect";

import { runStandalone } from "../../lib/cli";
import { ShellCommandFailureError } from "../../lib/errors";
import { streamingTaskLog } from "../../lib/prompts";
import { SERVICE_NAME } from "../../lib/service";
import { getShellOutput, primeSudo, streamShellOutput } from "../../lib/utils";

/** Time given to the journal to catch up before the follower is stopped. */
const JOURNAL_DRAIN = "500 millis";

export const ServiceTestCommand = new Command()
  .name("test")
  .description("Trigger the service now to test it")
  .action(() =>
    runStandalone(
      Effect.gen(function* _test() {
        intro("Testing dockup auto backup service");

        // Both commands below capture stderr, which is where sudo writes its
        // prompt: a password asked from inside the task log would be invisible,
        // so it is asked for here — and only when sudo has nothing cached.
        const sudoReady = yield* getShellOutput("sudo -n -v").pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false))
        );

        if (!sudoReady) {
          log.info("sudo will ask for your password.");
          yield* primeSudo();
        }

        const logger = streamingTaskLog(`Running ${chalk.yellow(SERVICE_NAME)}...`);

        // `systemctl start` on a oneshot unit blocks until the backup is over and
        // says nothing at all meanwhile — a whole run behind a mute spinner. The
        // journal is followed while it runs so the output shows up as it happens.
        // Best-effort: a journal that cannot be read must not fail the test.
        const follower = yield* Effect.fork(
          streamShellOutput({
            cmd: `sudo journalctl --unit ${SERVICE_NAME} --follow --lines 0 --output cat`,
            logger,
          }).pipe(Effect.ignore)
        );

        yield* getShellOutput(`sudo systemctl start ${SERVICE_NAME}`).pipe(
          Effect.mapError(
            (cause) =>
              new ShellCommandFailureError({
                cause,
                // systemd only ever says "Job for … failed", on stderr : without
                // it the command reported a failure and no reason at all.
                message: `Failed to run service ${SERVICE_NAME}\n${cause.message}`,
              })
          ),
          // The last lines of the run reach the journal slightly after systemd
          // considers the job done, so the follower is given a moment before it
          // is interrupted — which kills it, whether the run succeeded or not.
          Effect.ensuring(Effect.sleep(JOURNAL_DRAIN).pipe(Effect.zipRight(Fiber.interrupt(follower)))),
          Effect.tapBoth({
            onSuccess: () => Effect.sync(() => logger.success(chalk.green("Service started."))),
            onFailure: () => Effect.sync(() => logger.error(chalk.red("Failed to run the service."))),
          })
        );

        outro("Done");
      })
    )
  );
