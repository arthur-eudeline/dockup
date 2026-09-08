import { confirm, intro, log, outro, password as passwordPrompt, select, text } from "@clack/prompts";
import type { SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";
import { z } from "zod";

import { checkHostTarget } from "../../lib/backup";
import { runStandalone } from "../../lib/cli";
import {
  configPath,
  DATABASE_HOST_TARGET_SCHEMA,
  HOST_TARGET_BASE_SCHEMA,
  INSTANCE_HOST_TARGET_SCHEMA,
  readConfig,
  validateConfig,
  writeConfig,
} from "../../lib/config";
import type { Config, HostTarget } from "../../lib/config";
import { PromptCancelledError } from "../../lib/errors";
import { prompt, promptSelect, safeSpinner } from "../../lib/prompts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5432;
const DEFAULT_DISCOVERY_DATABASE = "postgres";

/** Renders a target the way `config check` and `target list` both show it. */
const describe = (target: HostTarget): string => {
  const endpoint = `${chalk.blue(target.name)} — postgres ${chalk.yellow(`${target.host}:${target.port}`)} user=${target.user}`;

  if (target.scope === "database") return `${endpoint} db=${target.database}`;

  const excluding = target.exclude.length > 0 ? `, excluding ${target.exclude.join(", ")}` : "";
  return `${endpoint} ALL databases (discovered via ${target.discoveryDatabase}${excluding})`;
};

const validateWith = (schema: z.ZodType) => (value: unknown) => {
  const { error } = schema.safeParse(value);
  if (error) return z.prettifyError(error);
};

const ConfigTargetListCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List the host databases dockup backs up")
  .action(() =>
    runStandalone(
      Effect.gen(function* _list() {
        const config = yield* readConfig;

        if (config.hosts.length === 0) {
          log.info(`No host target declared. Add one with ${chalk.yellow("dockup config target add")}.`);
          return;
        }

        log.info(config.hosts.map(describe).join("\n"));
      })
    )
  );

/** How much of a target dockup already knows before the scope-specific prompts. */
interface CommonTargetFields {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
}

const promptCommonFields = (taken: Set<string>): Effect.Effect<CommonTargetFields, PromptCancelledError> =>
  Effect.gen(function* _promptCommonFields() {
    const name = yield* prompt(() =>
      text({
        message: "Backup name (used as the restic tag — keep it stable)",
        placeholder: "app-db",
        validate(value) {
          if (value !== undefined && taken.has(value)) return `A host target named "${value}" already exists`;
          return validateWith(HOST_TARGET_BASE_SCHEMA.shape.name)(value);
        },
      })
    );

    // The defaulted fields accept an empty answer and fall back here rather than
    // through the schema: `.default()` only fires on `undefined`, and an
    // untouched prompt hands back "".
    const host = yield* prompt(() =>
      text({
        message: "Host",
        defaultValue: DEFAULT_HOST,
        placeholder: DEFAULT_HOST,
        validate: (value) => (value ? validateWith(HOST_TARGET_BASE_SCHEMA.shape.host)(value) : undefined),
      })
    );

    const port = yield* prompt(() =>
      text({
        message: "Port",
        defaultValue: String(DEFAULT_PORT),
        placeholder: String(DEFAULT_PORT),
        validate: (value) => (value ? validateWith(HOST_TARGET_BASE_SCHEMA.shape.port)(Number(value)) : undefined),
      })
    );

    const user = yield* prompt(() =>
      text({
        message: "Postgres user",
        validate: validateWith(HOST_TARGET_BASE_SCHEMA.shape.user),
      })
    );

    const password = yield* prompt(() =>
      passwordPrompt({
        message: "Password",
        validate: validateWith(HOST_TARGET_BASE_SCHEMA.shape.password),
      })
    );

    return { host: host || DEFAULT_HOST, name, password, port: port ? Number(port) : DEFAULT_PORT, user };
  });

const ConfigTargetAddCommand = new Command()
  .name("add")
  .description("Declare a database, or every database, running on the host outside any container")
  .action(() =>
    runStandalone(
      Effect.gen(function* _add() {
        intro("New host backup target :");

        const config = yield* readConfig;
        const taken = new Set(config.hosts.map((host) => host.name));

        const scope = yield* prompt(() =>
          select({
            message: "What should this target back up ?",
            options: [
              { hint: "one database, named below", label: "A single database", value: "database" as const },
              {
                hint: "every database the server reports, minus any you exclude",
                label: "The whole instance",
                value: "instance" as const,
              },
            ],
          })
        );

        const common = yield* promptCommonFields(taken);

        const target: HostTarget = yield* scope === "database"
          ? Effect.gen(function* _database() {
              const database = yield* prompt(() =>
                text({
                  message: "Database",
                  validate: validateWith(DATABASE_HOST_TARGET_SCHEMA.shape.database),
                })
              );

              return { ...common, database, scope: "database", type: "postgres" } satisfies HostTarget;
            })
          : Effect.gen(function* _instance() {
              const discoveryDatabase = yield* prompt(() =>
                text({
                  message: "Database to connect to for the discovery query (must already exist)",
                  defaultValue: DEFAULT_DISCOVERY_DATABASE,
                  placeholder: DEFAULT_DISCOVERY_DATABASE,
                  validate: (value) =>
                    value ? validateWith(INSTANCE_HOST_TARGET_SCHEMA.shape.discoveryDatabase)(value) : undefined,
                })
              );

              const excludeInput = yield* prompt(() =>
                text({
                  message: "Databases to exclude, comma-separated (optional)",
                  defaultValue: "",
                  placeholder: "template_postgis, some_scratch_db",
                })
              );

              const exclude = excludeInput
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0);

              return {
                ...common,
                discoveryDatabase: discoveryDatabase || DEFAULT_DISCOVERY_DATABASE,
                exclude,
                scope: "instance",
                type: "postgres",
              } satisfies HostTarget;
            });

        // Probed before it is written: a target nobody can connect to is a red
        // line in tomorrow's report, and the operator is right here to fix it.
        // For an instance target this also surfaces exactly which databases were
        // found, so a missing `exclude` entry is caught right away.
        const reachable = yield* safeSpinner(checkHostTarget(target), {
          title: "Connecting to the database...",
          onSuccess: (result) =>
            result.databases.length === 1
              ? chalk.green(`${result.databases[0]} reached at ${target.host}:${target.port}`)
              : chalk.green(
                  `${result.databases.length} databases reached at ${target.host}:${target.port} : ${result.databases.join(", ")}`
                ),
          onError: (e) => chalk.red(`Could not reach the database :\n${e.message}`),
        });

        if (reachable === null) {
          const keep = yield* prompt(() => confirm({ message: "Save it anyway ?", initialValue: false }));
          if (!keep) return yield* Effect.fail(new PromptCancelledError({ reason: "Target not saved." }));
        }

        yield* writeConfig(yield* validateConfig({ ...config, hosts: [...config.hosts, target] } satisfies Config));

        log.success(`Target ${chalk.blue(common.name)} saved in ${configPath}`);
        outro("Done");
      })
    )
  );

