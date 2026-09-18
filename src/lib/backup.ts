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
import type { EmptyBackupError } from "./errors";
import { ParsingError, ShellCommandFailureError, UndefinedVariableError } from "./errors";
import { registerSecret } from "./redact";
import { configToResticEnv, parseResticBackupOutput, RESTIC_PROGRESS_ENV, RESTIC_RETRY_LOCK } from "./restic";
import type { ResticSuccessfulBackupStructuredOutput } from "./restic";
import { typeTag } from "./sources";
import type { ClickhouseTarget, HostBackupTarget, PostgresTarget, ResolvedHostConnection } from "./targets";
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
      cmd: sh`docker exec -e MYSQL_PWD ${container.id} mariadb-dump -u ${mdb.user} --databases ${mdb.database} --skip-comments | restic backup ${raw(RESTIC_RETRY_LOCK)} --stdin --stdin-filename ${`${container.backupName}.sql`} --tag ${container.backupName} --tag ${typeTag("mariadb")} --skip-if-unchanged --json --host ${container.backupName}`,
      env: { ...env, MYSQL_PWD: mdb.password },
      logger,
    });

    return yield* parseResticBackupOutput(container.backupName, output, { rejectEmpty: true });
  });

/**
 * The dump a database restore reads back, and where it sits in the snapshot.
 *
 * The path is not `/<target>.sql`: the file is named after the backup it was
 * taken from, and `restore` can now be told to pour one backup into another
 * target (see `sources.ts`), so the two names part ways.
 */
export interface DumpToRestore {
  snapshotId: string;
  /** The dump's path *inside the snapshot*, as restic recorded it. */
  path: string;
}

/**
 * restore a mariadb backup into a container
 *
 * @param container the container to restore into
 * @param dump the dump to read back
 * @returns void
 */
