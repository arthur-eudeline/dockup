# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dockup is a CLI (`dockup`) that backs up Docker services with [Restic](https://restic.net/).
Containers opt in and describe their backup strategy through Docker labels (Traefik-style),
so there is no per-service config file. Runs on **Bun**, written in TypeScript.

## Commands

```bash
bun run check        # lint + format check (ultracite → oxlint + oxfmt)
bun run fix          # autofix lint/format issues
bun run build        # compile a standalone linux-x64 binary at ./dockup
bun run release      # bump + changelog + release commit + tag (see Releases)
bun src/main.ts ...   # run the CLI directly in dev (no build step needed)
```

There is currently **no test suite** (the oxlint config extends a vitest ruleset, but no
test files exist). `bun run check` is the only gate.

Deploy: `upload.sh` rsyncs the compiled `./dockup` binary to the server and moves it to
`/usr/local/bin`. The binary must be rebuilt (`bun run build`) before uploading.

CI (`.github/workflows/`): `ci.yml` runs `bun run check` + a linux-x64 compile on every push
and PR; `release.yml` builds every target and publishes a GitHub release when a `v*` tag is
pushed. Versions and `CHANGELOG.md` come from the conventional commits (see **Releases** below).

### CLI surface (see `src/main.ts`)

- `dockup backup` — scan running containers, back up each labeled one, run retention
  cleanup, post a Discord report, and escalate any backup that has gone 3 days without a
  successful run.
- `dockup restore` — interactive, destination first: pick the target to restore _into_, then the
  backup to read from among those compatible with it (`src/lib/sources.ts`), then the snapshot.
  Restoring a backup into another target is allowed and confirmed explicitly.
- `dockup restic [args...]` — passthrough to the `restic` binary with repo/credentials env injected.
- `dockup config init` / `dockup config check` (alias `doctor`) — manage/validate the config file.
  `config init` prompts interactively, or runs unattended (no TTY, or `-y`/`--non-interactive`) taking
  each value from a `--<key>` flag, a `DOCKUP_<KEY>` env var, or a `--json <path|->` document
  (`hosts[]` included); `--force` to overwrite an existing config, otherwise an existing file is a
  no-op exit 0.
- `dockup config target add` / `list` (alias `ls`) / `remove` (alias `rm`); the group is also aliased
  `targets`. Declares the postgres databases running on the host, outside docker.
- `dockup service init` (alias `setup`) / `test` / `remove` (alias `uninstall`); the `service`
  group is also aliased `cron`. Installs a systemd service + timer for a daily 02:00 backup.
  `service test` follows the unit's journal while systemd runs it (`journalctl --follow`, forked
  and interrupted when the run ends), because `systemctl start` on a oneshot unit blocks for the
  whole backup and says nothing; the journal is best-effort and never fails the test.
- `dockup upgrade` (alias `update`, flags `--check` / `--force`) — download the latest GitHub
  release for this platform and replace the running binary.
