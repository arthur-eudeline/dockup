import { intro, isCancel, outro, password, text, log } from "@clack/prompts";
import { Command } from "commander";
import { Effect } from "effect";
import { z } from "zod";

import { CONFIG_SCHEMA, configPath, validateConfig, writeConfig } from "../../lib/config";

export const ConfigSetCommand = new Command()
  .name("set")
  .description("Interactively sets the dockup configuration")
  .action(async () => {
    intro("Dockup configuration setup :");

    const AWS_ACCESS_KEY_ID = await text({
      message: "S3 Access key ID",
      validate(value) {
        const { error } = CONFIG_SCHEMA.shape.AWS_ACCESS_KEY_ID.safeParse(value);
        if (error) return z.prettifyError(error);
      },
    }).then((v) => {
      if (isCancel(v)) return process.exit();
      return v;
    });

    const AWS_SECRET_ACCESS_KEY = await password({
      message: "S3 Secret key",
      validate(value) {
        const { error } = CONFIG_SCHEMA.shape.AWS_SECRET_ACCESS_KEY.safeParse(value);
        if (error) return z.prettifyError(error);
      },
    }).then((v) => {
      if (isCancel(v)) return process.exit();
      return v;
    });

    const RESTIC_REPOSITORY = await text({
      message: "S3 URL",
      placeholder: "s3:https://host:port/bucket",
      validate(value) {
        const { error } = CONFIG_SCHEMA.shape.RESTIC_REPOSITORY.safeParse(value);
        if (error) return z.prettifyError(error);
      },
    }).then((v) => {
      if (isCancel(v)) return process.exit();
      return v;
    });

    const RESTIC_PASSWORD = await text({
      message: "Restic password store (min 24, note it !)",
      validate(value) {
        const { error } = CONFIG_SCHEMA.shape.RESTIC_PASSWORD.safeParse(value);
        if (error) return z.prettifyError(error);
      },
    }).then((v) => {
      if (isCancel(v)) return process.exit();
      return v;
    });

    const DISCORD_WEBHOOK = await text({
      message: "Discord webhook endpoint. Will be used to log backups",
      validate(value) {
        const { error } = CONFIG_SCHEMA.shape.DISCORD_WEBHOOK.safeParse(value);
        if (error) return z.prettifyError(error);
      },
    }).then((v) => {
      if (isCancel(v)) return process.exit();
      return v;
    });

    const program = Effect.gen(function* program() {
      const config = yield* validateConfig({
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        DISCORD_WEBHOOK,
        RESTIC_PASSWORD,
        RESTIC_REPOSITORY,
      });

      yield* writeConfig(config);
    });

    await Effect.runPromise(program);

    log.success(`File saved at ${configPath}`);
    outro("Done");
  });