export const restoreMariaDB = (
  container: ContainerBackupConfig,
  dump: DumpToRestore,
  logger: TaskLog
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restoreMariaDB() {
    const mdb = yield* getMariadbEnvVariables(container.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    yield* streamShellOutput({
      // The dump was taken with `--databases`, so it carries its own CREATE/USE:
      // no target database is passed here.
      cmd: sh`restic dump ${dump.snapshotId} ${dump.path} | docker exec -i -e MYSQL_PWD ${container.id} mariadb -u ${mdb.user}`,
      env: { ...env, ...RESTIC_PROGRESS_ENV, MYSQL_PWD: mdb.password },
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
  /** `psql … -tAc <sql>`, writing one bare row per line to stdout. */
  query: (sql: string) => string;
  /** Passed through the environment as PGPASSWORD — never on a command line. */
  password: string;
}

/**
 * Ownership and privileges stay *in* the dump — the `ALTER … OWNER TO` and the
 * `GRANT`s — because dropping them (`--no-owner --no-privileges`) hands every
 * restored object to whoever ran the restore, i.e. `POSTGRES_USER`. A server
 * holding one role per database comes back flattened onto the superuser, and
 * nothing says so: the restore succeeds. The roles those statements name are
 * created first when the destination does not know them ({@link ROLE_PRELUDE_QUERY}).
 *
 * `-w` on both binaries: without it libpq falls back to prompting for a password
 * on /dev/tty when the one it was given is refused, which would hang an
 * unattended run rather than fail it.
 */
const PG_DUMP_FLAGS = raw("--clean --if-exists -w");
const PSQL_FLAGS = raw("-v ON_ERROR_STOP=1 -w");

/**
 * Every role the dump is about to name, as one guarded `CREATE ROLE` each, ready
 * to be prepended to it.
 *
 * A dump that carries ownership is only restorable where those roles exist, and
 * the restore runs under `ON_ERROR_STOP=1` — a missing owner would abort it
 * halfway, *after* `--clean` has dropped the tables. So the dump is made
 * self-sufficient instead: it creates what it is going to reference.
 *
 * The query returns SQL text rather than a list of names, so `format()` does the
 * identifier and literal quoting server-side and no role name has to survive a
 * round trip through this process. Each statement is guarded by an `if not
 * exists`, so a destination that already knows the role is left exactly as it
 * was — attributes, password and memberships included; only a genuinely absent
 * role is created. Collected is what a plain dump can reference: owners and
 * grantees of schemas, relations, routines, types and default ACLs, outside the
 * system schemas. Built-in `pg_*` roles are skipped (they exist everywhere) and
 * the `PUBLIC` pseudo-grantee is oid 0, which joins to no row.
 *
 * Two things are deliberately *not* reproduced: the password, which lives in
 * `pg_authid` and would ship a credential inside every dump, and `superuser`,
 * forced off — restoring a backup may recreate an owner, never a way into the
 * server it was restored on.
 */
const ROLE_PRELUDE_QUERY = `
with system_schemas as (
  select oid from pg_namespace where left(nspname, 3) = 'pg_' or nspname = 'information_schema'
),
owned(owner, acl) as (
  select nspowner, nspacl from pg_namespace where oid not in (select oid from system_schemas)
  union all select relowner, relacl from pg_class where relnamespace not in (select oid from system_schemas)
  union all select proowner, proacl from pg_proc where pronamespace not in (select oid from system_schemas)
  union all select typowner, typacl from pg_type where typnamespace not in (select oid from system_schemas)
  union all select defaclrole, defaclacl from pg_default_acl
),
referenced(oid) as (
  select owner from owned
  union select (aclexplode(acl)).grantee from owned where acl is not null
)
select format(
  'do $dockup$ begin if not exists (select 1 from pg_roles where rolname = %L)'
  ' then create role %I nosuperuser %s %s %s %s; end if; end $dockup$;',
  r.rolname, r.rolname,
  case when r.rolcanlogin then 'login' else 'nologin' end,
  case when r.rolinherit then 'inherit' else 'noinherit' end,
  case when r.rolcreatedb then 'createdb' else 'nocreatedb' end,
  case when r.rolcreaterole then 'createrole' else 'nocreaterole' end
)
from pg_roles r
join referenced on referenced.oid = r.oid
where left(r.rolname, 3) <> 'pg_'
order by r.rolname
`;

/**
 * The stream a postgres backup pipes into restic: the `CREATE ROLE` prelude,
 * then the dump.
 *
 * Chained with `&&`, never `;` — a `{ a ; b ; }` group reports the status of its
 * *last* command, so a prelude query that failed would hand restic a dump whose
 * owners are unrestorable and record it as a success. Same reasoning as
 * {@link clickhouseDumpCommand}, same reason `bash -o pipefail` exists here.
 */
const postgresDumpCommand = (access: PostgresAccess): string =>
  `{ ${access.query(ROLE_PRELUDE_QUERY)} && ${access.dump}; }`;

const containerPostgresAccess = (
  container: ContainerBackupConfig
): Effect.Effect<PostgresAccess, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _containerPostgresAccess() {
    const pg = yield* getPostgresEnvVariables(container.id);
    // A container resolved out of `allDatabases` (see `resolveContainerTargets`)
    // pins the exact database it was discovered with; otherwise fall back to the
    // container's own `POSTGRES_DB`.
    const database = (container.type === "postgres" ? container.database : undefined) ?? pg.database;

    // `-U`/`-d` rather than a `postgresql://user:password@…` URI: the password
    // goes through PGPASSWORD (out of the process table), and a `@`, `/` or `#`
    // in the user or database name no longer needs percent-encoding to parse.
    return {
      dump: sh`docker exec -e PGPASSWORD ${container.id} pg_dump ${PG_DUMP_FLAGS} -U ${pg.user} -d ${database}`,
      password: pg.password,
      query: (sql: string) =>
        sh`docker exec -e PGPASSWORD ${container.id} psql ${PSQL_FLAGS} -U ${pg.user} -d ${database} -tAc ${sql}`,
      restore: sh`docker exec -i -e PGPASSWORD ${container.id} psql ${PSQL_FLAGS} -U ${pg.user} -d ${database}`,
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
      query: (sql: string) => sh`psql ${PSQL_FLAGS} ${flags} -tAc ${sql}`,
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
 * Asks a postgres container for every database it hosts, the same way
 * `discoverInstanceDatabases` does over TCP for an `"instance"`-scoped host
 * target — but through `docker exec`, since a container has no port declared
 * to open a connection from outside it.
 *
 * Connects to the container's own `POSTGRES_DB`: unlike a host target, a
 * container-bound role always has one to log into.
 */
const discoverContainerDatabases = (
  container: ContainerBackupConfig
): Effect.Effect<string[], ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _discoverContainerDatabases() {
    const pg = yield* getPostgresEnvVariables(container.id);

    const output = yield* getShellOutput(
      sh`docker exec -e PGPASSWORD ${container.id} psql ${PSQL_FLAGS} -U ${pg.user} -d ${pg.database} -tAc ${DISCOVER_DATABASES_QUERY}`,
      { env: { PGPASSWORD: pg.password } }
    );

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  });

/**
 * Resolves one discovered container into the concrete backup config(s)
 * `backup`/`restore` actually run against — trivially for every type but a
 * postgres container declaring `dockup.backup.all-databases=true`, which is
 * expanded into one target per database found on it, mirroring what
 * `resolveOneHostTarget` does for an `"instance"`-scoped host target.
 */
const resolveContainerTarget = (
  container: ContainerBackupConfig
): Effect.Effect<ContainerBackupConfig[], ShellCommandFailureError | UndefinedVariableError | ParsingError> => {
  if (container.type !== "postgres" || !container.allDatabases) {
    return Effect.succeed([container]);
  }

  return Effect.gen(function* _resolveContainerTarget() {
    const databases = yield* discoverContainerDatabases(container);
    // `<name>-<database>` : same convention as an `"instance"`-scoped host
    // target, so distinct databases never collide on one restic tag.
    return databases.map(
      (database): ContainerBackupConfig => ({
        ...container,
        backupName: `${container.backupName}-${database}`,
        database,
      })
    );
  });
};

export interface ContainerTargetResolution {
  containers: ContainerBackupConfig[];
  /** Containers whose databases could not be discovered — reported, never silently dropped. */
  invalid: { id: string; error: ShellCommandFailureError | UndefinedVariableError | ParsingError }[];
}

/**
 * Resolves every discovered container. Per-container best-effort, like
 * `listBackupEnabledContainers` itself and `resolveHostTargets` : one postgres
 * container being unreachable for its own discovery query must not cancel the
 * databases another container, or a host target, would still back up.
 */
export const resolveContainerTargets = (
  containers: ContainerBackupConfig[]
): Effect.Effect<ContainerTargetResolution> =>
  Effect.gen(function* _resolveContainerTargets() {
    const [invalid, groups] = yield* Effect.partition(
      containers,
      (container) => resolveContainerTarget(container).pipe(Effect.mapError((error) => ({ id: container.id, error }))),
      { concurrency: "unbounded" }
    );

    return { containers: groups.flat(), invalid: [...invalid] };
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
      cmd: sh`${raw(postgresDumpCommand(access))} | restic backup ${raw(RESTIC_RETRY_LOCK)} --stdin --stdin-filename ${`${target.backupName}.sql`} --tag ${target.backupName} --tag ${typeTag("postgres")} --skip-if-unchanged --json --host ${target.backupName}`,
      env: { ...env, PGPASSWORD: access.password },
      logger,
    });

    return yield* parseResticBackupOutput(target.backupName, output, { rejectEmpty: true });
  });

/**
 * The login roles the destination knows — the two ends of the diff that says
 * which ones a restore had to create.
 *
 * `pg_roles` rather than `pg_authid`: the latter is superuser-only, and nothing
 * here reads a password, only names. `rolcanlogin` because a role that cannot log
 * in has no use for one — a pure owner like a read-only grantee comes back whole
 * and is none of the operator's business.
 */
const LOGIN_ROLES_QUERY = "select rolname from pg_roles where rolcanlogin and left(rolname, 3) <> 'pg_'";

const listLoginRoles = (access: PostgresAccess): Effect.Effect<string[], ShellCommandFailureError> =>
  getShellOutput(access.query(LOGIN_ROLES_QUERY), { env: { PGPASSWORD: access.password } }).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );

/**
 * Quotes a postgres identifier / string literal by doubling, which is the whole
 * rule for both.
 *
 * The statement these build is SQL on a pipe, not a shell command, so `sh` does
 * not apply — but the reason it exists does, and a password is the last value to
 * assemble by hand. {@link setPostgresRolePassword} pins
 * `standard_conforming_strings` before using them, so a backslash in a password
 * stays a backslash whatever the server was configured with.
 */
const pgIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const pgLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Gives a role the password its dump could not carry.
 *
 * `access.restore` is already "psql reading SQL from stdin", so the statement
 * travels the same way a dump does and the password never reaches the process
 * table. `registerSecret` keeps it out of anything this run goes on to print.
 */
export const setPostgresRolePassword = (
  target: PostgresTarget,
  role: string,
  password: string
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _setPostgresRolePassword() {
    const access = yield* postgresAccess(target);
    yield* Effect.sync(() => registerSecret(password));

    const statement = `set standard_conforming_strings = on;\nalter role ${pgIdent(role)} password ${pgLiteral(password)};\n`;

    yield* getShellOutput(access.restore, { env: { PGPASSWORD: access.password }, stdin: statement });
  });

/**
 * restore a postgres backup into a container or a host database
 *
 * The dump's prelude creates the owners the destination is missing, but never
 * their password — so the restore can succeed and leave an application unable to
 * connect. Bracketing the restore with {@link listLoginRoles} names those roles
 * exactly: what was not there a moment ago is what the prelude just created. The
 * alternative, reading the prelude out of the head of the restic stream, would
 * predict rather than observe — and would have to cut a pipe mid-dump to do it.
 *
 * @param target the container or host target to restore into
 * @param dump the dump to read back
 * @returns the login roles the restore created, each still without a password
 */
export const restorePostgres = (
  target: PostgresTarget,
  dump: DumpToRestore,
  logger: TaskLog
): Effect.Effect<string[], ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restorePostgres() {
    const access = yield* postgresAccess(target);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const before = yield* listLoginRoles(access);

    yield* streamShellOutput({
      cmd: sh`restic dump ${dump.snapshotId} ${dump.path} | ${raw(access.restore)}`,
      env: { ...env, ...RESTIC_PROGRESS_ENV, PGPASSWORD: access.password },
      logger,
    });

    const after = yield* listLoginRoles(access);

    return after.filter((role) => !before.includes(role));
  });

/**
 * Every login role the destination knows — the candidates offered when a
 * restore asks who should own the database it just poured in.
 *
 * Reuses {@link LOGIN_ROLES_QUERY}: a role that cannot log in has no business
 * owning an application's tables either, and it is the same list a restore
 * already shows for password prompts.
 */
export const listPostgresRoles = (
  target: PostgresTarget
): Effect.Effect<string[], ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _listPostgresRoles() {
    const access = yield* postgresAccess(target);
    return yield* listLoginRoles(access);
  });