- `dockup -v` / `--version` — print the version (commander's default `-V` is overridden).

## Architecture

**Two layers.** `src/commands/*.cmd.ts` own the CLI/UX (commander for parsing, `@clack/prompts`
for spinners/prompts/task logs). `src/lib/*.ts` own the logic and are UI-free. Keep it that way:
business logic returns `Effect`s, commands run them and render.

**Everything is Effect-TS.** `lib` functions return `Effect.Effect<A, E, R>`. Errors are typed
and modeled as `Data.TaggedError` subclasses in `src/lib/errors.ts` (tags are SCREAMING_SNAKE,
e.g. `SHELL_COMMAND_FAILURE_ERROR`); handle them with `Effect.catchTag(s)`.

**Config as an Effect dependency.** `src/lib/effect.ts` defines `ConfigTag` and `AppConfig`
(the `Layer` that reads + decrypts the config). Effects that need credentials declare `ConfigTag`
in their `R` channel; `runCommand` provides `AppConfig`, so a missing/invalid config file is just
another typed, rendered failure.

**Command entry point (`src/lib/cli.ts`).** Every command wraps its whole body in one Effect and
hands it to `runCommand` (needs config) or `runStandalone` (no config). The runner: renders every
typed error uniformly via `@clack/prompts` (`_tag` + message + a remediation hint from `HINTS`),
catches defects and interruptions so nothing escapes as an unhandled rejection, wires SIGINT/SIGTERM
to Effect interruption so `Effect.ensuring` finalizers still run on Ctrl-C, and sets
`process.exitCode` instead of calling `process.exit` (0 ok / 1 failure / 130 cancelled). So a
command body keeps all failure in the typed error channel — no `process.exit`, no throwing, no
`.catch`. Soft, expected outcomes get their own tagged errors (`PromptCancelledError`,
`NoSnapshotsError`, `ServiceRemovalError`) rather than an early `process.exit`. `restore.cmd.ts` is
the clearest reference. Multi-step commands choose a failure policy explicitly: `backup` and
`service remove` are best-effort (every step runs, failures collected into the report / a counter);
`service init` is abort-on-first (a half-installed service is worse than a clean failure).

**Config file.** Encrypted JSON at `/etc/dockup.conf`, AES-256-GCM via `src/lib/crypto.ts`,
schema-validated with Zod in `src/lib/config.ts` (`CONFIG_SCHEMA`: S3 creds, `RESTIC_REPOSITORY`
`s3:` URL, `RESTIC_PASSWORD` ≥24 chars, Discord webhook, plus the `hosts` array below). Note
`crypto.ts` uses a hardcoded `KEY` constant — encryption is obfuscation-at-rest, not a real secret
boundary. File perms are `640 $USER:dockup` so the `dockup` system user can read it — and
`writeConfig` chowns to the `dockup` group whenever that user exists, because rewriting the file
(adding a host target) otherwise handed it back to the invoking user's own group and cut the
nightly run off from its credentials.

**Targets: containers and hosts** (`src/lib/targets.ts`, `src/lib/backup.ts`). A container declares
itself through its labels and carries its own credentials; a postgres running on the _host_ has
neither, so it is declared in the config file instead — as a `HostTarget` (`CONFIG_SCHEMA.hosts[]`,
defaulted so a config written before it existed still parses), one of two scopes discriminated by
`scope`: `"database"` names exactly one `database`; `"instance"` names none and backs up every
database the server reports instead (`discoveryDatabase` to connect for the catalog query, default
`"postgres"`; `exclude[]` for exact names to skip — the admin `postgres` database itself is _not_
auto-excluded, since it is a real, potentially non-empty database like any other).

A `HostTarget` cannot be backed up directly — an `"instance"` one does not even name a database
until the server is asked — so `resolveHostTargets` (`backup.ts`) resolves every declared one into
concrete, single-database `HostBackupTarget`s first: trivially for `"database"` scope, by running
`DISCOVER_DATABASES_QUERY` (`datallowconn and not datistemplate`) against `discoveryDatabase` for
`"instance"` scope. An instance target's databases are tagged `<name>-<database>`, so distinct
databases never collide and a `"database"`-scoped target keeps its exact declared name unchanged.
Resolution is per-target best-effort (`Effect.partition`, mirroring `listBackupEnabledContainers`
for containers): one postgres instance being down must not cancel the databases another instance,
or a container, would still back up — it is reported in `HostDiscovery.invalid` instead.

`BackupTarget` is the union of a container and a _resolved_ `HostBackupTarget`, discriminated by
`source`, and `mergeTargets` (`targets.ts`, dependency-free — no I/O, no knowledge of `HostTarget`)
joins the two lists — a name claimed by both wins for the host target, since sharing a name means
sharing a restic tag (interleaved snapshots, retention pruning across both). Everything downstream
was already source-agnostic — restic is called with `--host <backupName> --tag <backupName>` (plus
the `dockup.type=` tag), and
`health.ts` / `state.ts` are keyed by backup name — so only discovery and the dump command had to
change. `checkHostTarget` (`config check`, `config target add`) probes a declared `HostTarget` the
same way `backup` will use it — discovery included for `"instance"` scope — before it is trusted.

**Running shell commands (`src/lib/utils.ts`).** `getShellOutput` / `streamShellOutput` are the
only two ways to shell out, and both run `bash -o pipefail -c` — **not** Bun's built-in shell,
which reports only the last command of a pipeline and so let a failed dump produce an empty
"successful" snapshot. Build any command that interpolates a value with the `` sh`…` `` tagged
template: it quotes every interpolated value, and everything dockup interpolates (container ids,
DB users, volume paths) comes from `docker inspect` / `docker exec env`. A fragment the code
itself assembled — a list of `-v`/`-e` flags — opts out with `raw()`; never a value from outside.
Both spawn that bash themselves rather than going through Bun's `$`, because `$` exposes stdout
only: restic, the database clients, systemctl and usermod all print their progress, their notices
and the error explaining a failure on **stderr**, so a restore used to run in silence and fail
with nothing but an exit code — as did every `sudo` step of `service init`. Both streams are
drained concurrently (an undrained stderr pipe eventually blocks the child) and, when a `logger`
is given, streamed to it line by line as they arrive; only stdout is returned, since that is what
the parsers read, and the last stderr lines are quoted back in the `ShellCommandFailureError`.
`getShellOutput` neither streams nor redacts — its output is read by the code, and some of it _is_
the credential being looked up (`docker exec env`) — and takes `{ env, stdin }`, `stdin` being how
`sudo tee` receives a unit file. Interruption kills the shell rather than leaving it running with
nobody reading it. Restic reports progress at all only because the restore paths set
`RESTIC_PROGRESS_ENV` (`src/lib/restic.ts`) — it stays silent when it cannot redraw a terminal,
which it never can here. Two deliberate exceptions inherit the terminal instead of capturing it:
`primeSudo()` (`utils.ts`), so sudo's password prompt is visible rather than swallowed by a
spinner — `service test` and `upgrade` call it before their `sudo` steps — and the `dockup restic`
passthrough, which hands restic the three streams so its progress bar and its prompts work.

**Secrets never reach the outside (`src/lib/redact.ts`).** Credentials are passed to child
processes through the environment, never on a command line: `docker run -e NAME` / `docker exec
-e NAME` with no `=` makes docker inherit the value from dockup's own env (so the caller must
pass `env`), MariaDB uses `MYSQL_PWD` and postgres `PGPASSWORD`. On top of that, every secret is
`registerSecret`-ed as it is resolved and `redact()`-ed out of error messages, streamed log lines
and Discord payloads — a backup failure must never publish the S3 keys to a Discord channel.

