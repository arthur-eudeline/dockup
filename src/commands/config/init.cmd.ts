import { dirname } from "node:path";

import { intro, log, outro, password, text } from "@clack/prompts";
import { Command } from "commander";
import { Effect } from "effect";
import { z } from "zod";

import { runStandalone } from "../../lib/cli";
import { CONFIG_SCHEMA, configPath, validateConfig, writeConfig } from "../../lib/config";
import { prompt } from "../../lib/prompts";
import { ensureWritePermission } from "../../lib/utils";

export const ConfigInitCommand = new Command()
  .name("init")
  .description("Interactively sets the dockup configuration")
  .action(() =>
    runStandalone(
      Effect.gen(function* _init() {
        intro("Dockup configuration setup :");

        // Fail fast before asking anything if we can't write the config file.
        yield* ensureWritePermission(configPath);

        const AWS_ACCESS_KEY_ID = yield* prompt(() =>
          text({
            message: "S3 Access key ID",
            validate(value) {
              const { error } = CONFIG_SCHEMA.shape.AWS_ACCESS_KEY_ID.safeParse(value);
              if (error) return z.prettifyError(error);
            },
          })
        );

        const AWS_SECRET_ACCESS_KEY = yield* prompt(() =>
          password({
            message: "S3 Secret key",
            validate(value) {
              const { error } = CONFIG_SCHEMA.shape.AWS_SECRET_ACCESS_KEY.safeParse(value);
              if (error) return z.prettifyError(error);
            },
          })
        );

        const RESTIC_REPOSITORY = yield* prompt(() =>
          text({
            message: "S3 URL",
            placeholder: "s3:https://host:port/bucket",
            validate(value) {
              const { error } = CONFIG_SCHEMA.shape.RESTIC_REPOSITORY.safeParse(value);
              if (error) return z.prettifyError(error);
            },
          })
        );

        const RESTIC_PASSWORD = yield* prompt(() =>
          text({
            message: "Restic password store (min 24, note it !)",
            validate(value) {
              const { error } = CONFIG_SCHEMA.shape.RESTIC_PASSWORD.safeParse(value);
              if (error) return z.prettifyError(error);
            },
          })
        );

        const DISCORD_WEBHOOK = yield* prompt(() =>
          text({
            message: "Discord webhook endpoint. Will be used to log backups",
            validate(value) {
              const { error } = CONFIG_SCHEMA.shape.DISCORD_WEBHOOK.safeParse(value);
              if (error) return z.prettifyError(error);
            },
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
      })
    )
  );
