import { intro, log, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { runStandalone } from "../../lib/cli";
import {
  checkIfUserExists,
  checkIfUserIsInDockerGroup,
  configPath,
  DOCKUP_SHELL_USER,
  readConfig,
} from "../../lib/config";
import { ensureDockerPermissions } from "../../lib/docker";
import { ConfigTag } from "../../lib/effect";
import { safeSpinner } from "../../lib/prompts";
import { ensureRepoInitialized } from "../../lib/restic";
import { STATE_DIR, STATE_PATH } from "../../lib/state";
import { ensureWritePermission } from "../../lib/utils";

export const ConfigCheckCommand = new Command()
  .name("check")
  .alias("doctor")
  .description("Check the validity of the dockup configuration")
  .action(() =>
    runStandalone(
      // Diagnostic command: every probe is wrapped in `safeSpinner`, which
      // renders its own outcome and never fails, so one broken check never
      // hides the others.
      Effect.gen(function* _check() {
        intro(chalk.blue("Checking dockup health :"));

        yield* safeSpinner(ensureWritePermission(configPath), {
          title: "config write permission...",
          onSuccess: () => chalk.green("config write permission : granted"),
          onError: (e) => chalk.red(`config write permission : not granted\n${e.message}`),
        });

        // Without a writable state directory, dockup forgets last night: backups
        // keep working, the "3 days without a successful backup" alert does not.
        yield* safeSpinner(ensureWritePermission(STATE_PATH), {
          title: "backup health state...",
          onSuccess: () => chalk.green(`backup health state : writable at ${chalk.yellow(STATE_PATH)}`),
          onError: (e) =>
            chalk.red(
              `backup health state : not writable — failure-streak alerts are disabled\n${e.message}\nRun ${chalk.yellow("dockup service init")} to create ${chalk.yellow(STATE_DIR)}.`
            ),
        });

        const config = yield* safeSpinner(readConfig, {
          title: "config content...",
          onSuccess: () => chalk.green("config content : valid"),
          onError: (e) => chalk.red(`config content : invalid\n${e.message}`),
        });

        yield* safeSpinner(ensureDockerPermissions(), {
          title: "docker...",
          onSuccess: () => chalk.green("docker : granted"),
          onError: (e) => chalk.red(`docker : ${e.message}`),
        });

        if (config) {
          yield* safeSpinner(ensureRepoInitialized().pipe(Effect.provideService(ConfigTag, config)), {
            title: "checking restic repo...",
            onSuccess: () => chalk.green("restic repo : configured at ") + chalk.yellow(config.RESTIC_REPOSITORY),
            onError: (e) => chalk.red(`restic repo : error\n${e.message}`),
          });
        }

        const userExists = yield* checkIfUserExists();
        if (userExists) {
          log.info(`User in docker group : ${yield* checkIfUserIsInDockerGroup()}`);
        } else {
          log.warn(`${chalk.yellow(DOCKUP_SHELL_USER)} user does not exist`);
        }

        outro("Done");
      })
    )
  );