**Docker discovery.** `src/lib/docker.ts`. Labels: `dockup.backup.enabled=true`,
`dockup.backup.name=<snapshot host/tag>`, `dockup.backup.type=mariadb|postgres|clickhouse|volumes`,
plus `dockup.backup.all-databases=true` — postgres only, for now — for a container hosting several
databases that should all be backed up rather than just the one named by `POSTGRES_DB`.
Discovery shells out to `docker ps`/`docker inspect`; DB credentials are pulled from the target
container's own env vars (`docker exec <id> env`), with `*_PASSWORD_FILE` (Docker secrets)
resolved by `cat`-ing the file inside the container. `listBackupEnabledContainers` returns
`{ containers, invalid }` — discovery is per-container best-effort, so one unreadable label set
cannot cancel the whole run; callers must report `invalid` rather than drop it. An unreachable
docker daemon aborts `backup` only when no host target is declared: host targets never go through
docker, and the container ones simply go unseen, which the staleness rule escalates anyway.

**Backing up every database of a container** (`resolveContainerTargets`, `backup.ts`) mirrors
`resolveHostTargets`' `"instance"` scope, but through `docker exec` instead of a TCP connection —
a container has no port declared to reach it from outside. A container declaring
`dockup.backup.all-databases=true` names no database up front, so `backup`/`restore` call
`resolveContainerTargets` right after discovery to expand it into one concrete
`ContainerBackupConfig` per database the server reports, each named `<name>-<database>` (same
convention as an `"instance"`-scoped host target, so distinct databases never collide on one
restic tag) and carrying that database's name so `containerPostgresAccess` dumps/restores it
instead of falling back to `POSTGRES_DB`. Resolution is per-container best-effort, like
`listBackupEnabledContainers` and `resolveHostTargets`: one container's discovery query failing
must not cancel the databases another container, or a host target, would still back up.
`config check` probes `all-databases` containers the same way, so a bad `POSTGRES_PASSWORD` shows
up there rather than in the first nightly report.

