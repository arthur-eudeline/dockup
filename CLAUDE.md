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
- `dockup restore` — interactive: pick a target, pick a snapshot, restore it.
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
was already source-agnostic — restic is called with `--host <backupName> --tag <backupName>`, and
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
`dockup.backup.name=<snapshot host/tag>`, `dockup.backup.type=mariadb|postgres|volumes`.
Discovery shells out to `docker ps`/`docker inspect`; DB credentials are pulled from the target
container's own env vars (`docker exec <id> env`), with `*_PASSWORD_FILE` (Docker secrets)
resolved by `cat`-ing the file inside the container. `listBackupEnabledContainers` returns
`{ containers, invalid }` — discovery is per-container best-effort, so one unreadable label set
cannot cancel the whole run; callers must report `invalid` rather than drop it. An unreachable
docker daemon aborts `backup` only when no host target is declared: host targets never go through
docker, and the container ones simply go unseen, which the staleness rule escalates anyway.

**Backup/restore per type** (`src/lib/backup.ts`):

- `mariadb` / `postgres` — a dump piped into `restic backup --stdin`; restore pipes `restic dump`
  back into the client. Uses `--host <backupName>` and `--tag <backupName>`. Both dumps parse their
  output with `rejectEmpty`, so restic processing 0 byte fails with `EmptyBackupError` instead of
  recording an empty snapshot as a success. The two postgres sources differ only by the prefix of
  that command — `docker exec -e PGPASSWORD <id> pg_dump …` against a container, plain
  `pg_dump -h … -p …` against a host target — so `PostgresAccess` builds that pair of fragments per
  source and the restic side is shared. Both pass `-w`: without it libpq falls back to prompting on
  /dev/tty when the password is refused, hanging an unattended run instead of failing it.
- `volumes` — runs `restic/restic` in a throwaway `docker run --network host` with the
  container's mounts bind-mounted in. Restore stops the container, then restores inside an
  `Effect.ensuring` whose finalizer restarts it — so the container comes back up even if the
  restore fails or is interrupted.

**Restic wrapper** (`src/lib/restic.ts`). `configToResticEnv` maps config → restic env;
`restic()` execs the binary and exits with its code; `resticCleanUp()` is the retention policy
(`forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3`, grouped by tag); parsers turn
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
a local compose stack (RustFS as S3, plus labeled postgres/mariadb/wordpress) for exercising the
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