/**
 * Creates a fresh, unprivileged login role to own a restored database — used
 * when none of the existing roles on the destination should get the job.
 *
 * Guarded by `if not exists`, same as {@link ROLE_PRELUDE_QUERY}, so asking for
 * a name that turns out to already exist is a no-op rather than a failure.
 * No password: it travels the same path as every other role a restore leaves
 * without one, and is asked for right after by the same prompt.
 */
export const createPostgresRole = (
  target: PostgresTarget,
  role: string
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _createPostgresRole() {
    const access = yield* postgresAccess(target);
    const statement = `do $dockup$ begin if not exists (select 1 from pg_roles where rolname = ${pgLiteral(role)}) then create role ${pgIdent(role)} login nosuperuser nocreatedb nocreaterole inherit; end if; end $dockup$;\n`;

    yield* getShellOutput(access.restore, { env: { PGPASSWORD: access.password }, stdin: statement });
  });

/** Every schema in the database that is not one of postgres' own. */
const USER_SCHEMAS_FILTER = "nspname not in ('pg_catalog', 'information_schema') and left(nspname, 3) <> 'pg_'";

/**
 * Every role that currently owns a table or a schema in the destination
 * database, once the restore has run — `pg_tables` rather than `pg_class` so
 * a sequence, view or index never counts as a table needing reassignment,
 * and every non-system schema (see {@link USER_SCHEMAS_FILTER}), not just
 * `public` — a dump can restore into any schema it was taken from.
 */
