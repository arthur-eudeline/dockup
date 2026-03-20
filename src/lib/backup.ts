import { $ } from "bun";
import chalk from "chalk";
import { Effect } from "effect";
import { z } from "zod";

import type { ContainerBackupConfig } from "./docker";
import { ConfigTag } from "./effect";
import type { ParsingError } from "./errors";
import { ShellCommandFailureError, UndefinedVariableError } from "./errors";
import { configToResticEnv, parseResticBackupOutput } from "./restic";
import type { ResticSuccessfulBackupStructuredOutput, ResticSuccessfulVolumeBackupStructuredOutput } from "./restic";
import type { TaskLog } from "./types";
import { getContainerEnvVariable, streamShellOutput } from "./utils";

/**
 * Gets the required mariadb required env variables
 * @param containerId The container id to retrieve env variables from
 * @returns the env variables
 */
const getMariadbEnvVariables = (containerId: string) =>
  Effect.gen(function* _getMariadbEnvVariables() {
    const user = yield* getContainerEnvVariable(containerId, "MARIADB_USER").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, "MYSQL_USER"))
    );

    const database = yield* getContainerEnvVariable(containerId, "MARIADB_DATABASE").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, "MYSQL_DATABASE"))
    );

    const passwordFile = yield* getContainerEnvVariable(containerId, "MARIADB_PASSWORD_FILE", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () =>
        getContainerEnvVariable(containerId, "MYSQL_PASSWORD_FILE", true)
      ),
      Effect.catchAll(() => Effect.succeed(null))
    );

    const password = yield* getContainerEnvVariable(containerId, "MARIADB_PASSWORD", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => getContainerEnvVariable(containerId, "MYSQL_PASSWORD", true)),
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
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError, ConfigTag> =>
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
    const user = yield* getContainerEnvVariable(containerId, "POSTGRES_USER");
    const database = yield* getContainerEnvVariable(containerId, "POSTGRES_DB");
    const passwordFile = yield* getContainerEnvVariable(containerId, "POSTGRES_PASSWORD_FILE", true).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    const password = yield* getContainerEnvVariable(containerId, "POSTGRES_PASSWORD").pipe(
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
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError, ConfigTag> =>
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

const VOLUME_SCHEMA = z.object({
  Source: z.string(),
  Destination: z.string(),
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
  ResticSuccessfulVolumeBackupStructuredOutput[],
  ShellCommandFailureError | UndefinedVariableError | ParsingError,
  ConfigTag
> =>
  Effect.gen(function* _backupVolumes() {
    const raw = yield* Effect.promise(() => $`docker inspect --format='{{json .Mounts}}' ${container.id}`.text());
    const json = JSON.parse(raw);
    const volumes = z.array(VOLUME_SCHEMA).parse(json);

    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    return yield* Effect.all(
      volumes.map((v) =>
        Effect.gen(function* _b() {
          const output = yield* streamShellOutput({
            cmd: `restic backup ${v.Source} --tag ${container.backupName} --json --host ${container.backupName}`,
            env,
            logger,
          });

          const parsed = yield* parseResticBackupOutput(container.backupName, output);

          return yield* Effect.succeed({
            ...parsed,
            volumeName: v.Destination,
          });
        })
      )
    );
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
): Effect.Effect<void, UndefinedVariableError | ShellCommandFailureError, ConfigTag> =>
  Effect.gen(function* _backupVolumes() {
    const raw = yield* Effect.promise(() => $`docker inspect --format='{{json .Mounts}}' ${container.id}`.text());
    const json = JSON.parse(raw);
    const volumes = z.array(VOLUME_SCHEMA).parse(json);

    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const stoppingLogger = logger.group(`Stopping container ${chalk.yellow(container.id)}`);
    yield* streamShellOutput({
      cmd: `docker stop ${container.id}`,
      logger: stoppingLogger,
      onError: () => stoppingLogger.error(`Failed to stop container ${chalk.yellow(container.id)}`),
      onSuccess: () => stoppingLogger.success(chalk.green(`Container ${chalk.yellow(container.id)} stopped.`)),
    });

    yield* Effect.all(
      volumes.map((v) =>
        Effect.gen(function* _restoreVolumes() {
          const restoreLogger = logger.group(`Restoring snapshot ${snapshotId} for volume ${v.Destination}...`);
          yield* streamShellOutput({
            cmd: `restic restore ${snapshotId} --target / --include ${v.Source}`,
            env,
            logger: restoreLogger,
            onError: () => restoreLogger.error(`Failed to restore snapshot ${chalk.yellow(snapshotId)}`),
            onSuccess: () =>
              restoreLogger.success(chalk.green(`Snapshot ${chalk.yellow(snapshotId)} restored successfully.`)),
          });
        })
      )
    );

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
