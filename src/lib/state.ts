/**
 * The little state dockup keeps *between* runs.
 *
 * A single backup run only knows about itself, which is enough to report what
 * just happened and nothing else: a service that has been failing every night
 * for a week looks exactly like one that failed for the first time. Two things
 * therefore outlive a run and live here:
 *
 * - `backups` — per-backup health (last success, current failure streak), so a
 *   backup that has gone too long without a successful run can be escalated
 *   (see `health.ts`);
 * - `pending` — Discord messages that could not be delivered, re-sent by the
 *   next run instead of being lost with the process that produced them.
 *
 * Losing this file is never fatal: it degrades the alerting, not the backups.
 */

import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";
import { z } from "zod";

import { DOCKUP_SHELL_USER } from "./config";
import { StatePersistenceError } from "./errors";
import { daysBetween, getShellOutput, parseDate, sh } from "./utils";

/** Where dockup keeps its cross-run state. Created by `dockup service init`. */
export const STATE_DIR = "/var/lib/dockup";
export const STATE_PATH = join(STATE_DIR, "state.json");

/**
 * Group-writable, on both the directory and the file: backups normally run as
 * the `dockup` service account, but an admin (member of the `dockup` group)
 * running `dockup backup` by hand must be able to update the same state.
 */
const STATE_DIR_MODE = "770";
const STATE_FILE_MODE = 0o660;

/** Caps, applied on every write so the file cannot grow without bound. */
const PENDING_MAX_MESSAGES = 20;
const PENDING_MAX_AGE_DAYS = 7;
const BACKUP_MAX_AGE_DAYS = 30;

const DATE = z.string();

const BACKUP_HEALTH_SCHEMA = z.object({
  /** Consecutive failed runs; reset to 0 by any success. */
  consecutiveFailures: z.number().int().nonnegative(),
  /** When the current failure streak started. */
  firstFailureAt: DATE.nullable(),
  /** Last escalation sent for this backup, to throttle repeats. */
  lastAlertAt: DATE.nullable(),
  lastError: z.string().nullable(),
  lastFailureAt: DATE.nullable(),
  /** Last run in which this backup was seen at all (a container may vanish). */
  lastSeenAt: DATE,
  lastSuccessAt: DATE.nullable(),
});

const PENDING_MESSAGE_SCHEMA = z.object({
  at: DATE,
  content: z.string(),
});

const STATE_SCHEMA = z.object({
  version: z.literal(1),
  backups: z.record(z.string(), BACKUP_HEALTH_SCHEMA),
  lastRunAt: DATE.nullable(),
  pending: z.array(PENDING_MESSAGE_SCHEMA),
});

export type BackupHealth = z.infer<typeof BACKUP_HEALTH_SCHEMA>;
export type PendingMessage = z.infer<typeof PENDING_MESSAGE_SCHEMA>;
export type DockupState = z.infer<typeof STATE_SCHEMA>;

export const emptyState = (): DockupState => ({
  version: 1,
  backups: {},
  lastRunAt: null,
  pending: [],
});

/** The backups dockup has already seen, whether or not they ran tonight. */
export const knownBackupNames = (state: DockupState): string[] => Object.keys(state.backups);

/**
 * Drops what is no longer worth carrying: undelivered messages nobody will read
 * anymore, and health entries for backups that have not been seen in a month
 * (a container that was renamed or removed for good).
 */
const prune = (state: DockupState, now: Date): DockupState => ({
  ...state,
  backups: Object.fromEntries(
    Object.entries(state.backups).filter(([, health]) => {
      const seen = parseDate(health.lastSeenAt);
      return seen === null || daysBetween(seen, now) <= BACKUP_MAX_AGE_DAYS;
    })
  ),
  pending: state.pending
    .filter((message) => {
      const at = parseDate(message.at);
      return at === null || daysBetween(at, now) <= PENDING_MAX_AGE_DAYS;
    })
    .slice(-PENDING_MAX_MESSAGES),
});

/**
 * Reads the state file.
 *
 * A missing file is the normal first run and yields an empty state; anything
 * else — unreadable, corrupt, written by a future version — is a typed failure
 * the caller reports before falling back to {@link emptyState}.
 */
export const readState = (): Effect.Effect<DockupState, StatePersistenceError, never> =>
  Effect.gen(function* _readState() {
    const file = Bun.file(STATE_PATH);

    const exists = yield* Effect.tryPromise({
      try: () => file.exists(),
      catch: (e) => new StatePersistenceError({ cause: e, message: `Cannot access ${STATE_PATH}` }),
    });

    if (!exists) return emptyState();

    const raw = yield* Effect.tryPromise({
      try: () => file.text(),
      catch: (e) => new StatePersistenceError({ cause: e, message: `Cannot read ${STATE_PATH}` }),
    });

    const json = yield* Effect.try({
      try: () => JSON.parse(raw),
      catch: (e) => new StatePersistenceError({ cause: e, message: `${STATE_PATH} is not valid JSON` }),
    });

    const { data, error } = STATE_SCHEMA.safeParse(json);
    if (error) {
      return yield* Effect.fail(
        new StatePersistenceError({
          cause: error,
          message: `${STATE_PATH} does not hold a valid dockup state :\n${z.prettifyError(error)}`,
        })
      );
    }

    return data;
  });

/**
 * Persists the state through a temporary file swapped in with `rename`.
 *
 * The swap matters: the file is typically owned by the `dockup` service account
 * and an admin re-running a backup by hand cannot write *into* it, but can
 * replace it — replacing only needs the directory to be writable. It also makes
 * the update atomic, so an interrupted run can never leave a truncated state.
 */
export const writeState = (state: DockupState): Effect.Effect<void, StatePersistenceError, never> =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${STATE_PATH}.${process.pid}.tmp`;

      // No-op when it already exists; fails loudly when the directory is
      // missing *and* we lack the rights to create it (i.e. `service init`
      // was never run, or ran before this feature existed).
      await mkdir(STATE_DIR, { recursive: true });

      try {
        await Bun.write(temporary, JSON.stringify(prune(state, new Date()), null, 2));
        await chmod(temporary, STATE_FILE_MODE);
        await rename(temporary, STATE_PATH);
      } catch (error) {
        try {
          await unlink(temporary);
        } catch {
          // The temp file was never created, or is already gone.
        }
        throw error;
      }
    },
    catch: (e) => new StatePersistenceError({ cause: e, message: `Cannot write the dockup state at ${STATE_PATH}` }),
  });

/**
 * Creates the state directory, owned by the service account and writable by the
 * `dockup` group. Part of `service init`, next to the config-file permissions.
 */
export const createStateDir = () =>
  getShellOutput(sh`sudo install -d -o ${DOCKUP_SHELL_USER} -g ${DOCKUP_SHELL_USER} -m ${STATE_DIR_MODE} ${STATE_DIR}`);

/** Removes the state directory. Part of `service remove`. */
export const deleteStateDir = () => getShellOutput(sh`sudo rm -rf ${STATE_DIR}`);
