import { $ } from "bun";
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
import type { ParsingError } from "./errors";
import { ShellCommandFailureError, UndefinedVariableError } from "./errors";
import { configToResticEnv, parseResticBackupOutput } from "./restic";
import type { ResticSuccessfulBackupStructuredOutput } from "./restic";
import type { TaskLog } from "./types";
import { streamShellOutput } from "./utils";

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
      Effect.catchAll(() => Effect.succeed(null))
    );

    const password = yield* getContainerEnvVariable(containerId, vars, "MARIADB_PASSWORD", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () =>
        getContainerEnvVariable(containerId, vars, "MYSQL_PASSWORD", true)
      ),
      Effect.catchAll(() => Effect.succeed(null))
    );

    if (!password && !passwordFile) {
      return yield* Effect.fail(new UndefinedVariableError({ variable: "MARIADB_PASSWORD | MARIADB_PASSWORD_FILE" }));
    }

    return yield* Effect.succeed({
      user,
      database,
      password: passwordFile ?? password,
    });
  });

/**
 * Backup a MariaDB database using the mariadb-dump command
 */
export const backupMariaDB = (
  container: ContainerBackupConfig
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  ShellCommandFailureError | UndefinedVariableError | ParsingError,
  ConfigTag
> =>
  Effect.gen(function* _backupMariaDB() {
    const mdb = yield* getMariadbEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const result = yield* Effect.tryPromise({
      try: () =>
        $`docker exec ${container.id} mariadb-dump -u ${mdb.user} --password="${mdb.password}" --databases ${mdb.database} --skip-comments -C | restic backup --stdin --stdin-filename "${container.backupName}.sql" --tag "${container.backupName}" --skip-if-unchanged --json --host ${container.backupName}`
          .env(env)
          .text(),
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `The mariadb-dump command failed for the backup ${container.backupName} on the container ${container.id}`,
        }),
    });

    return yield* parseResticBackupOutput(container.backupName, result);
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
      cmd: `restic dump ${snapshotId} /${container.backupName}.sql | docker exec -i ${container.id} mariadb -u ${mdb.user} --password="${mdb.password}"`,
      env,
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
    const passwordFile = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_PASSWORD_FILE", true).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    const password = yield* getContainerEnvVariable(containerId, vars, "POSTGRES_PASSWORD").pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );

    if (!password && !passwordFile) {
      return yield* Effect.fail(new UndefinedVariableError({ variable: "POSTGRES_PASSWORD | POSTGRES_PASSWORD_FILE" }));
    }

    return yield* Effect.succeed({
      user,
      database,
      password: passwordFile ?? password,
    });
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
  UndefinedVariableError | ShellCommandFailureError | ParsingError,
  ConfigTag
> =>
  Effect.gen(function* _backupPostgres() {
    const pg = yield* getPostgresEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* streamShellOutput({
      cmd: `docker exec ${container.id} pg_dump --clean --if-exists --no-comments --no-owner --no-privileges -d "postgresql://${pg.user}:${pg.password}@$localhost:5432/${pg.database}" | restic backup --stdin --stdin-filename "${container.backupName}.sql" --tag "${container.backupName}" --skip-if-unchanged --json --host ${container.backupName}`,
      env,
      logger,
    });

    return yield* parseResticBackupOutput(container.backupName, output);
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
      cmd: `restic dump ${snapshotId} /${container.backupName}.sql | docker exec -i ${container.id} psql "postgresql://${pg.user}:${pg.password}@$localhost:5432/${pg.database}"`,
      env,
      logger,
    });
  });

/**
 * Backup volumes of a container
 * @param container the container infos
 * @returns the backup
 */
export const backupVolumes = (
  container: ContainerBackupConfig,
  logger: TaskLog
): Effect.Effect<
  // ResticSuccessfulVolumeBackupStructuredOutput[],
  ResticSuccessfulBackupStructuredOutput,
  ShellCommandFailureError | UndefinedVariableError | ParsingError,
  ConfigTag
> =>
  Effect.gen(function* _backupVolumes() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const volumes = yield* getContainerVolumes(container.id);
    const volumeArgs = yield* formatVolumeToArgs(volumes);
    const volumeDests = volumes.map((v) => v.Destination).join(" ");
    const envArgs = yield* formatResticConfigToEnvArgs(env);

    const output = yield* streamShellOutput({
      logger,
      cmd: `docker run --rm \
  --name dockup-restic-backup \
  --network host \
  ${volumeArgs} \
  ${envArgs} \
  restic/restic:latest backup ${volumeDests} --tag ${container.backupName} --json --host ${container.backupName}`,
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
  Effect.gen(function* _backupVolumes() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const stoppingLogger = logger.group(`Stopping container ${chalk.yellow(container.id)}`);
    yield* streamShellOutput({
      cmd: `docker stop ${container.id}`,
      logger: stoppingLogger,
      onError: () => stoppingLogger.error(`Failed to stop container ${chalk.yellow(container.id)}`),
      onSuccess: () => stoppingLogger.success(chalk.green(`Container ${chalk.yellow(container.id)} stopped.`)),
    });

    const volumes = yield* getContainerVolumes(container.id);
    const volumeArgs = yield* formatVolumeToArgs(volumes);
    const envArgs = yield* formatResticConfigToEnvArgs(env);

    yield* streamShellOutput({
      logger,
      cmd: `docker run --rm \
  --name dockup-restic-backup \
  --network host \
  ${volumeArgs} \
  ${envArgs} \
  restic/restic:latest restore ${snapshotId} --target / ${volumes.map((_v) => `--include ${_v.Destination}`).join(" ")} --json`,
    });

    const startLogger = logger.group(`Restarting container ${chalk.yellow(container.id)}`);
    yield* streamShellOutput({
      cmd: `docker start ${container.id}`,
      env,
      logger: startLogger,
      onError: () => startLogger.error(`Failed to restart container${chalk.yellow(container.id)}`),
      onSuccess: () =>
        startLogger.success(chalk.green(`Container ${chalk.yellow(container.id)} restarted successfully.`)),
    });
  });
