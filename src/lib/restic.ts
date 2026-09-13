import { $, spawn } from "bun";
import chalk from "chalk";
import { Effect } from "effect";
import { z } from "zod";

import type { Config } from "./config";
import { ConfigTag } from "./effect";
import { EmptyBackupError, ParsingError, ShellCommandFailureError, ResticRepoNotInitializedError } from "./errors";
import { redact, registerSecret } from "./redact";
import { formatBytes, formatDuration, formatHumanDate } from "./utils";

// oxlint-disable-next-line typescript/consistent-type-definitions
export type ResticConf = {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  RESTIC_PASSWORD: string;
  RESTIC_REPOSITORY: string;
};

/**
 * Converts the dockup configuration to restic required environment variables
 * @param config The dockup config object
 * @returns The restic environment variables
 */
export const configToResticEnv = (config: Config): Effect.Effect<ResticConf> =>
  Effect.sync(() => {
    // Single choke point for the restic credentials: register them for redaction
    // here so they can never reach a log line, a rendered error or Discord.
    registerSecret(config.AWS_SECRET_ACCESS_KEY);
    registerSecret(config.RESTIC_PASSWORD);

    return {
      AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
      RESTIC_PASSWORD: config.RESTIC_PASSWORD,
      RESTIC_REPOSITORY: config.RESTIC_REPOSITORY,
    };
  });

/**
 * Turns restic's progress counter back on.
 *
 * Restic reports progress only when it can redraw a terminal — and dockup always
 * captures its output, so it never can, leaving a long restore completely silent
 * until it is over. `RESTIC_PROGRESS_FPS` overrides that check; one status line
 * per second is enough to follow a restore without drowning the log.
 */
export const RESTIC_PROGRESS_ENV = { RESTIC_PROGRESS_FPS: "1" } as const;

/**
 * Executes a restic command with the dockup credentials injected as env vars,
 * streaming its stdio, and resolves to restic's own exit code. The caller
 * mirrors that code onto the process (see `restic.cmd.ts`); a failure to even
 * spawn restic surfaces as a `ShellCommandFailureError`.
 * @param args The restic command arguments
 */
export const restic = (args: string[]): Effect.Effect<number, ShellCommandFailureError, ConfigTag> =>
  Effect.gen(function* _restic() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    return yield* Effect.tryPromise({
      try: () =>
        $`restic ${args}`
          .env({ ...process.env, ...env })
          .nothrow()
          .then((v) => v.exitCode),
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: "Failed to run restic — is it installed and on your PATH ?",
        }),
    });
  });

/**
 * Parses the restic forget JSON output and extract the interesting data
 * @param rawOutput The restic forget command output
 * @returns A structured object of the infos
 */
export const parseForgetPruneOutput = (rawOutput: string): Effect.Effect<ResticCleanUpStructuredOutput, never, never> =>
  Effect.gen(function* _parseForgetPruneOutput() {
    const lines = rawOutput.trim().split("\n");
    let snapshotsRemoved = 0;
    let bytesFreed = 0;

    for (const line of lines) {
      try {
        const data = JSON.parse(line);

        if (Array.isArray(data)) {
          for (const group of data) {
            snapshotsRemoved += group.remove?.length ?? 0;
          }
        }

        if (data.message_type === "summary" && data.bytes_to_delete !== undefined) {
          bytesFreed = data.bytes_to_delete;
        }
      } catch {
        continue;
      }
    }

    return yield* Effect.succeed({
      type: "clean-up",
      formattedFreed: formatBytes(bytesFreed),
      snapshotsRemoved,
    } as const);
  });

export interface ResticSuccessfulBackupStructuredOutput {
  success: true;
  type: "backup";
  backupName: string;
  dataAdded: string;
  totalDuration: string;
}

export interface ResticFailedBackupStructuredOutput {
  success: false;
  type: "backup";
  backupName: string;
  message: string;
  code: string;
}

export interface ResticCleanUpStructuredOutput {
  type: "clean-up";
  formattedFreed: string;
  snapshotsRemoved: number;
}

/**
 * The structred restic command outputs
 */
export type ResticStructuredOutput =
  | ResticSuccessfulBackupStructuredOutput
  | ResticFailedBackupStructuredOutput
  | ResticCleanUpStructuredOutput;

/**
 * Executes the restic cleanup policy the fill only keep the following snapshots :
 * - The 7 last daily snapshots
 * - The 4 last weekly snapshots
 * - The 3 last monthly snaphosts
 */
export const resticCleanUp = (): Effect.Effect<ResticCleanUpStructuredOutput, ShellCommandFailureError, ConfigTag> =>
  Effect.gen(function* _cleanUp() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* Effect.tryPromise({
      try: () =>
        $`restic forget --group-by tags --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --json`
          .env({ ...process.env, ...env })
          .text(),
      catch: (e) => new ShellCommandFailureError({ cause: e, message: `The restic forget command failed` }),
    });

    return yield* parseForgetPruneOutput(output);
  });

/**
 * Validation schema of a restic backup output extracted data
 */
const RESTIC_BACKUP_OUTPUT_SCHEMA = z.object({
  data_added: z.number(),
  total_bytes_processed: z.number(),
  total_duration: z.number(),
});

interface ParseResticBackupOutputOptions {
  /**
   * Fail with an {@link EmptyBackupError} when restic processed 0 byte.
   * Set for `--stdin` database dumps, where an empty stream can only mean the
   * dump produced nothing; an empty *volume* set is legitimate.
   */
  rejectEmpty?: boolean;
}

/**
 * Parses the restic backup command output to a structured object
 * @param o The raw output data
 * @returns A structured object
 */