**What a restore can read from** (`src/lib/sources.ts`, pure like `targets.ts`). Since the
destination is chosen first, the backups offered next have to be matched to it — so **every backup
writes a second tag saying what it is**: `dockup.type=postgres|mariadb|clickhouse|volumes`, built by
`typeTag()` and read back by `snapshotDeclaredType()`. That tag, rather than an index file listing
the backups next to the repository, because it cannot drift: it is written in the same call as the
snapshot it describes, pruned with it, and two hosts writing to one repository have no shared file
to overwrite each other in. **Adding it forced the retention policy to group by `--host` instead of
by tags** — grouping by tags would put a tagged snapshot in a different group from an older
untagged one _of the same backup_, each then keeping its own 7/4/3 (measured, not assumed). Every
backup already passes `--host <backupName>`, so the groups are otherwise identical.

Snapshots taken before this fall back, in order, to the type of a discovered target still
declaring that name (`origin: "target"` — the prompt says it is an assumption), then to what the
snapshot looks like: one `/<name>.sql` path is a dump, anything else a file tree (`origin:
"unknown"`). That last step cannot tell `postgres` from `mariadb`, which is exactly the gap the tag
closes going forward; such a source is still offered rather than hidden, because a backup
outliving its container is precisely when a restore is needed. A volumes destination is stricter:
a volume restore writes back to the absolute paths the snapshot was taken from, so a source is
compatible only if it holds one of the destination's own mount points. Untagged snapshots
(something else's, in the same repository) are dropped, and `parseResticSnapshotListOutput`
tolerates a missing `summary`/`tags` — the whole listing is read at once now, so one foreign
snapshot must not make it unparseable. The dump path handed to the restore comes from the
_snapshot_, never rebuilt from the destination's name: those two parted ways the moment a
cross-restore became possible.

**Backup/restore per type** (`src/lib/backup.ts`):

- `mariadb` / `postgres` — a dump piped into `restic backup --stdin`; restore pipes `restic dump`
  back into the client, reading the `DumpToRestore` it is given (snapshot + path inside it). Uses `--host <backupName>` and the two tags. Both dumps parse their
  output with `rejectEmpty`, so restic processing 0 byte fails with `EmptyBackupError` instead of
  recording an empty snapshot as a success. The two postgres sources differ only by the prefix of
  that command — `docker exec -e PGPASSWORD <id> pg_dump …` against a container, plain
  `pg_dump -h … -p …` against a host target — so `PostgresAccess` builds that pair of fragments per
  source and the restic side is shared. Both pass `-w`: without it libpq falls back to prompting on
  /dev/tty when the password is refused, hanging an unattended run instead of failing it.
  The postgres dump **keeps ownership and privileges** (no `--no-owner --no-privileges`): stripping
  them handed every restored object to whoever ran the restore — `POSTGRES_USER` — so a server with
  one role per database came back flattened onto the superuser, silently, as a successful restore.
  Carrying them means the dump names roles the destination may not have, and the restore runs under
  `ON_ERROR_STOP=1`, which would abort it halfway — _after_ `--clean` dropped the tables. So the dump
  is made self-sufficient: `postgresDumpCommand` prepends what `ROLE_PRELUDE_QUERY` returns, one
  `CREATE ROLE` per owner/grantee the dump will reference (`format()` quotes them server-side),
  each guarded by an `if not exists` so an existing role keeps its attributes, password and
  memberships untouched. Passwords are never reproduced (they would ride inside every dump) and
  `nosuperuser` is forced — a restore may recreate an owner, never a way into the server. Prelude and
  `pg_dump` are chained with `&&`, same reason as `clickhouseDumpCommand`. Snapshots taken before
  this carry no ownership; there is nothing to recover from them.
  A recreated role has its owner's name and **no password**, so the restore would succeed and leave
  the application unable to connect — one silent wrong result traded for another. `restorePostgres`
  therefore brackets the restore with `listLoginRoles` (`pg_roles`, not `pg_authid`: no superuser
  needed, and only `rolcanlogin` — a pure owner has no use for a password) and returns the
  difference: what was not there a moment ago is what the prelude just created. Observed, not
  predicted — the alternative, reading the prelude out of the head of the restic stream, would have
  to cut a pipe mid-dump. `restore.cmd.ts` then asks for each one and applies it through
  `setPostgresRolePassword`, which pushes the `ALTER ROLE` down psql's stdin (`access.restore` is
  already "psql reading SQL from stdin") so the password never reaches the process table, and
  `registerSecret`s it. An empty answer skips, and whatever was skipped is named at the end.
  `scripts/restore-passwords.sh` does the same after the fact, for a restore dockup did not run.
  Restoring the owner is not restoring the _right_ owner, though: the dump keeps whoever owned the
  objects at backup time, which for most setups is the one admin account `pg_dump` ran as (e.g.
  `postgres`) — correct restoring a backup back where it came from, wrong the moment it lands on
  fresh infrastructure that should be run by its own role. So `restore.cmd.ts` follows every
  postgres restore, container or host, with a mandatory prompt for the role that should own the
  result — one of `listPostgresRoles` (same `pg_roles`/`rolcanlogin` catalogue as the password
  step) or a freshly `createPostgresRole`-d one — and `reassignDatabaseOwnership` moves every table
  and every non-system schema (`CURRENT_OWNERS_QUERY` / `pg_tables` + `pg_namespace`, not just
  `public`) onto it with one `ALTER TABLE …` / `ALTER SCHEMA … OWNER TO` per object, not a single
  `REASSIGN OWNED BY`: the restore connects as the same admin account for every database, and that
  account also owns objects `REASSIGN` refuses to touch (extension-owned objects, `pg_catalog`
  internals reached through a default ACL, `public` itself on servers where it has no owner of its
  own), which aborts the whole statement on the first one it hits. Looping object by object mostly
  sidesteps that already, and each `execute` is additionally wrapped in its own
  `exception when others` (`reassignOwnershipStatement`), so one leftover exotic case is skipped
  and named in a `NOTICE` rather than losing every object after it. A role created here for this
  purpose flows into the same password prompt as a role the prelude created, rather than a second
  one.
