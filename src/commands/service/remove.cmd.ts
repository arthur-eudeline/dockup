import { intro, outro } from "@clack/prompts";
import { file } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { configPath, deleteUser, DOCKUP_SHELL_USER, removeConfigPermission } from "../../lib/config";
import { ShellCommandFailureError } from "../../lib/errors";
import { taskSpinner } from "../../lib/prompts";
import { SERVICE_NAME, SERVICE_PATH, TIMER_PATH } from "../../lib/service";
import { getShellOutput } from "../../lib/utils";

export const ServiceRemoveCommand = new Command()
  .name("remove")
  .alias("uninstall")
  .description("Disable the service and cleans up the dockup user and config permissions")
  .action(async () => {
    intro("Disabling dockup service");

    const program = Effect.gen(function* program() {
      // Disable timer
      yield* taskSpinner(getShellOutput(`sudo systemctl disable --now ${SERVICE_NAME}.timer`), {
        title: `Disabling timer ${chalk.yellow(SERVICE_NAME)}.timer`,
        onSuccess: () => chalk.green(`Timer ${chalk.yellow(SERVICE_NAME)}.timer disabled`),
        onError: () => chalk.red(`Failed to disable ${chalk.yellow(SERVICE_NAME)}.timer`),
      });

      // Stopping service
      yield* taskSpinner(getShellOutput(`sudo systemctl stop ${SERVICE_NAME}`), {
        title: `Stopping service ${chalk.yellow(SERVICE_NAME)}`,
        onSuccess: () => chalk.green(`service ${chalk.yellow(SERVICE_NAME)} stopped`),
        onError: () => chalk.red(`failed to stop service ${chalk.yellow(SERVICE_NAME)}`),
      });

      // Deleting service file
      yield* taskSpinner(
        Effect.tryPromise({
          try: async () => {
            const serviceFile = file(SERVICE_PATH);
            if (await serviceFile.exists()) await serviceFile.delete();
          },
          catch: (e) =>
            new ShellCommandFailureError({
              cause: e,
              message: `Failed to delete ${SERVICE_PATH} file`,
            }),
        }),
        {
          title: `Deleting service file ${chalk.yellow(SERVICE_PATH)}`,
          onSuccess: () => chalk.green(`service file ${chalk.yellow(SERVICE_PATH)} deleted`),
          onError: () => chalk.red(`failed to delete service file ${chalk.yellow(SERVICE_PATH)}`),
        }
      );

      // Deleting timer file
      yield* taskSpinner(
        Effect.tryPromise({
          try: async () => {
            const timerFile = file(TIMER_PATH);
            if (await timerFile.exists()) await timerFile.delete();
          },
          catch: (e) =>
            new ShellCommandFailureError({
              cause: e,
              message: `Failed to delete ${TIMER_PATH} file`,
            }),
        }),
        {
          title: `Deleting timer file ${chalk.yellow(TIMER_PATH)}`,
          onSuccess: () => chalk.green(`timer file ${chalk.yellow(TIMER_PATH)} deleted`),
          onError: () => chalk.red(`timer to delete service file ${chalk.yellow(TIMER_PATH)}`),
        }
      );

      // Reloading systemctl daemon
      yield* taskSpinner(getShellOutput(`sudo systemctl daemon-reload`), {
        title: `Reloading systemctl daemon`,
        onSuccess: () => chalk.green(`systemctl daemon reloaded`),
        onError: () => chalk.red(`Failed to reload systemctl daemon`),
      });

      // Remove config permission
      yield* taskSpinner(removeConfigPermission(), {
        title: `Removing read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} for config file ${chalk.yellow(configPath)}`,
        onSuccess: () =>
          chalk.green(
            `Removed ${chalk.yellow(DOCKUP_SHELL_USER)} read permission from config file ${chalk.yellow(configPath)}`
          ),
        onError: () =>
          chalk.red(
            `Failed to remove read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} on config file ${chalk.yellow(configPath)}`
          ),
      });

      // Delete user
      yield* taskSpinner(deleteUser(), {
        title: `Deleting ${chalk.yellow(DOCKUP_SHELL_USER)} user`,
        onSuccess: () => chalk.green(`User ${chalk.yellow(DOCKUP_SHELL_USER)} deleted`),
        onError: () => chalk.red(`Failed to delete user ${chalk.yellow(DOCKUP_SHELL_USER)}`),
      });
    });

    await Effect.runPromise(program);

    outro("Done");
  });
