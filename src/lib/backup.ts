import chalk from "chalk";
import { Effect } from "effect";

import {
  formatResticConfigToEnvArgs,
  formatVolumeToArgs,
  getContainerEnvVariables,
  getContainerVolumes,
  getContainerEnvVariable,
} from "./docker";
import type { ContainerBackupConfig } from "./docker";
import { ConfigTag } from "./effect";
import type { EmptyBackupError, ParsingError , ShellCommandFailureError} from "./errors";
import { UndefinedVariableError } from "./errors";
import { registerSecret } from "./redact";
import { configToResticEnv, parseResticBackupOutput } from "./restic";
import type { ResticSuccessfulBackupStructuredOutput } from "./restic";
import type { TaskLog } from "./types";
import { raw, sh, shellQuote, streamShellOutput } from "./utils";

/**
 * Gets the required mariadb required env variables
 * @param containerId The container id to retrieve env variables from
 * @returns the env variables
 */
const getMariadbEnvVariables = (containerId: string) =>
  Effect.gen(function* _getMariadbEnvVariables() {
    const vars = yield* getContainerEnvVariables(containerId);

    const user = yield* getContainerEnvVariable(containerId, vars, "MARIADB_USER").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, vars, "MYSQL_USER"))
    );

    const database = yield* getContainerEnvVariable(containerId, vars, "MARIADB_DATABASE").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, vars, "MYSQL_DATABASE"))
    );

    const passwordFile = yield* getContainerEnvVariable(containerId, vars, "MARIADB_PASSWORD_FILE", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () =>
        getContainerEnvVariable(containerId, vars, "MYSQL_PASSWORD_FILE", true)
      ),
      // Only a *missing* variable falls back to the plain password: a failure to
      // read the secret file must surface, not be mistaken for "no secret file".
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );

    // No `file` flag here: the variable holds the password itself, not a path to it.
    const password = yield* getContainerEnvVariable(containerId, vars, "MARIADB_PASSWORD").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, vars, "MYSQL_PASSWORD")),
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );

    const resolved = passwordFile ?? password;
    if (!resolved) {
      return yield* Effect.fail(new UndefinedVariableError({ variable: "MARIADB_PASSWORD | MARIADB_PASSWORD_FILE" }));
    }

    yield* Effect.sync(() => registerSecret(resolved));

    return { user, database, password: resolved };
  });

/**
 * Backup a MariaDB database using the mariadb-dump command
 */
