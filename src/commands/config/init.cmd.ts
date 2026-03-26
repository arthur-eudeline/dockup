import { dirname } from "node:path";

import { intro, isCancel, outro, password, text, log } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";
import { z } from "zod";

import { CONFIG_SCHEMA, configPath, DOCKUP_SHELL_USER, validateConfig, writeConfig } from "../../lib/config";
import { safeSpinner } from "../../lib/prompts";
import { ensureWritePermission, getShellOutput } from "../../lib/utils";

export const ConfigInitCommand = new Command()
  .name("init")
  .description("Interactively sets the dockup configuration")
  .action(async () => {
    intro("Dockup configuration setup :");

    const program = Effect.gen(function* program() {
      // Test write permission on config dir
      yield* ensureWritePermission(dirname(configPath));

      // Config
      const AWS_ACCESS_KEY_ID = yield* Effect.promise(() =>
        text({
          message: "S3 Access key ID",
          validate(value) {
            const { error } = CONFIG_SCHEMA.shape.AWS_ACCESS_KEY_ID.safeParse(value);
            if (error) return z.prettifyError(error);
          },
        }).then((v) => {
          if (isCancel(v)) return process.exit();
          return v;
        })
      );

      const AWS_SECRET_ACCESS_KEY = yield* Effect.promise(() =>
        password({
          message: "S3 Secret key",
          validate(value) {
            const { error } = CONFIG_SCHEMA.shape.AWS_SECRET_ACCESS_KEY.safeParse(value);
            if (error) return z.prettifyError(error);
          },
        }).then((v) => {
          if (isCancel(v)) return process.exit();
          return v;
        })
      );

      const RESTIC_REPOSITORY = yield* Effect.promise(() =>
        text({
          message: "S3 URL",
          placeholder: "s3:https://host:port/bucket",
          validate(value) {
            const { error } = CONFIG_SCHEMA.shape.RESTIC_REPOSITORY.safeParse(value);
            if (error) return z.prettifyError(error);
          },
        }).then((v) => {
          if (isCancel(v)) return process.exit();
          return v;
        })
      );

      const RESTIC_PASSWORD = yield* Effect.promise(() =>
        text({
          message: "Restic password store (min 24, note it !)",
          validate(value) {
            const { error } = CONFIG_SCHEMA.shape.RESTIC_PASSWORD.safeParse(value);
            if (error) return z.prettifyError(error);
          },
        }).then((v) => {
          if (isCancel(v)) return process.exit();
          return v;
        })
      );

      const DISCORD_WEBHOOK = yield* Effect.promise(() =>
        text({
          message: "Discord webhook endpoint. Will be used to log backups",
          validate(value) {
            const { error } = CONFIG_SCHEMA.shape.DISCORD_WEBHOOK.safeParse(value);
            if (error) return z.prettifyError(error);
          },
        }).then((v) => {
          if (isCancel(v)) return process.exit();
          return v;
        })
      );

      const config = yield* validateConfig({
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        DISCORD_WEBHOOK,
        RESTIC_PASSWORD,
        RESTIC_REPOSITORY,
      });

      yield* writeConfig(config);

      log.success(`File saved at ${configPath}`);

      outro("Done");
    }).pipe(
      Effect.catchAll((e) => {
        log.error(chalk.red(`ERROR\n${e.message}`));
        return Effect.void;
      }),
      Effect.ensureErrorType<never>()
    );

    await Effect.runPromise(program);
  });
