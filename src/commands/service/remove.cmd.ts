import { intro, outro } from "@clack/prompts";
import { file } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import { Effect, Ref } from "effect";

import { runStandalone } from "../../lib/cli";
import { configPath, deleteUser, DOCKUP_SHELL_USER, removeConfigPermission } from "../../lib/config";
import type { AnyTaggedError } from "../../lib/effect";
import { ServiceRemovalError, ShellCommandFailureError } from "../../lib/errors";
import { taskSpinner } from "../../lib/prompts";
import { SERVICE_NAME, SERVICE_PATH, TIMER_PATH } from "../../lib/service";
import { deleteStateDir, STATE_DIR } from "../../lib/state";
import { getShellOutput } from "../../lib/utils";

const deleteFile = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const target = file(path);
      if (await target.exists()) await target.delete();
    },
    catch: (e) => new ShellCommandFailureError({ cause: e, message: `Failed to delete ${path} file` }),
  });

export const ServiceRemoveCommand = new Command()
  .name("remove")
  .alias("uninstall")
  .description("Disable the service and cleans up the dockup user and config permissions")
  .action(() =>
    runStandalone(
      Effect.gen(function* _remove() {
        intro("Disabling dockup service");

        // Uninstall is best-effort: every step runs even if a previous one fails,
        // so a half-installed service can always be fully torn down. Failures are
        // rendered by `taskSpinner` and counted; a non-zero count is reported at the end.
        const failures = yield* Ref.make(0);
        const step = <A, E extends AnyTaggedError>(effect: Effect.Effect<A, E, never>) =>
          effect.pipe(Effect.catchAll(() => Ref.update(failures, (n) => n + 1)));

        yield* step(
          taskSpinner(getShellOutput(`sudo systemctl disable --now ${SERVICE_NAME}.timer`), {
            title: `Disabling timer ${chalk.yellow(SERVICE_NAME)}.timer`,
            onSuccess: () => chalk.green(`Timer ${chalk.yellow(SERVICE_NAME)}.timer disabled`),
            onError: () => chalk.red(`Failed to disable ${chalk.yellow(SERVICE_NAME)}.timer`),
          })
        );

        yield* step(
          taskSpinner(getShellOutput(`sudo systemctl stop ${SERVICE_NAME}`), {
            title: `Stopping service ${chalk.yellow(SERVICE_NAME)}`,
            onSuccess: () => chalk.green(`service ${chalk.yellow(SERVICE_NAME)} stopped`),
            onError: () => chalk.red(`failed to stop service ${chalk.yellow(SERVICE_NAME)}`),
          })
        );

        yield* step(
          taskSpinner(deleteFile(SERVICE_PATH), {
            title: `Deleting service file ${chalk.yellow(SERVICE_PATH)}`,
            onSuccess: () => chalk.green(`service file ${chalk.yellow(SERVICE_PATH)} deleted`),
            onError: () => chalk.red(`failed to delete service file ${chalk.yellow(SERVICE_PATH)}`),
          })
        );

        yield* step(
          taskSpinner(deleteFile(TIMER_PATH), {
            title: `Deleting timer file ${chalk.yellow(TIMER_PATH)}`,
            onSuccess: () => chalk.green(`timer file ${chalk.yellow(TIMER_PATH)} deleted`),
            onError: () => chalk.red(`failed to delete timer file ${chalk.yellow(TIMER_PATH)}`),
          })
        );

        yield* step(
          taskSpinner(getShellOutput(`sudo systemctl daemon-reload`), {
            title: `Reloading systemctl daemon`,
            onSuccess: () => chalk.green(`systemctl daemon reloaded`),
            onError: () => chalk.red(`Failed to reload systemctl daemon`),
          })
        );

        yield* step(
          taskSpinner(removeConfigPermission(), {
            title: `Removing read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} for config file ${chalk.yellow(configPath)}`,
            onSuccess: () =>
              chalk.green(
                `Removed ${chalk.yellow(DOCKUP_SHELL_USER)} read permission from config file ${chalk.yellow(configPath)}`
              ),
            onError: () =>
              chalk.red(
                `Failed to remove read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} on config file ${chalk.yellow(configPath)}`
              ),
          })
        );

        // Backup health + undelivered notifications: no snapshot lives here, and
        // leaving it behind would keep a directory owned by a user we delete next.
        yield* step(
          taskSpinner(deleteStateDir(), {
            title: `Deleting the state directory ${chalk.yellow(STATE_DIR)}`,
            onSuccess: () => chalk.green(`state directory ${chalk.yellow(STATE_DIR)} deleted`),
            onError: () => chalk.red(`failed to delete the state directory ${chalk.yellow(STATE_DIR)}`),
          })
        );

        yield* step(
          taskSpinner(deleteUser(), {
            title: `Deleting ${chalk.yellow(DOCKUP_SHELL_USER)} user`,
            onSuccess: () => chalk.green(`User ${chalk.yellow(DOCKUP_SHELL_USER)} deleted`),
            onError: () => chalk.red(`Failed to delete user ${chalk.yellow(DOCKUP_SHELL_USER)}`),
          })
        );

        const failed = yield* Ref.get(failures);
        if (failed > 0) return yield* Effect.fail(new ServiceRemovalError({ failed }));

        outro(chalk.green("Done."));
      })
    )
  );
