import { confirm, intro, log, outro, password, text } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";
import { z } from "zod";

import { runStandalone } from "../../lib/cli";
import type { Config } from "../../lib/config";
import { CONFIG_SCHEMA, configPath, readConfig, validateConfig, writeConfig } from "../../lib/config";
import {
  NonInteractiveConfigError,
  ParsingError,
  PromptCancelledError,
  ShellCommandFailureError,
} from "../../lib/errors";
import { prompt } from "../../lib/prompts";
import { ensureWritePermission } from "../../lib/utils";

/**
 * The scalar config keys `config init` knows how to collect. `hosts` is left
 * out on purpose — it is managed by `config target`, or passed wholesale
 * through `--json` for an unattended install.
 */
const FIELDS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD",
  "DISCORD_WEBHOOK",
] as const;

type Field = (typeof FIELDS)[number];

/** `AWS_ACCESS_KEY_ID` → `aws-access-key-id` (the commander flag / option key). */
const toFlag = (field: Field): string => field.toLowerCase().replaceAll("_", "-");

/** `AWS_ACCESS_KEY_ID` → `DOCKUP_AWS_ACCESS_KEY_ID` (prefixed so a stray `AWS_*` in the env is never picked up). */
const toEnvVar = (field: Field): string => `DOCKUP_${field}`;

interface ConfigInitOptions {
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  resticRepository?: string;
  resticPassword?: string;
  discordWebhook?: string;
  json?: string;
  nonInteractive?: boolean;
  force?: boolean;
}

const flagValue = (options: ConfigInitOptions, field: Field): string | undefined =>
  ({
    AWS_ACCESS_KEY_ID: options.awsAccessKeyId,
    AWS_SECRET_ACCESS_KEY: options.awsSecretAccessKey,
    RESTIC_REPOSITORY: options.resticRepository,
    RESTIC_PASSWORD: options.resticPassword,
    DISCORD_WEBHOOK: options.discordWebhook,
  })[field];

/**
 * Validate a single value against its slice of `CONFIG_SCHEMA` — shared by the prompts.
 *
 * With a `previous` value on hand an empty answer is valid: it means "keep it".
 */
const validateField = (field: Field, previous?: string) => (value: unknown) => {
  if (previous !== undefined && (value === undefined || value === "")) return;
  const { error } = CONFIG_SCHEMA.shape[field].safeParse(value);
  if (error) return z.prettifyError(error);
};

/** What tells the user an empty answer keeps the current value — shown for secrets as a mask, never the value. */
const keepHint = (previous: string | undefined, secret: boolean): string =>
  previous === undefined ? "" : chalk.dim(` (empty to keep ${secret ? "the current value" : previous})`);

/**
 * One prompt per field. `previous` is what the file being overwritten holds: an
 * empty answer keeps it, so re-running `init` to change one value does not mean
 * retyping the four others.
 */
const PROMPTS: Record<Field, (previous?: string) => Promise<string | symbol>> = {
  AWS_ACCESS_KEY_ID: (previous) =>
    text({
      message: `S3 Access key ID${keepHint(previous, false)}`,
      validate: validateField("AWS_ACCESS_KEY_ID", previous),
    }),
  AWS_SECRET_ACCESS_KEY: (previous) =>
    password({
      message: `S3 Secret key${keepHint(previous, true)}`,
      validate: validateField("AWS_SECRET_ACCESS_KEY", previous),
    }),
  RESTIC_REPOSITORY: (previous) =>
    text({
      message: `S3 URL (s3:https://host:port/bucket)${keepHint(previous, false)}`,
      placeholder: "s3:https://host:port/bucket",
      validate: validateField("RESTIC_REPOSITORY", previous),
    }),
  RESTIC_PASSWORD: (previous) =>
    text({
      message: `Restic password store (min 24, note it !)${keepHint(previous, true)}`,
      validate: validateField("RESTIC_PASSWORD", previous),
    }),
  DISCORD_WEBHOOK: (previous) =>
    text({
      message: `Discord webhook endpoint. Will be used to log backups${keepHint(previous, true)}`,
      validate: validateField("DISCORD_WEBHOOK", previous),
    }),
};

/**
 * Reads a JSON configuration document, from a file or from stdin (`-`).
 * Lets an installer hand dockup the whole config — `hosts` included — in one go.
 */