- `clickhouse` — ClickHouse ships no `pg_dump`, and `BACKUP … TO Disk(…)` needs the server
  configured with an allow-listed destination, which a label-driven tool cannot assume. So the dump
  is assembled: `discoverClickhouseSchema` asks `system.tables` what exists, then
  `clickhouseDumpCommand` builds one bash group — the `CREATE DATABASE`/`DROP TABLE` prelude, then
  the whole schema in a single query (`create_table_query` is a _column_, so N tables cost one round
  trip and the DDL never touches a command line), then one `select … FORMAT SQLInsert` per table.
  **The parts are chained with `&&`, never `;`** : a `{ a ; b ; }` group reports the status of its
  _last_ command, so a `docker exec` failing halfway would hand restic a truncated stream and record
  it as a success — the exact bug `pipefail` exists to prevent. A container is backed up **whole**
  (every database it owns) because ClickHouse has no single `CLICKHOUSE_DB`; the dump therefore
  carries its own database names and cannot be restored into a differently-named one. Databases
  whose engine proxies another server, and tables holding no data of their own (views, `Distributed`,
  `Dictionary`, `Merge`, `Null`, queues), get their DDL dumped but not their contents — so a
  materialized view without a `TO` table comes back empty. `DROP TABLE` is emitted for _every_
  dumped object, views included, or `CREATE VIEW` fails against a destination that still holds one.
  Batches are capped at 1000 rows: the 65 000 default blows past `max_query_size` (256 KiB) and the
  dump would be written happily and refused on the way back in. Credentials go through
  `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` in the environment rather than `--user`/`--password`,
  which also sidesteps the precedence between the two — it has changed across versions. A missing
  password is **not** an error here, unlike postgres/mariadb: the official image's `default` user has
  none.