const CURRENT_OWNERS_QUERY = `
select tableowner as owner from pg_tables where schemaname not in ('pg_catalog', 'information_schema')
union
select r.rolname as owner from pg_namespace n join pg_roles r on r.oid = n.nspowner where ${USER_SCHEMAS_FILTER}
`;

/**
 * One `ALTER TABLE …` / `ALTER SCHEMA … OWNER TO` per object, rather than a
 * single `REASSIGN OWNED BY`: the restore runs as one admin account for every
 * database (typically `postgres`), and that account also owns objects
 * `REASSIGN` refuses to touch — extension-owned objects, `pg_catalog`
 * internals reached through a default ACL, `public` itself when the server
 * predates it having its own owner — which aborts the *whole* statement on
 * the first one it hits. Looping object by object avoids most of that already
 * (a plain table or schema is never one of those), and each `execute` is
 * still wrapped in its own `exception when others` so a single leftover
 * exotic case — this database's own equivalent of one — is skipped and named
 * rather than losing every table and schema after it.
 *
 * `newOwner` is spliced in as a literal identifier (quoted once, here, not
 * per row) rather than passed through `format`'s own `%I`, since it is the
 * same value on every iteration.
 */
const reassignOwnershipStatement = (newOwner: string): string => `
do $dockup$
declare
  t record;
begin
  for t in
    select schemaname, tablename from pg_tables
    where schemaname not in ('pg_catalog', 'information_schema')
  loop
    begin
      execute format('alter table %I.%I owner to ${pgIdent(newOwner)}', t.schemaname, t.tablename);
    exception when others then
      raise notice 'dockup: could not reassign table %.%: %', t.schemaname, t.tablename, sqlerrm;
    end;
  end loop;

  for t in
    select nspname from pg_namespace where ${USER_SCHEMAS_FILTER}
  loop
    begin
      execute format('alter schema %I owner to ${pgIdent(newOwner)}', t.nspname);
    exception when others then
      raise notice 'dockup: could not reassign schema %: %', t.nspname, sqlerrm;
    end;
  end loop;
end $dockup$;
`;