const readJsonDocument = (
  source: string
): Effect.Effect<Record<string, unknown>, ParsingError | ShellCommandFailureError> =>
  Effect.gen(function* _readJsonDocument() {
    const raw = yield* Effect.tryPromise({
      try: () => (source === "-" ? Bun.stdin.text() : Bun.file(source).text()),
      catch: (cause) =>
        new ShellCommandFailureError({
          cause,
          message: `Failed to read the configuration document from ${source === "-" ? "stdin" : source}`,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ParsingError({ cause, message: `${source === "-" ? "stdin" : source} does not contain valid JSON` }),
    });

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* Effect.fail(
        new ParsingError({
          cause: parsed,
          message: `${source === "-" ? "stdin" : source} must contain a JSON object`,
        })
      );
    }

    return parsed as Record<string, unknown>;
  });

/** The existing configuration, or `null` (with a warning) when it cannot be read. */
const readPreviousConfig: Effect.Effect<Config | null> = readConfig.pipe(
  Effect.catchAll(() =>
    Effect.as(
      Effect.sync(() => log.warn("The existing configuration could not be read: nothing to keep.")),
      null
    )
  )
);

export const ConfigInitCommand = new Command()
  .name("init")
  .description("Set the dockup configuration, interactively or from flags / env vars / a JSON file")
  .option("--aws-access-key-id <id>", "S3 access key ID")
  .option("--aws-secret-access-key <key>", "S3 secret access key")
  .option("--restic-repository <url>", "Restic repository URL (s3:...)")
  .option("--restic-password <password>", "Restic repository password (min 24 chars)")
  .option("--discord-webhook <url>", "Discord webhook URL for backup reports")
  .option(
    "--json <path>",
    'Read the configuration from a JSON file ("-" for stdin); flags and env vars override its keys'
  )
  .option("-y, --non-interactive", "Never prompt; fail if a required value is missing (implied when there is no TTY)")
  .option("-f, --force", "Overwrite an existing configuration file")
  .addHelpText(
    "after",
    `\nNon-interactive install (Ansible, cloud-init, …):\n` +
      `  Every value can come from a --flag, a DOCKUP_<KEY> env var, or a key in --json.\n` +
      `  Env vars: ${FIELDS.map(toEnvVar).join(", ")}\n` +
      `  Passing secrets through the environment keeps them out of the process list.\n` +
      `  Example: DOCKUP_RESTIC_PASSWORD=... dockup config init --json /tmp/dockup.json -y\n`
  )
  .action((options: ConfigInitOptions) =>
    runStandalone(
      Effect.gen(function* _init() {
        intro("Dockup configuration setup :");

        // No terminal means no prompts, whatever the flags say — an unattended
        // run must fail loudly rather than block on a hidden question.
        const canPrompt = Boolean(process.stdin.isTTY) && !options.nonInteractive;

        // Fail fast before asking anything if we can't write the config file.
        yield* ensureWritePermission(configPath);

        // Overwrite guard: an existing file is only clobbered on --force (or an
        // explicit "yes"), so an installer that re-runs the task every play is a
        // safe no-op instead of a needless credential rewrite.
        const alreadyExists = yield* Effect.promise(() => Bun.file(configPath).exists());
        if (alreadyExists && !options.force) {
          if (!canPrompt) {
            log.warn(`${configPath} already exists — re-run with ${chalk.yellow("--force")} to overwrite it.`);
            outro("Nothing to do.");
            return;
          }
          const overwrite = yield* prompt(() =>
            confirm({ message: `${configPath} already exists. Overwrite it ?`, initialValue: false })
          );
          if (!overwrite)
            return yield* Effect.fail(new PromptCancelledError({ reason: "Configuration left unchanged." }));
        }

        const document = options.json ? yield* readJsonDocument(options.json) : {};

        // What the file being overwritten holds, so an empty answer can keep it.
        // Best-effort: a config too broken to read is precisely one people
        // re-run `init` to replace, so it just means there is nothing to keep.
        const previous = alreadyExists && canPrompt ? yield* readPreviousConfig : null;

        // Start from the JSON document so keys it carries that `init` does not
        // collect itself (notably `hosts`) reach `validateConfig` untouched.
        // Host targets are not asked here either, so they would be silently
        // wiped by an overwrite — carry the existing ones over instead.
        const assembled: Record<string, unknown> = { ...(previous ? { hosts: previous.hosts } : {}), ...document };
        const missing: string[] = [];

        for (const field of FIELDS) {
          const provided = flagValue(options, field) ?? process.env[toEnvVar(field)] ?? assembled[field];

          if (provided !== undefined && provided !== "") {
            assembled[field] = provided;
            continue;
          }

          if (canPrompt) {
            const kept = previous?.[field];
            const answer = yield* prompt(() => PROMPTS[field](kept));
            assembled[field] = answer === "" && kept !== undefined ? kept : answer;
            continue;
          }

          missing.push(`--${toFlag(field)} / ${toEnvVar(field)}`);
        }

        if (missing.length > 0) return yield* Effect.fail(new NonInteractiveConfigError({ missing }));

        const config = yield* validateConfig(assembled);

        yield* writeConfig(config);

        log.success(`File saved at ${configPath}`);
        outro("Done");
      })
    )
  );
