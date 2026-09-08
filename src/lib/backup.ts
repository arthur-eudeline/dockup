import chalk from "chalk";
import { Effect } from "effect";

import type { HostTarget, InstanceHostTarget } from "./config";
import {
  formatResticConfigToEnvArgs,
  formatVolumeToArgs,
  getContainerEnvVariables,
  getContainerVolumes,
  getContainerEnvVariable,
} from "./docker";
import type { ContainerBackupConfig } from "./docker";
import { ConfigTag } from "./effect";
import type { EmptyBackupError, ParsingError } from "./errors";
import { ShellCommandFailureError, UndefinedVariableError } from "./errors";
import { registerSecret } from "./redact";
import { configToResticEnv, parseResticBackupOutput } from "./restic";
import type { ResticSuccessfulBackupStructuredOutput } from "./restic";
import type { HostBackupTarget, PostgresTarget, ResolvedHostConnection } from "./targets";
import type { TaskLog } from "./types";
import { getShellOutput, raw, sh, shellQuote, streamShellOutput } from "./utils";

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
 * How dockup runs the postgres client binaries against a given target.
 *
 * The two sources differ by their prefix and nothing else — `docker exec` into
 * the container, or the host's own `pg_dump`/`psql` pointed at a TCP endpoint —
 * so only this pair of fragments is built per source; the restic side of the
 * pipe is shared.
 */
interface PostgresAccess {
  /** `pg_dump …`, writing the dump to stdout. */
  dump: string;
  /** `psql …`, reading a dump from stdin. */
  restore: string;
  /** Passed through the environment as PGPASSWORD — never on a command line. */
  password: string;
}

/**
 * `-w` on both binaries: without it libpq falls back to prompting for a password
 * on /dev/tty when the one it was given is refused, which would hang an
 * unattended run rather than fail it.
 */
const PG_DUMP_FLAGS = raw("--clean --if-exists --no-comments --no-owner --no-privileges -w");
const PSQL_FLAGS = raw("-v ON_ERROR_STOP=1 -w");

const containerPostgresAccess = (
  container: ContainerBackupConfig
): Effect.Effect<PostgresAccess, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _containerPostgresAccess() {
    const pg = yield* getPostgresEnvVariables(container.id);

    // `-U`/`-d` rather than a `postgresql://user:password@…` URI: the password
    // goes through PGPASSWORD (out of the process table), and a `@`, `/` or `#`
    // in the user or database name no longer needs percent-encoding to parse.
    return {
      dump: sh`docker exec -e PGPASSWORD ${container.id} pg_dump ${PG_DUMP_FLAGS} -U ${pg.user} -d ${pg.database}`,
      password: pg.password,
      restore: sh`docker exec -i -e PGPASSWORD ${container.id} psql ${PSQL_FLAGS} -U ${pg.user} -d ${pg.database}`,
    };
  });

/** The `-h/-p/-U/-d` flags addressing a resolved connection, every value quoted. */
const connectionFlags = (connection: ResolvedHostConnection) =>
  raw(sh`-h ${connection.host} -p ${String(connection.port)} -U ${connection.user} -d ${connection.database}`);

/**
 * A database on the host runs no container to exec into: the client binaries are
 * the host's own (so `pg_dump`/`psql` must be on PATH, and at least as recent as
 * the server), and the credentials come from the config file rather than from a
 * container's environment.
 */
const hostPostgresAccess = (connection: ResolvedHostConnection): Effect.Effect<PostgresAccess> =>
  Effect.sync(() => {
    registerSecret(connection.password);
    const flags = connectionFlags(connection);

    return {
      dump: sh`pg_dump ${PG_DUMP_FLAGS} ${flags}`,
      password: connection.password,
      restore: sh`psql ${PSQL_FLAGS} ${flags}`,
    };
  });

const postgresAccess = (
  target: PostgresTarget
): Effect.Effect<PostgresAccess, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  target.source === "host" ? hostPostgresAccess(target.connection) : containerPostgresAccess(target);

/** Builds the connection a `HostTarget` opens to reach one specific database. */
const resolvedConnection = (target: HostTarget, database: string): ResolvedHostConnection => ({
  database,
  host: target.host,
  password: target.password,
  port: target.port,
  user: target.user,
});

/** `pg_dump`/`psql` must be on PATH — checked once, up front, by whatever needs them on the host. */
const ensurePgClientsOnPath = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput("command -v pg_dump && command -v psql").pipe(
    Effect.mapError(
      (cause) =>
        new ShellCommandFailureError({
          cause,
          message: "pg_dump and psql must be on PATH — install the postgresql client package on this host.",
        })
    )
  );

/** Opens a connection just to prove it works — `select 1`, nothing more. */
const probeConnection = (connection: ResolvedHostConnection): Effect.Effect<void, ShellCommandFailureError> =>
  streamShellOutput({
    cmd: sh`psql ${PSQL_FLAGS} ${connectionFlags(connection)} -tAc 'select 1'`,
    env: { PGPASSWORD: connection.password },
  });

const DISCOVER_DATABASES_QUERY =
  "select datname from pg_database where datallowconn and not datistemplate order by datname";