export const parseResticBackupOutput = (
  backupName: string,
  o: string,
  options: ParseResticBackupOutputOptions = {}
): Effect.Effect<ResticSuccessfulBackupStructuredOutput, ParsingError | EmptyBackupError, never> =>
  Effect.gen(function* _parseResticBackupOutput() {
    const output = o.trim().split("\n").at(-1);

    if (!output) {
      return yield* Effect.fail(
        new ParsingError({
          cause: "EMPTY",
          message: "The restic backup output appears to be empty",
        })
      );
    }

    const json = yield* Effect.try({
      try: () => JSON.parse(output),
      catch: (e) => new ParsingError({ cause: e, message: `The restic backup output is not valid JSON.\n${output}` }),
    });

    const { data, error } = RESTIC_BACKUP_OUTPUT_SCHEMA.safeParse(json);

    if (error) {
      return yield* Effect.fail(
        new ParsingError({
          cause: error,
          message: `The restic backup command output is not valid :\n${z.prettifyError(error)}`,
        })
      );
    }

    if (options.rejectEmpty && data.total_bytes_processed === 0) {
      return yield* Effect.fail(new EmptyBackupError({ backupName }));
    }

    return yield* Effect.succeed({
      type: "backup",
      success: true,
      backupName,
      dataAdded: formatBytes(data.data_added),
      totalDuration: formatDuration(data.total_duration),
    } as const);
  });

const RESTIC_BACKUP_LINE_SCHEMA = z.object({
  time: z.coerce.date(),
  short_id: z.string(),
  summary: z.object({
    total_bytes_processed: z.number(),
  }),
});

export interface ResticSnapshotItemStructredOutput {
  date: Date;
  relativeDate: string;
  id: string;
  size: string;
}

export const parseResticSnapshotListOutput = (
  rawOutput: string
): Effect.Effect<ResticSnapshotItemStructredOutput[], ParsingError, never> =>
  Effect.gen(function* _parseResticSnapshotListOutput() {
    const json = yield* Effect.try({
      try: () => JSON.parse(rawOutput),
      catch: (e) =>
        new ParsingError({
          cause: e,
          message: `The restic snapshots output is not valid JSON.\n${rawOutput}`,
        }),
    });

    const { data, error } = z.array(RESTIC_BACKUP_LINE_SCHEMA).safeParse(json);
    if (error) {
      return yield* Effect.fail(
        new ParsingError({
          cause: error,
          message: `The restic snapshots output is not valid :\n${z.prettifyError(error)}`,
        })
      );
    }

    return data
      .map((line) => ({
        date: line.time,
        relativeDate: formatHumanDate(line.time),
        id: line.short_id,
        size: formatBytes(line.summary.total_bytes_processed),
      }))
      .toSorted((a, b) => b.date.getTime() - a.date.getTime());
  });

export const listSnapshots = (
  tag: string
): Effect.Effect<ResticSnapshotItemStructredOutput[], ShellCommandFailureError | ParsingError, ConfigTag> =>
  Effect.gen(function* _listSnapshots() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* Effect.tryPromise({
      try: () => $`restic snapshots --tag ${tag} --json`.env({ ...process.env, ...env }).text(),
      catch: (e) =>
        new ShellCommandFailureError({ cause: e, message: "The restic snapshot list command error failed" }),
    });

    return yield* parseResticSnapshotListOutput(output);
  });

/**
 * How long to wait for the repository probe. The former 5s was short enough that
 * a large repository or a slow S3 endpoint routinely blew through it.
 */
const REPO_PROBE_TIMEOUT_MS = 30_000;

export const ensureRepoInitialized = (): Effect.Effect<
  void,
  ShellCommandFailureError | ResticRepoNotInitializedError,
  ConfigTag
> =>
  Effect.gen(function* _ensureRepoInitialized() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const probe = yield* Effect.tryPromise({
      try: async () => {
        const proc = spawn({
          cmd: ["restic", "snapshots"],
          env: { ...process.env, ...env },
          stdout: "pipe",
          stderr: "pipe",
        });

        // The timeout is tracked here rather than through `spawn({ timeout })` and
        // `signalCode`: restic traps SIGTERM and exits 1 on its own, so a killed
        // probe is indistinguishable from a genuine failure from the outside.
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, REPO_PROBE_TIMEOUT_MS);

        try {
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }

        const stderr = await new Response(proc.stderr).text();

        return { timedOut, exitCode: proc.exitCode, stderr: redact(stderr.trim()) };
      },
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: "Failed to run restic — is it installed and on your PATH ?",
        }),
    });

    // A probe we killed says nothing about the repository: reporting "not
    // initialized" here used to send people to `restic init` against a perfectly
    // healthy repo that was merely slow to answer.
    if (probe.timedOut) {
      return yield* Effect.fail(
        new ShellCommandFailureError({
          cause: "TIMEOUT",
          message: [
            `${chalk.yellow("restic snapshots")} did not answer within ${REPO_PROBE_TIMEOUT_MS / 1000}s and was killed.`,
            probe.stderr,
            "The S3 endpoint may be slow or unreachable — this says nothing about whether the repository is initialized.",
          ]
            .filter(Boolean)
            .join("\n"),
        })
      );
    }

    if (probe.exitCode !== 0) {
      return yield* Effect.fail(
        new ResticRepoNotInitializedError({
          cause: probe.stderr,
          message: [
            `Restic could not open the repository (exit code ${probe.exitCode}).`,
            probe.stderr,
            `If it has never been created, run ${chalk.yellow("dockup restic init")}.`,
          ]
            .filter(Boolean)
            .join("\n"),
        })
      );
    }
  });