/**
 * Moves every table and every schema of the destination database onto
 * `newOwner`, whoever the dump's `ALTER … OWNER TO` and
 * {@link ROLE_PRELUDE_QUERY} left holding them.
 *
 * A dump keeps its *original* owner (see {@link postgresDumpCommand}), which is
 * exactly right for restoring a backup back where it came from but wrong the
 * moment a database is poured into fresh infrastructure: without this step,
 * every table restored from a source dumped as an admin account (`postgres`,
 * typically) stays owned by that account rather than by whichever role is
 * meant to run this database going forward.
 *
 * Skips the statement entirely when nothing needs moving — `newOwner` may
 * already own everything, e.g. when the database is being restored back into
 * the account that took the dump.
 *
 * @returns the roles ownership was actually moved away from
 */
export const reassignDatabaseOwnership = (
  target: PostgresTarget,
  newOwner: string
): Effect.Effect<string[], ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _reassignDatabaseOwnership() {
    const access = yield* postgresAccess(target);

    const output = yield* getShellOutput(access.query(CURRENT_OWNERS_QUERY), {
      env: { PGPASSWORD: access.password },
    });
    const previousOwners = [
      ...new Set(
        output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line !== newOwner)
      ),
    ];

    if (previousOwners.length === 0) {
      return [];
    }

    yield* getShellOutput(access.restore, {
      env: { PGPASSWORD: access.password },
      stdin: reassignOwnershipStatement(newOwner),
    });

    return previousOwners;
  });

/**
 * Gets the credentials a ClickHouse container was started with.
 *
 * Unlike postgres and mariadb, a missing password is *not* an error here: the
 * official image starts with a `default` user that has none, and refusing to back
 * that up would rule out the most common setup there is.
 */
const getClickhouseEnvVariables = (containerId: string) =>
  Effect.gen(function* _getClickhouseEnvVariables() {
    const vars = yield* getContainerEnvVariables(containerId);

    // The image only sets CLICKHOUSE_USER when it is asked to create one; the
    // server answers as `default` otherwise.
    const user = yield* getContainerEnvVariable(containerId, vars, "CLICKHOUSE_USER").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed("default"))
    );

    // Only a *missing* variable falls back to the plain password: a failure to
    // read the secret file must surface, not be mistaken for "no secret file".
    const passwordFile = yield* getContainerEnvVariable(containerId, vars, "CLICKHOUSE_PASSWORD_FILE", true).pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );
    const password = yield* getContainerEnvVariable(containerId, vars, "CLICKHOUSE_PASSWORD").pipe(
      Effect.catchTag("UNDEFINED_VARIABLE_ERROR", () => Effect.succeed(null))
    );

    const resolved = passwordFile ?? password ?? "";
    yield* Effect.sync(() => registerSecret(resolved));

    return { password: resolved, user };
  });

/** The credentials `clickhouse-client` reads out of its environment. */
const clickhouseEnv = (credentials: { password: string; user: string }) => ({
  CLICKHOUSE_PASSWORD: credentials.password,
  CLICKHOUSE_USER: credentials.user,
});

