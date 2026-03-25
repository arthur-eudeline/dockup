import { dirname } from "node:path";

import { intro, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { configPath, readConfig } from "../../lib/config";
import type { Config } from "../../lib/config";
import { ensureDockerPermissions } from "../../lib/docker";
import { ConfigTag } from "../../lib/effect";
import { safeSpinner } from "../../lib/prompts";
import { ensureRepoInitialized } from "../../lib/restic";
import { ensureWritePermission } from "../../lib/utils";

export const ConfigCheckCommand = new Command()
  .name("check")
  .alias("doctor")
  .description("Check the validity of the dockup configuration")
  .action(async () => {
    const runnable = Effect.gen(function* _check() {
      intro(chalk.blue("Checking dockup health :"));

      // Write permission
      yield* safeSpinner(ensureWritePermission(dirname(configPath)), {
        title: "config write permission...",
        onSuccess: () => chalk.green("config write permission : granted"),
        onError: (e) => chalk.red(`config write permission : not granted\n${e.message}`),
      });

      // config content
      let config: Config | null = null;
      yield* safeSpinner(readConfig, {
        title: "config content...",
        onSuccess: (c) => {
          config = c;
          return chalk.green("config content : valid");
        },
        onError: (e) => chalk.red(`config content : invalid\n${e.message}`),
      });

      // Docker permissions
      yield* safeSpinner(ensureDockerPermissions(), {
        title: "docker...",
        onSuccess: () => chalk.green("docker : granted"),
        onError: (e) => chalk.red(`docker : ${e.message}`),
      });

      // Check restic repo initialized
      if (config) {
        yield* safeSpinner(ensureRepoInitialized().pipe(Effect.provideService(ConfigTag, config as Config)), {
          title: "checking restic repo...",
          onSuccess: () => chalk.green("restic repo : configured at ") + chalk.yellow(config?.RESTIC_REPOSITORY),
          onError: (e) => chalk.red(`restic repo : error\n${e.message}`),
        });
      }

      outro("Done");
      process.exit(0);
    }).pipe(Effect.ensureErrorType<never>());

    await Effect.runPromise(runnable);
  });