- `volumes` — runs `restic/restic` in a throwaway `docker run --network host` with the
  container's mounts bind-mounted in. Restore stops the container, then restores inside an
  `Effect.ensuring` whose finalizer restarts it — so the container comes back up even if the
  restore fails or is interrupted.

**Restic wrapper** (`src/lib/restic.ts`). `configToResticEnv` maps config → restic env;
`restic()` execs the binary and exits with its code; `resticCleanUp()` is the retention policy
(`forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3`, grouped by host — see `sources.ts`); parsers turn
restic's `--json` output into typed structs.

**Notifications** (`src/lib/discord.ts`). Backup runs aggregate `ResticStructuredOutput[]` into
chunked (<2000 char) Discord webhook messages. Delivery is deliberate about failure:
`fetch` resolving is not success, so `classify()` reads the status — 429 (honouring `Retry-After`),
5xx and 408 are retryable (5 attempts, jittered exponential backoff, 10s per attempt), every other
4xx is a permanent rejection that is dropped rather than retried forever. `deliverDiscordMessages`
never fails and never logs (lib is UI-free): it returns `{ delivered, retryable, dropped }` and the
command decides. Once Discord proves unreachable the remaining messages are spooled unsent instead
of each burning 5 attempts. Messages in `retryable` are persisted and re-sent by the next run.

**Cross-run state and staleness alerting** (`src/lib/state.ts` + `src/lib/health.ts`). A run only
knows about itself, so three failed nights in a row look like three unrelated red lines and a
container that quietly disappeared produces no line at all. `/var/lib/dockup/state.json` (schema-
validated, written through a temp file + `rename` so it is atomic and replaceable by any member of
the `dockup` group) therefore carries per-backup health — last success, failure streak, last
alert — plus the undelivered Discord messages. `health.ts` is pure: `applyRun` folds a run's
outcomes into the state and returns the escalations, and the rule is one line — **no successful
backup for `ALERT_AFTER_DAYS` (3) days**, whatever the cause: it failed, the run aborted in
preflight (`preflightOutcomes` marks every known backup failed, so aborted nights count too), or
the container is simply gone. Repeats are throttled to 12h, and a backup that recovers gets a
closing message. State is best-effort: a run that cannot read or write it still backs everything
up, says so locally _and_ in the Discord report, and loses only the streak alerting — so
`config check` probes it and `service init` creates the directory.

**systemd** (`src/lib/service.ts`). Writes unit + timer to `/etc/systemd/system/` through
`sudo tee` (they are root-owned, and every other step of the flow already uses `sudo`), service
name `dockup-auto-backup`, runs `dockup backup` as user/group `dockup`. `ExecStart` must be an
absolute path — systemd rejects the unit otherwise — so `resolveBinaryPath()` (`utils.ts`, shared
with `upgrade`) uses `process.execPath` for the compiled binary and falls back to
`/usr/local/bin/dockup`. `service init` also creates the `dockup` system user, adds it to the
`docker` group, adjusts config-file ownership, and creates `/var/lib/dockup` (`770 dockup:dockup`);
`service remove` deletes that directory.

**Version and self-update** (`src/lib/version.ts` + `src/lib/upgrade.ts`). `VERSION` is read from
`package.json` and inlined by the bundler, so the manifest is the single source of truth and the
release workflow only has to check that the tag agrees with it. `upgrade` reads
`/releases/latest` off the GitHub API, picks the asset named
`dockup-${process.platform}-${process.arch}` — that name is a contract with `release.yml` — and
**refuses to install anything the release's `SHA256SUMS.txt` does not vouch for**: it overwrites a
binary that runs nightly as a privileged user. The new binary is staged inside the install
directory and `mv`-ed into place, because a same-directory rename is atomic and legal while the
file it replaces is the executable currently running (writing to it directly is `ETXTBSY`).
When the install directory is not writable the command primes `sudo -v` _before_ starting the
spinner: `getShellOutput` captures stderr, so a password prompt raised mid-install would be
invisible.