/**
 * How dockup reaches a container's own `clickhouse-client`.
 *
 * Both the user *and* the password travel through the environment rather than
 * `--user`/`--password`: they stay out of the process table, and it sidesteps the
 * precedence between the two, which ClickHouse has changed across versions. The
 * `-e NAME` form with no `=` makes docker inherit the value from dockup's own
 * environment, so every caller must pass {@link clickhouseEnv} alongside.
 */
const clickhouseExec = (container: ClickhouseTarget): string =>
  sh`docker exec -e CLICKHOUSE_USER -e CLICKHOUSE_PASSWORD ${container.id} clickhouse-client`;

/** The same, with stdin attached so a dump can be piped back in. */
const clickhouseExecInteractive = (container: ClickhouseTarget): string =>
  sh`docker exec -i -e CLICKHOUSE_USER -e CLICKHOUSE_PASSWORD ${container.id} clickhouse-client`;

/** Backtick-quotes a ClickHouse identifier, the way the server writes them back. */
const chIdent = (name: string): string => `\`${name.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;

/** ClickHouse's own databases — never dumped, and never restorable anyway. */
const CH_SYSTEM_DATABASES = `'system', 'INFORMATION_SCHEMA', 'information_schema'`;

/**
 * Database engines that proxy another server. Their tables are a view onto data
 * dockup does not own and could not restore: dumping them would pull a full copy
 * of someone else's MySQL into the snapshot.
 */
const CH_FOREIGN_DATABASE_ENGINES = `'MySQL', 'PostgreSQL', 'MaterializedMySQL', 'MaterializedPostgreSQL', 'SQLite'`;

/**
 * Table engines that hold no data of their own — a view, a proxy onto another
 * table, or a stream. Their DDL is dumped, their contents are not: `select *`
 * would either re-read data already dumped elsewhere or consume a queue.
 */
const CH_DATALESS_TABLE_ENGINES = `'Distributed', 'Dictionary', 'Merge', 'Null', 'Kafka', 'RabbitMQ', 'NATS', 'MySQL', 'PostgreSQL', 'SQLite', 'MongoDB', 'Redis', 'URL', 'S3', 'File', 'HDFS'`;

/** The databases whose schema dockup dumps — the user's own, on this server. */
const CH_OWNED_DATABASES = `select name from system.databases where name not in (${CH_SYSTEM_DATABASES}) and engine not in (${CH_FOREIGN_DATABASE_ENGINES})`;

/**
 * Tables worth dumping at all.
 *
 * `.inner%` are the storage a materialized view creates for itself: they are
 * recreated by the view's own DDL, and dumping them would restore twice.
 */
const CH_DUMPABLE_TABLES = `database in (${CH_OWNED_DATABASES}) and not is_temporary and name not like '.inner%'`;

const DISCOVER_CH_DATABASES_QUERY = `${CH_OWNED_DATABASES} order by name`;

/**
 * Every object the dump recreates, and whether its *contents* come with it.
 *
 * One query rather than two: the schema needs all of them (each gets a `DROP`),
 * while only the ones holding data of their own get a `select`.
 */
const DISCOVER_CH_TABLES_QUERY = `select database, name, engine not like '%View' and engine not in (${CH_DATALESS_TABLE_ENGINES}) from system.tables where ${CH_DUMPABLE_TABLES} order by database, name`;

/**
 * Every `CREATE` statement of the server, in one query.
 *
 * `create_table_query` is a column of `system.tables`, so the whole schema comes
 * back in a single round trip rather than one `SHOW CREATE TABLE` per table — and
 * it never touches a command line on the way. Views sort last (`engine like
 * '%View'` is 0 then 1), so the tables they read already exist when they are
 * created.
 */
const DUMP_CH_SCHEMA_QUERY = `select concat(create_table_query, ';') from system.tables where ${CH_DUMPABLE_TABLES} order by engine like '%View', database, name`;

/**
 * Rows of 1000 rather than the 65 000 ClickHouse defaults to.
 *
 * `SQLInsert` writes one `INSERT` statement per batch, and a default-sized batch
 * of anything but the narrowest table blows straight past `max_query_size`
 * (256 KiB) — the dump would be written happily and refused on the way back in.
 */
const CH_SQL_INSERT_BATCH_SIZE = 1000;

/**
 * How large a single statement the restore accepts, well above what the batch
 * size above can produce. A safety net for a dump written by an older dockup, or
 * a table whose individual rows are very wide.
 */
const CH_MAX_QUERY_SIZE = 268_435_456;

interface ClickhouseTableRef {
  database: string;
  name: string;
}

/** Splits a TabSeparated result into rows of exactly `columns` fields. */
const parseClickhouseRows = (output: string, columns: number, query: string): Effect.Effect<string[][], ParsingError> =>
  Effect.try({
    try: () =>
      output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const fields = line.split("\t");
          if (fields.length !== columns) {
            throw new Error(`expected ${columns} column(s), got ${fields.length} in "${line}"`);
          }
          return fields;
        }),
    catch: (e) =>
      new ParsingError({
        cause: e,
        message: `The ClickHouse output of \`${query}\` could not be read.`,
      }),
  });

