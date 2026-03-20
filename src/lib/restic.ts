import { homedir } from "node:os";

import { $ } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import type { Config } from "./config";
import { ConfigTag } from "./effect";
import { ParsingError, ShellCommandFailureError } from "./errors";
import { formatBytes, formatDuration, formatHumanDate } from "./utils";

/**
 * Converts the dockup configuration to restic required environment variables
 * @param config The dockup config object
 * @returns The restic environment variables
 */
export const configToResticEnv = (config: Config) =>
  Effect.succeed({
    AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
    RESTIC_PASSWORD: config.RESTIC_PASSWORD,
    RESTIC_REPOSITORY: config.RESTIC_REPOSITORY,
    HOME: homedir(),
  });

/**
 * Executes restic command and fill out required environment variables
 * @param args The restic command arguments
 */
export const restic = (args: string[]): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* _restic() {
    const config = yield* ConfigTag;

    const env = yield* configToResticEnv(config);
    yield* Effect.tryPromise({
      try: () => $`restic ${args}`.env(env).then((v) => process.exit(v.exitCode)),
      catch: (e) => {
        if (e instanceof $.ShellError) {
          return process.exit(e.exitCode);
        }
        return process.exit(1);
      },
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

export interface ResticSuccessfulVolumeBackupStructuredOutput {
  success: true;
  type: "backup";
  volumeName: string;
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
        $`restic forget --group-by tags --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --json`.env(env).text(),
      catch: (e) => new ShellCommandFailureError({ cause: e, message: `The restic forget command failed` }),
    });

    return yield* parseForgetPruneOutput(output);
  });

/**
 * Validation schema of a restic backup output extracted data
 */
const RESTIC_BACKUP_OUTPUT_SCHEMA = z.object({
  data_added: z.number(),
  total_duration: z.number(),
});

/**
 * Parses the restic backup command output to a structured object
 * @param o The raw output data
 * @returns A structured object
 */
export const parseResticBackupOutput = (
  backupName: string,
  o: string
): Effect.Effect<ResticSuccessfulBackupStructuredOutput, ParsingError, never> =>
  Effect.gen(function* _parseResticBackupOutput() {
    const output = yield* Effect.try({
      try: () => o.trim().split("\n").at(-1),
      catch: (e) =>
        new ParsingError({
          cause: e,
          message: "The restic backup output parsing failed : output is malformed, cannot get the content",
        }),
    });

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
): Effect.Effect<ResticSnapshotItemStructredOutput[], string, never> =>
  Effect.gen(function* _parseResticSnapshotListOutput() {
    const o = JSON.parse(rawOutput);
    const { data, error } = z.array(RESTIC_BACKUP_LINE_SCHEMA).safeParse(o);
    if (error) return yield* Effect.fail("");

    return yield* Effect.succeed(
      data
        .map((line) => ({
          date: line.time,
          relativeDate: formatHumanDate(line.time),
          id: line.short_id,
          size: formatBytes(line.summary.total_bytes_processed),
        }))
        .toSorted((a, b) => b.date.getTime() - a.date.getTime())
    );
  });

export const listSnapshots = (
  tag: string
): Effect.Effect<ResticSnapshotItemStructredOutput[], ShellCommandFailureError | string, ConfigTag> =>
  Effect.gen(function* _listSanpshots() {
    const config = yield* ConfigTag;
    const env = yield* configToResticEnv(config);

    const output = yield* Effect.tryPromise({
      try: () => $`restic snapshots --tag ${tag} --json`.env(env).text(),
      catch: (e) =>
        new ShellCommandFailureError({ cause: e, message: "The restic snapshot list command error failed" }),
    });

    return yield* parseResticSnapshotListOutput(output);
  });
