import { intro, log, outro, S_SUCCESS } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { runStandalone } from "../../lib/cli";
import {
  addConfigPermission,
  addCurrentUserToDockupGroup,
  addUserToDockerGroup,
  checkIfCurrentUserIsInDockupGroup,
  checkIfUserExists,
  checkIfUserIsInDockerGroup,
  configPath,
  createUser,
  DOCKUP_SHELL_USER,
} from "../../lib/config";
import { taskSpinner } from "../../lib/prompts";
import {
  registerService,
  SERVICE_NAME,
  SERVICE_PATH,
  TIMER_PATH,
  writeServiceFile,
  writeTimerFile,
} from "../../lib/service";
import { createStateDir, STATE_DIR } from "../../lib/state";

export const ServiceInitCommand = new Command()
  .name("init")
  .alias("setup")
  .description("Register a systemd service that will trigger auto updates every day at 02:00 AM.")
  .action(() =>
    // Install is intentionally abort-on-first-error: a half-registered systemd
    // service is worse than a clear failure. `runStandalone` renders whichever
    // step failed (tag + message + hint) and sets the exit code.
    runStandalone(
      Effect.gen(function* _init() {
        intro("Setting up the backup service");

        // User creation
        yield* taskSpinner(createUser(), {
          title: `creating ${chalk.yellow(DOCKUP_SHELL_USER)} user`,
          onSuccess: () => chalk.green(`created ${chalk.yellow(DOCKUP_SHELL_USER)} user`),
          onError: () => chalk.red(`failed to create ${chalk.yellow(DOCKUP_SHELL_USER)} user`),
          skip: {
            condition: checkIfUserExists(),
            onSkip: () => chalk.yellow(`${DOCKUP_SHELL_USER} user already exists`),
          },
        });

        // Adding user to docker group
        yield* taskSpinner(addUserToDockerGroup(), {
          title: `adding ${chalk.yellow(DOCKUP_SHELL_USER)} user to ${chalk.blue("docker")} group`,
          onSuccess: () => chalk.green(`${chalk.yellow(DOCKUP_SHELL_USER)} added to the ${chalk.blue("docker")} group`),
          onError: () =>
            chalk.red(`failed to add ${chalk.yellow(DOCKUP_SHELL_USER)} user to ${chalk.blue("docker")} group`),
          skip: {
            condition: checkIfUserIsInDockerGroup(),
            onSkip: () => chalk.yellow(`${DOCKUP_SHELL_USER} user already in ${chalk.blue("docker")} group`),
          },
        });

        // Adding current user to dockup group
        let needRelog = true;
        yield* taskSpinner(addCurrentUserToDockupGroup(), {
          title: `adding current user to ${chalk.yellow(DOCKUP_SHELL_USER)} group`,
          onSuccess: (currentUser) =>
            chalk.green(`${chalk.yellow(currentUser)} added to the ${chalk.yellow(DOCKUP_SHELL_USER)} group`),
          onError: () => chalk.red(`failed to add current user to ${chalk.yellow(DOCKUP_SHELL_USER)} group`),
          skip: {
            condition: checkIfCurrentUserIsInDockupGroup(),
            onSkip: () => {
              needRelog = false;
              return chalk.yellow(`current user already in ${chalk.yellow(DOCKUP_SHELL_USER)} group`);
            },
          },
        });

        // Updating the dockup config permissions
        yield* taskSpinner(addConfigPermission(), {
          title: `granting read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} user on config file at ${chalk.yellow(configPath)}`,
          onSuccess: () =>
            chalk.green(
              `read permission granted to ${chalk.yellow(DOCKUP_SHELL_USER)} user on config file at ${chalk.yellow(configPath)}`
            ),
          onError: () =>
            chalk.red(
              `failed to grant read permission to ${chalk.yellow(DOCKUP_SHELL_USER)} user on config file at ${chalk.yellow(configPath)}`
            ),
        });

        // State directory — without it a run cannot remember that last night
        // failed too, and the failure-streak alerting is silently disabled.
        yield* taskSpinner(createStateDir(), {
          title: `creating the state directory at ${chalk.yellow(STATE_DIR)}`,
          onSuccess: () => chalk.green(`state directory created at ${chalk.yellow(STATE_DIR)}`),
          onError: () => chalk.red(`failed to create the state directory at ${chalk.yellow(STATE_DIR)}`),
        });

        // Write service file
        yield* taskSpinner(writeServiceFile(), {
          title: `writing service file at ${chalk.yellow(SERVICE_PATH)}`,
          onSuccess: () => chalk.green(`service file written at ${chalk.yellow(SERVICE_PATH)}`),
          onError: () => chalk.red(`failed to write service file at ${chalk.yellow(SERVICE_PATH)}`),
        });

        // Timer file
        yield* taskSpinner(writeTimerFile(), {
          title: `writing timer file at ${chalk.yellow(TIMER_PATH)}`,
          onSuccess: () => chalk.green(`timer file written at ${chalk.yellow(TIMER_PATH)}`),
          onError: () => chalk.red(`failed to write timer file at ${chalk.yellow(TIMER_PATH)}`),
        });

        // Reloading systemctl
        yield* taskSpinner(registerService(), {
          title: `enabling service ${chalk.yellow(SERVICE_NAME)}`,
          onSuccess: () => chalk.green(`service ${chalk.yellow(SERVICE_NAME)} enabled\nsystemctl restarted`),
          onError: () => chalk.red(`failed enable service ${chalk.yellow(SERVICE_NAME)}`),
        });

        if (needRelog) {
          log.message(chalk.yellow("WARNING : some changes requires you to re-log to take effect."), {
            symbol: chalk.yellow(S_SUCCESS),
          });
        }

        outro(chalk.green("Service registered.\nBackups will be trigered at 02:00 AM every day from now on."));
      })
    )
  );