/**
 * Asks the server for every database an `"instance"`-scoped target should back
 * up: everything that is not a template and accepts connections, minus the
 * names the target excludes. Connects to `discoveryDatabase` to run the query —
 * a role with no default database still needs one to log into.
 */
const discoverInstanceDatabases = (target: InstanceHostTarget): Effect.Effect<string[], ShellCommandFailureError> =>
  Effect.gen(function* _discoverInstanceDatabases() {
    registerSecret(target.password);
    const discovery = resolvedConnection(target, target.discoveryDatabase);

    const output = yield* streamShellOutput({
      cmd: sh`psql ${PSQL_FLAGS} ${connectionFlags(discovery)} -tAc ${DISCOVER_DATABASES_QUERY}`,
      env: { PGPASSWORD: target.password },
    });

    const excluded = new Set(target.exclude);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !excluded.has(line));
  });

/** How many databases `checkHostTarget` reports it found and could open. */
export interface HostTargetCheckResult {
  databases: string[];
}

/**
 * Probes a host target exactly the way `backup` will use it: the client
 * binaries must be on PATH, and the credentials must actually open the
 * database — every database, for an `"instance"`-scoped target. Used by
 * `config check` and `config target add` — a target declared with a typo would
 * otherwise only surface as a red line in the first nightly report.
 */
export const checkHostTarget = (target: HostTarget): Effect.Effect<HostTargetCheckResult, ShellCommandFailureError> =>
  Effect.gen(function* _checkHostTarget() {
    registerSecret(target.password);
    yield* ensurePgClientsOnPath();

    if (target.scope === "database") {
      yield* probeConnection(resolvedConnection(target, target.database));
      return { databases: [target.database] };
    }

    const databases = yield* discoverInstanceDatabases(target);
    yield* Effect.all(
      databases.map((database) => probeConnection(resolvedConnection(target, database))),
      { concurrency: 4 }
    );
    return { databases };
  });

/**
 * Resolves one declared `HostTarget` into the concrete, single-database
 * targets `backup`/`restore` actually run against — trivially for a
 * `"database"`-scoped one, by discovery for an `"instance"`-scoped one.
 */
const resolveOneHostTarget = (target: HostTarget): Effect.Effect<HostBackupTarget[], ShellCommandFailureError> =>
  Effect.gen(function* _resolveOneHostTarget() {
    registerSecret(target.password);

    if (target.scope === "database") {
      return [
        {
          backupName: target.name,
          connection: resolvedConnection(target, target.database),
          source: "host",
          type: "postgres",
        } satisfies HostBackupTarget,
      ];
    }

    const databases = yield* discoverInstanceDatabases(target);
    // `<name>-<database>` : distinct instances never collide (target names are
    // unique — see `CONFIG_SCHEMA`), and a `"database"`-scoped target keeps its
    // exact declared name, so an existing single-database setup is unaffected.
    return databases.map(
      (database): HostBackupTarget => ({
        backupName: `${target.name}-${database}`,
        connection: resolvedConnection(target, database),
        source: "host",
        type: "postgres",
      })
    );
  });

export interface HostDiscovery {
  targets: HostBackupTarget[];
  /** Declared targets whose databases could not be resolved — reported, never silently dropped. */
  invalid: { name: string; error: ShellCommandFailureError }[];
}

/**
 * Resolves every declared host target. Per-target best-effort, like
 * `listBackupEnabledContainers` for containers : one postgres instance being
 * down must not cancel the databases another instance would still back up.
 */
export const resolveHostTargets = (hosts: HostTarget[]): Effect.Effect<HostDiscovery> =>
  Effect.gen(function* _resolveHostTargets() {
    const [invalid, groups] = yield* Effect.partition(
      hosts,
      (target) => resolveOneHostTarget(target).pipe(Effect.mapError((error) => ({ name: target.name, error }))),
      { concurrency: "unbounded" }
    );

    return { invalid: [...invalid], targets: groups.flat() };
  });

/**
 * Backups a postgres database using the pg_dump command
 *
 * @param target The container or host backup target
 * @returns The command structured output
 */
export const backupPostgres = (
  target: PostgresTarget,
  logger: TaskLog
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  UndefinedVariableError | ShellCommandFailureError | ParsingError | EmptyBackupError,
  ConfigTag
> =>
  Effect.gen(function* _backupPostgres() {
    const access = yield* postgresAccess(target);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* streamShellOutput({
      cmd: sh`${raw(access.dump)} | restic backup --stdin --stdin-filename ${`${target.backupName}.sql`} --tag ${target.backupName} --skip-if-unchanged --json --host ${target.backupName}`,
      env: { ...env, PGPASSWORD: access.password },
      logger,
    });

    return yield* parseResticBackupOutput(target.backupName, output, { rejectEmpty: true });
  });

/**
 * restore postgres backup
 *
 * @param target the container or host backup target
 * @param snapshotId the snapshot id to restore
 * @returns void
 */
export const restorePostgres = (
  target: PostgresTarget,
  snapshotId: string,
  logger: TaskLog
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restorePostgres() {
    const access = yield* postgresAccess(target);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    yield* streamShellOutput({
      cmd: sh`restic dump ${snapshotId} ${`/${target.backupName}.sql`} | ${raw(access.restore)}`,
      env: { ...env, PGPASSWORD: access.password },
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
