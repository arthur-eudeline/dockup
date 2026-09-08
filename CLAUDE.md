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
bun src/main.ts ...   # run the CLI directly in dev (no build step needed)
```

There is currently **no test suite** (the oxlint config extends a vitest ruleset, but no
test files exist). `bun run check` is the only gate.

Deploy: `upload.sh` rsyncs the compiled `./dockup` binary to the server and moves it to
`/usr/local/bin`. The binary must be rebuilt (`bun run build`) before uploading.

### CLI surface (see `src/main.ts`)

- `dockup backup` — scan running containers, back up each labeled one, run retention
  cleanup, post a Discord report.
- `dockup restore` — interactive: pick a container, pick a snapshot, restore it.
- `dockup restic [args...]` — passthrough to the `restic` binary with repo/credentials env injected.
- `dockup config init` / `dockup config check` (alias `doctor`) — manage/validate the config file.
- `dockup service init` (alias `setup`) / `test` / `remove` (alias `uninstall`); the `service`
  group is also aliased `cron`. Installs a systemd service + timer for a daily 02:00 backup.

## Architecture

**Two layers.** `src/commands/*.cmd.ts` own the CLI/UX (commander for parsing, `@clack/prompts`
for spinners/prompts/task logs). `src/lib/*.ts` own the logic and are UI-free. Keep it that way:
business logic returns `Effect`s, commands run them and render.

**Everything is Effect-TS.** `lib` functions return `Effect.Effect<A, E, R>`. Errors are typed
and modeled as `Data.TaggedError` subclasses in `src/lib/errors.ts` (tags are SCREAMING_SNAKE,
e.g. `SHELL_COMMAND_FAILURE_ERROR`); handle them with `Effect.catchTag(s)` or the custom
`matchError*` helpers in `src/lib/effect.ts`.

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
`s3:` URL, `RESTIC_PASSWORD` ≥24 chars, Discord webhook). Note `crypto.ts` uses a hardcoded
`KEY` constant — encryption is obfuscation-at-rest, not a real secret boundary. File perms are
`640 $USER:dockup` so the `dockup` system user can read it.

**Docker discovery.** `src/lib/docker.ts`. Labels: `dockup.backup.enabled=true`,
`dockup.backup.name=<snapshot host/tag>`, `dockup.backup.type=mariadb|postgres|volumes`.
Discovery shells out to `docker ps`/`docker inspect`; DB credentials are pulled from the target
container's own env vars (`docker exec <id> env`), with `*_PASSWORD_FILE` (Docker secrets)
resolved by `cat`-ing the file inside the container.

**Backup/restore per type** (`src/lib/backup.ts`):

- `mariadb` / `postgres` — `docker exec` a dump piped into `restic backup --stdin`; restore
  pipes `restic dump` back into the client. Uses `--host <backupName>` and `--tag <backupName>`.
- `volumes` — runs `restic/restic` in a throwaway `docker run --network host` with the
  container's mounts bind-mounted in. Restore stops the container, then restores inside an
  `Effect.ensuring` whose finalizer restarts it — so the container comes back up even if the
  restore fails or is interrupted.

**Restic wrapper** (`src/lib/restic.ts`). `configToResticEnv` maps config → restic env;
`restic()` execs the binary and exits with its code; `resticCleanUp()` is the retention policy
(`forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3`, grouped by tag); parsers turn
restic's `--json` output into typed structs.

**Notifications** (`src/lib/discord.ts`). Backup runs aggregate `ResticStructuredOutput[]` into
chunked (<2000 char) Discord webhook messages, with retry + 5s timeout; failures are swallowed.

**systemd** (`src/lib/service.ts`). Writes unit + timer to `/etc/systemd/system/`, service name
`dockup-auto-backup`, runs `dockup backup` as user/group `dockup`. `service init` also creates
the `dockup` system user, adds it to the `docker` group, and adjusts config-file ownership.

## Runtime requirements

The `docker` and `restic` binaries must be on `PATH` at runtime. Backup/restore and `service`
commands assume a Linux host with systemd and `sudo`; `docker/` holds a local compose stack
(RustFS as S3, plus labeled postgres/mariadb/wordpress) for exercising the tool.

## Conventions

- Formatting/lint is enforced by ultracite (oxlint + oxfmt): 120 col, 2-space, double quotes,
  semicolons, ES5 trailing commas, sorted imports. Run `bun run fix` before committing.
- Prefer adding a tagged error in `errors.ts` over throwing; thread it through the `Effect` `E`
  channel. Guard every `JSON.parse` / external-output parse with `Effect.try` + a `ParsingError`.
- Anything that leaves a resource in a bad state on failure (a stopped container, a half-written
  file) must restore it with `Effect.ensuring` / `Effect.acquireRelease`, not a trailing step.
- Generator effects are named (`Effect.gen(function* _doThing() {...})`) — match that style.
- Some code comments and user-facing strings are in French; the mix is pre-existing.