interface ClickhouseSchema {
  databases: string[];
  /** Everything the dump recreates, views included — one `DROP` each. */
  objects: ClickhouseTableRef[];
  /** The subset holding data of its own — one `select` each. */
  tables: ClickhouseTableRef[];
}

/**
 * Asks the server what it holds.
 *
 * A ClickHouse container is backed up whole — every database it owns — because
 * unlike postgres it has no single `CLICKHOUSE_DB` the deployment agrees on, and
 * a server with several databases is the norm rather than the exception.
 */
const discoverClickhouseSchema = (
  container: ClickhouseTarget,
  credentials: { password: string; user: string }
): Effect.Effect<ClickhouseSchema, ShellCommandFailureError | ParsingError> =>
  Effect.gen(function* _discoverClickhouseSchema() {
    const exec = clickhouseExec(container);
    const env = clickhouseEnv(credentials);

    const databasesOutput = yield* getShellOutput(
      sh`${raw(exec)} --format TabSeparated --query ${DISCOVER_CH_DATABASES_QUERY}`,
      { env }
    );
    const databases = yield* parseClickhouseRows(databasesOutput, 1, "system.databases");

    const tablesOutput = yield* getShellOutput(
      sh`${raw(exec)} --format TabSeparated --query ${DISCOVER_CH_TABLES_QUERY}`,
      { env }
    );
    const rows = yield* parseClickhouseRows(tablesOutput, 3, "system.tables");
    const objects = rows.map(([database, name, withData]) => ({
      database: database ?? "",
      name: name ?? "",
      withData: withData === "1",
    }));

    return {
      databases: databases.map(([name]) => name ?? ""),
      objects: objects.map(({ database, name }) => ({ database, name })),
      tables: objects.filter((o) => o.withData).map(({ database, name }) => ({ database, name })),
    };
  });

/**
 * Builds the SQL stream a ClickHouse backup pipes into restic.
 *
 * ClickHouse ships no `pg_dump`: its own `BACKUP … TO Disk(…)` needs the server
 * configured with an allow-listed destination, which a tool driven entirely by
 * labels cannot assume. So the dump is assembled here, in three sections —
 * every `CREATE DATABASE` and `DROP TABLE`, then the whole schema, then the data
 * table by table.
 *
 * The parts are chained with `&&`, never `;`. A `{ a ; b ; }` group reports the
 * status of its *last* command, so a `docker exec` failing halfway would hand
 * restic a truncated stream and record it as a successful snapshot — the very
 * bug `bash -o pipefail` was introduced to kill.
 */
const clickhouseDumpCommand = (container: ClickhouseTarget, schema: ClickhouseSchema): string => {
  const exec = clickhouseExec(container);

  // Drops come before every create rather than next to their own table: the
  // schema arrives as one opaque block from the server, and a restore only needs
  // the two to be globally ordered. `DROP TABLE` covers views too — and it has to
  // reach them, or `CREATE VIEW` fails on a destination that still holds one.
  const prelude = [
    ...schema.databases.map((database) => `CREATE DATABASE IF NOT EXISTS ${chIdent(database)};`),
    ...schema.objects.map((object) => `DROP TABLE IF EXISTS ${chIdent(object.database)}.${chIdent(object.name)};`),
  ].join("\n");

  const parts = [
    sh`printf '%s\n' ${prelude}`,
    // TSVRaw, so the multi-line CREATE statements come out as written rather than
    // with their newlines escaped.
    sh`${raw(exec)} --format TSVRaw --query ${DUMP_CH_SCHEMA_QUERY}`,
  ];

  for (const table of schema.tables) {
    // `SQLInsert` writes an *unqualified* table name, so each table's data is
    // preceded by the database to pour it into. That is also why the table name
    // setting can keep its default backtick quoting: a `database.table` string
    // would come back quoted as one identifier, and a column named `order` needs
    // that quoting to survive the round trip.
    parts.push(sh`printf '%s\n' ${`USE ${chIdent(table.database)};`}`);
    parts.push(
      sh`${raw(exec)} --output_format_sql_insert_table_name ${table.name} --output_format_sql_insert_max_batch_size ${String(CH_SQL_INSERT_BATCH_SIZE)} --query ${`SELECT * FROM ${chIdent(table.database)}.${chIdent(table.name)} FORMAT SQLInsert`}`
    );
  }

  return `{ ${parts.join(" && ")}; }`;
};