const ConfigTargetRemoveCommand = new Command()
  .name("remove")
  .alias("rm")
  .description("Stop backing up a host database")
  .action(() =>
    runStandalone(
      Effect.gen(function* _remove() {
        intro("Remove a host backup target :");

        const config = yield* readConfig;

        if (config.hosts.length === 0) {
          log.info("No host target declared — nothing to remove.");
          return;
        }

        const target = yield* promptSelect({
          message: "Which target should dockup stop backing up ?",
          options: config.hosts.map((host) => ({ label: host.name, hint: `${host.host}:${host.port}`, value: host })),
        } as SelectOptions<HostTarget>);

        const confirmed = yield* prompt(() =>
          confirm({ message: `Stop backing up ${target.name} ?`, initialValue: false })
        );
        if (!confirmed) return yield* Effect.fail(new PromptCancelledError({}));

        yield* writeConfig(
          yield* validateConfig({
            ...config,
            hosts: config.hosts.filter((host) => host.name !== target.name),
          } satisfies Config)
        );

        log.success(`Target ${chalk.blue(target.name)} removed from ${configPath}`);
        // Neither is dockup's call to make: the snapshots are still the only copy
        // of that data, and the health entries expire on their own.
        if (target.scope === "database") {
          log.info(
            `Its snapshots are untouched — remove them with ${chalk.yellow(`dockup restic forget --tag ${target.name} --prune`)} if you mean to.`
          );
        } else {
          // Each discovered database got its own tag (`<name>-<database>`) —
          // restic `--tag` takes exact names, no prefix match, so list them first.
          log.info(
            `Its snapshots are untouched, one tag per database it covered (\`${target.name}-<database>\`) — run ${chalk.yellow("dockup restic snapshots")} to list them, then ${chalk.yellow("dockup restic forget --tag <tag> --prune")} for each if you mean to remove them.`
          );
        }
        outro("Done");
      })
    )
  );

export const ConfigTargetCommand = new Command()
  .name("target")
  .alias("targets")
  .description("Manage the databases dockup backs up directly on the host, outside docker")
  .addCommand(ConfigTargetListCommand)
  .addCommand(ConfigTargetAddCommand)
  .addCommand(ConfigTargetRemoveCommand);