## Runtime requirements

The `docker`, `restic` and `bash` binaries must be on `PATH` at runtime, and `/var/lib/dockup`
must be writable by whoever runs `backup` (alerting degrades without it, backups do not).
A declared host target additionally needs `pg_dump` and `psql` on `PATH` (the postgresql client
package), at least as recent as the server, and a `pg_hba.conf` line letting the `dockup` user
authenticate over TCP — `config check` probes both.
Backup/restore and `service` commands assume a Linux host with systemd and `sudo`; `docker/` holds
a local compose stack (RustFS as S3, plus labeled postgres/mariadb/clickhouse/wordpress) for exercising the
tool. Note the
`volumes` path uses `docker run --network host`, which does not work under Docker Desktop.

## Releases

**Commit messages decide the version**, so write them as conventional commits. Only four types
release anything — `feat` → minor, `fix` / `perf` / `revert` → patch — and a `!` after the type or
a `BREAKING CHANGE:` footer in the body makes it major. Everything else (`chore`, `docs`,
`refactor`, `test`, `ci`, `build`, `style`, or a message that is not conventional at all) is
deliberately invisible to the release: it lands in git history and nowhere else. The scope is free
— use module names (`fix(restic,report): …`); they are rendered in the changelog, not resolved as
package names.

`bun run release` (`scripts/tegami.mts`, built on [tegami](https://tegami.fuma-nama.dev/)) does the
rest: read the conventional commits since the latest tag, bump `package.json`, prepend the section
to `CHANGELOG.md`, commit `chore(release): v<version>` and tag `v<version>`. `--dry-run` prints the
plan and writes nothing; `--yes` skips the confirmation. It refuses to run on a dirty tree, and
says so when no commit since the last tag was releasable. Nothing is pushed: **`git push
--follow-tags` is what starts the release**, and pushing the tag is the only thing that does.

Then `release.yml` takes over: it refuses a tag that disagrees with the manifest — a binary
reporting a version it was not built as would make `dockup upgrade` loop forever — cross-compiles
every target from a single ubuntu runner, uploads them next to a `sha256sum` file, and publishes
the release with this version's `CHANGELOG.md` section as its notes (falling back to GitHub's
generated ones if that section cannot be found). Assets: `dockup-linux-x64`, `dockup-linux-arm64`,
`dockup-darwin-x64`, `dockup-darwin-arm64`, `dockup-linux-x64-baseline` (same linux-x64 build for
CPUs without AVX2, never picked automatically) and `SHA256SUMS.txt`. Renaming an asset breaks
`dockup upgrade`.

Two details of the tegami setup are load-bearing. `package.json` is `private: true` — dockup ships
as a release binary, never to npm — which is also what keeps tegami's publishing phase from trying
to `npm publish` it; the script therefore drives versioning through the programmatic API and does
the tag itself. And tegami reads a commit's scope as the name of the package it touches (a monorepo
assumption), so the script rewrites the generated entries onto the single `dockup` package before
drafting — without that, every module-scoped commit would resolve to a package that does not exist
and bump nothing.

## Conventions

- Formatting/lint is enforced by ultracite (oxlint + oxfmt): 120 col, 2-space, double quotes,
  semicolons, ES5 trailing commas, sorted imports. Run `bun run fix` before committing.
- Prefer adding a tagged error in `errors.ts` over throwing; thread it through the `Effect` `E`
  channel. Guard every `JSON.parse` / external-output parse with `Effect.try` + a `ParsingError`.
- Never interpolate an external value into a command string by hand — use `` sh`…` ``. Never put
  a credential on a command line — pass it through `env` and reference it by name.
- Anything that leaves a resource in a bad state on failure (a stopped container, a half-written
  file) must restore it with `Effect.ensuring` / `Effect.acquireRelease`, not a trailing step.
- Generator effects are named (`Effect.gen(function* _doThing() {...})`) — match that style.
- Commit messages are conventional commits: they are what bumps the version (see **Releases**).
- Some code comments and user-facing strings are in French; the mix is pre-existing.