/**
 * Backups every database of a ClickHouse server as one SQL dump.
 *
 * @param target The ClickHouse container to dump
 * @returns The command structured output
 */
export const backupClickhouse = (
  target: ClickhouseTarget,
  logger: TaskLog
): Effect.Effect<
  ResticSuccessfulBackupStructuredOutput,
  ShellCommandFailureError | UndefinedVariableError | ParsingError | EmptyBackupError,
  ConfigTag
> =>
  Effect.gen(function* _backupClickhouse() {
    const credentials = yield* getClickhouseEnvVariables(target.id);
    const schema = yield* discoverClickhouseSchema(target, credentials);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* streamShellOutput({
      cmd: sh`${raw(clickhouseDumpCommand(target, schema))} | restic backup ${raw(RESTIC_RETRY_LOCK)} --stdin --stdin-filename ${`${target.backupName}.sql`} --tag ${target.backupName} --tag ${typeTag("clickhouse")} --skip-if-unchanged --json --host ${target.backupName}`,
      env: { ...env, ...clickhouseEnv(credentials) },
      logger,
    });

    return yield* parseResticBackupOutput(target.backupName, output, { rejectEmpty: true });
  });

/**
 * restore a clickhouse backup into a container
 *
 * The dump carries its own `CREATE DATABASE`/`USE`, so — unlike postgres — it can
 * only ever be restored into the databases it was taken from.
 *
 * @param target the container to restore into
 * @param dump the dump to read back
 * @returns void
 */
export const restoreClickhouse = (
  target: ClickhouseTarget,
  dump: DumpToRestore,
  logger: TaskLog
): Effect.Effect<void, ShellCommandFailureError | UndefinedVariableError | ParsingError, ConfigTag> =>
  Effect.gen(function* _restoreClickhouse() {
    const credentials = yield* getClickhouseEnvVariables(target.id);
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    yield* streamShellOutput({
      // `--multiquery` reads the whole dump as a sequence of statements in one
      // session — which is what makes the `USE` lines apply to the inserts that
      // follow them. It stops at the first error and exits non-zero, so there is
      // no `ON_ERROR_STOP` equivalent to pass.
      cmd: sh`restic dump ${dump.snapshotId} ${dump.path} | ${raw(clickhouseExecInteractive(target))} --multiquery --max_query_size ${String(CH_MAX_QUERY_SIZE)}`,
      env: { ...env, ...RESTIC_PROGRESS_ENV, ...clickhouseEnv(credentials) },
      logger,
    });
  });

/**
 * Forwards the progress setting into the helper container — same `-e NAME`
 * inherit-from-the-client form as the credentials.
 */
const PROGRESS_ENV_ARGS = raw(
  Object.keys(RESTIC_PROGRESS_ENV)
    .map((name) => `-e ${name}`)
    .join(" ")
);

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
      cmd: sh`docker run --rm --name ${helperContainerName("backup", container.backupName)} --network host ${raw(volumeArgs)} ${raw(envArgs)} restic/restic:latest backup ${raw(RESTIC_RETRY_LOCK)} ${raw(volumeDests)} --tag ${container.backupName} --tag ${typeTag("volumes")} --json --host ${container.backupName}`,
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
        env: { ...env, ...RESTIC_PROGRESS_ENV },
        // `--verbose` rather than `--json`: nothing parses this output, it is
        // only read by whoever is watching the restore run.
        cmd: sh`docker run --rm --name ${helperContainerName("restore", container.backupName)} --network host ${raw(volumeArgs)} ${raw(envArgs)} ${PROGRESS_ENV_ARGS} restic/restic:latest restore ${snapshotId} --target / ${raw(includeArgs)} --verbose`,
      });
    });

    yield* restore.pipe(Effect.ensuring(restart));
  });