export const backupMariaDB = (
  container: ContainerBackupConfig,
  logger: TaskLog
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  ShellCommandFailureError | UndefinedVariableError | ParsingError | EmptyBackupError,
  ConfigTag
> =>
  Effect.gen(function* _backupMariaDB() {
    const mdb = yield* getMariadbEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    // The password travels as MYSQL_PWD through the environment rather than as
    // `--password=…`, keeping it out of the process table and of any error
    // message quoting the command.
    const output = yield* streamShellOutput({
      cmd: sh`docker exec -e MYSQL_PWD ${container.id} mariadb-dump -u ${mdb.user} --databases ${mdb.database} --skip-comments | restic backup --stdin --stdin-filename ${`${container.backupName}.sql`} --tag ${container.backupName} --skip-if-unchanged --json --host ${container.backupName}`,
      env: { ...env, MYSQL_PWD: mdb.password },
      logger,
    });

    return yield* parseResticBackupOutput(container.backupName, output, { rejectEmpty: true });
  });

/**
 * restore postgres backup
 *
 * @param container the container infos
 * @param snapshotId the snapshot id to restore
 * @returns void
 */
export const restoreMariaDB = (
  container: ContainerBackupConfig,
  snapshotId: string,
  logger: TaskLog
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restoreMariaDB() {
    const mdb = yield* getMariadbEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    yield* streamShellOutput({
      // The dump was taken with `--databases`, so it carries its own CREATE/USE:
      // no target database is passed here.
      cmd: sh`restic dump ${snapshotId} ${`/${container.backupName}.sql`} | docker exec -i -e MYSQL_PWD ${container.id} mariadb -u ${mdb.user}`,
      env: { ...env, MYSQL_PWD: mdb.password },
      logger,
    });
  });

/**
 * Gets required env variables from a container ID
 * @param containerId The container ID to retrieve envariables from
 * @returns The env variables object
 */
const getPostgresEnvVariables = (containerId: string) =>
  Effect.gen(function* _getPostgresEnvVariables() {
    const vars = yield* getContainerEnvVariables(containerId);

    const user = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_USER");
    const database = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_DB");
    // Only a *missing* variable falls back to the plain password: a failure to
    // read the secret file must surface, not be mistaken for "no secret file".
    const passwordFile = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_PASSWORD_FILE", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );
    const password = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_PASSWORD").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );

    const resolved = passwordFile ?? password;
    if (!resolved) {
      return yield* Effect.fail(new UndefinedVariableError({ variable: "POSTGRES_PASSWORD | POSTGRES_PASSWORD_FILE" }));
    }

    yield* Effect.sync(() => registerSecret(resolved));

    return { user, database, password: resolved };
  });

/**
 * Backups a postgres container using pg_dump command
 *
 * @param container The contianer backup configuration object
 * @returns The command structured output
 */
export const backupPostgres = (
  container: ContainerBackupConfig,
  logger: TaskLog
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  UndefinedVariableError | ShellCommandFailureError | ParsingError | EmptyBackupError,
  ConfigTag
> =>
  Effect.gen(function* _backupPostgres() {
    const pg = yield* getPostgresEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    // `-U`/`-d` rather than a `postgresql://user:password@…` URI: the password
    // goes through PGPASSWORD (out of the process table), and a `@`, `/` or `#`
    // in the user or database name no longer needs percent-encoding to parse.
    const output = yield* streamShellOutput({
      cmd: sh`docker exec -e PGPASSWORD ${container.id} pg_dump --clean --if-exists --no-comments --no-owner --no-privileges -U ${pg.user} -d ${pg.database} | restic backup --stdin --stdin-filename ${`${container.backupName}.sql`} --tag ${container.backupName} --skip-if-unchanged --json --host ${container.backupName}`,
      env: { ...env, PGPASSWORD: pg.password },
      logger,
    });

    return yield* parseResticBackupOutput(container.backupName, output, { rejectEmpty: true });
  });

/**
 * restore postgres backup
 *
 * @param container the container infos
 * @param snapshotId the snapshot id to restore
 * @returns void
 */
export const restorePostgres = (
  container: ContainerBackupConfig,
  snapshotId: string,
  logger: TaskLog
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restorePostgres() {
    const pg = yield* getPostgresEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    yield* streamShellOutput({
      cmd: sh`restic dump ${snapshotId} ${`/${container.backupName}.sql`} | docker exec -i -e PGPASSWORD ${container.id} psql -v ON_ERROR_STOP=1 -U ${pg.user} -d ${pg.database}`,
      env: { ...env, PGPASSWORD: pg.password },
      logger,
    });
  });

/**
 * Names the throwaway `restic/restic` container.
 *
 * Unique per operation and per run: the previous fixed `dockup-restic-backup`
 * was reused for restores too, and a leftover from an interrupted run made the
 * next one fail on a name collision.
 */
const helperContainerName = (operation: "backup" | "restore", backupName: string): string =>
  `dockup-restic-${operation}-${backupName.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}`;

/**
 * Backup volumes of a container
 * @param container the container infos
 * @returns the backup
 */
export const backupVolumes = (
  container: ContainerBackupConfig,
  logger: TaskLog
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  ShellCommandFailureError | UndefinedVariableError | ParsingError | EmptyBackupError,
  ConfigTag
> =>
  Effect.gen(function* _backupVolumes() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const volumes = yield* getContainerVolumes(container.id);
    const volumeArgs = yield* formatVolumeToArgs(volumes);
    const volumeDests = volumes.map((v) => shellQuote(v.Destination)).join(" ");
    const envArgs = yield* formatResticConfigToEnvArgs();

    const output = yield* streamShellOutput({
      logger,
      // `env` is passed through so the `-e NAME` flags above resolve from this
      // process' environment instead of spelling the credentials on the command line.
      env,
      cmd: sh`docker run --rm --name ${helperContainerName("backup", container.backupName)} --network host ${raw(volumeArgs)} ${raw(envArgs)} restic/restic:latest backup ${raw(volumeDests)} --tag ${container.backupName} --json --host ${container.backupName}`,
    });

    return yield* parseResticBackupOutput(container.backupName, output);
  });

/**
 * restore the container volumes
 * @param container The container config
 * @param snapshotId The snapshot id to restore from
 * @returns void
 */
export const restoreVolumes = (
  container: ContainerBackupConfig,
  snapshotId: string,
  logger: TaskLog
): Effect.Effect<void, UndefinedVariableError | ShellCommandFailureError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restoreVolumes() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const stoppingLogger = logger.group(`Stopping container ${chalk.yellow(container.id)}`);
    yield* streamShellOutput({
      cmd: sh`docker stop ${container.id}`,
      logger: stoppingLogger,
      onError: () => stoppingLogger.error(`Failed to stop container ${chalk.yellow(container.id)}`),
      onSuccess: () => stoppingLogger.success(chalk.green(`Container ${chalk.yellow(container.id)} stopped.`)),
    });

    const startLogger = logger.group(`Restarting container ${chalk.yellow(container.id)}`);
    // The container was stopped above, so it must come back up no matter what
    // happens next — a restore failure or a Ctrl-C included. `Effect.ensuring`
    // runs this as an uninterruptible finalizer; errors here are swallowed so it
    // can never mask the original failure.
    const restart = streamShellOutput({
      cmd: sh`docker start ${container.id}`,
      logger: startLogger,
      onError: () => startLogger.error(`Failed to restart container ${chalk.yellow(container.id)}`),
      onSuccess: () =>
        startLogger.success(chalk.green(`Container ${chalk.yellow(container.id)} restarted successfully.`)),
    }).pipe(Effect.catchAll(() => Effect.void));

    const restore = Effect.gen(function* _restore() {
      const volumes = yield* getContainerVolumes(container.id);
      const volumeArgs = yield* formatVolumeToArgs(volumes);
      const envArgs = yield* formatResticConfigToEnvArgs();
      const includeArgs = volumes.map((v) => `--include ${shellQuote(v.Destination)}`).join(" ");

      yield* streamShellOutput({
        logger,
        env,
        cmd: sh`docker run --rm --name ${helperContainerName("restore", container.backupName)} --network host ${raw(volumeArgs)} ${raw(envArgs)} restic/restic:latest restore ${snapshotId} --target / ${raw(includeArgs)} --json`,
      });
    });

    yield* restore.pipe(Effect.ensuring(restart));
  });
