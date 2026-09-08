import { dirname } from "node:path";

// oxlint-disable prefer-destructuring
import { $ } from "bun";
import { Effect } from "effect";

import { ShellCommandFailureError, FileSystemPermissionError } from "./errors";
import { redact } from "./redact";

/**
 * Marker for a fragment that must be interpolated verbatim by {@link sh} instead
 * of being quoted as a single word — a pre-built list of flags, typically.
 */
const RAW = Symbol("dockup.shell.raw");

export interface ShellFragment {
  readonly [RAW]: string;
}

/**
 * Opts a fragment out of {@link sh}'s quoting. Only ever use it on a string this
 * codebase built itself out of already-quoted parts — never on a value read from
 * a container's labels or environment.
 */
export const raw = (fragment: string): ShellFragment => ({ [RAW]: fragment });

/**
 * Single-quotes a value so the shell takes it literally, whatever it contains
 * (`$`, backticks, quotes, newlines…).
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Tagged template building a shell command with every interpolated value quoted.
 * Values reaching these commands come from `docker inspect` / `docker exec env`
 * (volume paths, DB users, passwords), so they are attacker-influenced input as
 * far as this process is concerned.
 *
 * @example sh`docker exec ${containerId} cat ${path}`
 */
export const sh = (strings: TemplateStringsArray, ...values: (string | ShellFragment)[]): string => {
  let output = strings[0] ?? "";

  for (const [index, value] of values.entries()) {
    output += typeof value === "string" ? shellQuote(value) : value[RAW];
    output += strings[index + 1] ?? "";
  }

  return output;
};

/**
 * Runs the command through `bash` with `pipefail` on.
 *
 * Bun's built-in shell reports only the *last* command of a pipeline, so
 * `pg_dump … | restic backup --stdin` exited 0 even when the dump had failed —
 * committing an empty snapshot reported as a success. Every pipeline dockup runs
 * is a backup or a restore, so a broken left-hand side must fail the whole thing.
 */
const bash = (cmd: string) => $`bash -o pipefail -c ${cmd}`;

/** Environment handed to a child process: the ambient one plus explicit overrides. */
const childEnv = (env?: Record<string, string>): Record<string, string | undefined> => ({ ...process.env, ...env });

/**
 * Executes a shell command and returns its output trimed
 * @param cmd The shell command — build it with {@link sh} when it interpolates anything
 * @returns The command output
 */
export const getShellOutput = (cmd: string): Effect.Effect<string, ShellCommandFailureError> =>
  Effect.gen(function* _getShellOutput() {
    const result = yield* Effect.tryPromise({
      try: () => bash(cmd).text(),
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: redact(`The command "${cmd}" failed`),
        }),
    }).pipe(Effect.map((r) => r.trim()));

    return yield* Effect.succeed(result);
  });

interface StreamShellOutputArgs {
  /** The shell command — build it with {@link sh} when it interpolates anything */
  cmd: string;
  env?: Record<string, string>;
  logger?: { message: (str: string) => void };
  onError?: (error: unknown) => void;
  onSuccess?: () => void;
}

export const streamShellOutput = (args: StreamShellOutputArgs): Effect.Effect<string, ShellCommandFailureError> =>
  Effect.gen(function* _streamShellOutput() {
    const output: string[] = [];
    yield* Effect.tryPromise({
      try: async () => {
        for await (const line of bash(args.cmd).env(childEnv(args.env)).lines()) {
          const safe = redact(line);
          output.push(safe);
          args.logger?.message(safe);
        }
      },
      catch: (e) => {
        args.onError?.(e);
        return new ShellCommandFailureError({
          cause: e,
          message: redact(`The command ${args.cmd} failed`),
        });
      },
    });

    args.onSuccess?.();
    return yield* Effect.succeed(output.join("\n"));
  });

/**
 * Convert bytes values into readable format
 */
export const formatBytes = (bytes: number, decimals: number = 2): string => {
  if (bytes === 0) {
    return "00 B";
  }
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const output = (bytes / k ** i).toFixed(dm);
  return `${output.padStart(decimals + 3, "0")} ${sizes[i]}`;
};

/**
 * Converts a duration in a readable format
 */
export const formatDuration = (seconds: number): string => {
  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)}ms`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0) {
    parts.push(`${m}m`);
  }
  if (s > 0 || parts.length === 0) {
    parts.push(`${s}s`);
  }

  return parts.join(" ");
};

const DAY_MS = 86_400_000;

/**
 * Reads a date back from the state file. Anything unparsable — a hand-edited
 * file, a value written by an older version — reads as "unknown" rather than an
 * `Invalid Date` that would silently poison every comparison downstream.
 */
export const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Whole days elapsed from `from` to `to`, floored, never negative. */
export const daysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));

/**
 * Formate une date pour un affichage humain dans le CLI
 */
export const formatHumanDate = (date: Date) => {
  const now = new Date();

  // On remet les heures à zéro pour comparer uniquement les jours
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffTime = today.getTime() - target.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };

  // Formateurs réutilisables
  const timeStr = date.toLocaleTimeString("fr-FR", timeOptions).replace(":", "h");
  const fullDateStr = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

  if (diffDays === 0) {
    return `today at ${timeStr} (${fullDateStr})`;
  }

  if (diffDays === 1) {
    return `yesterday at ${timeStr} (${fullDateStr})`;
  }

  if (diffDays > 1 && diffDays < 7) {
    return `${diffDays} days ago at ${timeStr} (${fullDateStr})`;
  }

  return `${fullDateStr} at ${timeStr}`;
};

/**
 * Fails unless the directory holding `filePath` is writable.
 *
 * @param filePath The *file* to be written — its parent directory is the one tested
 */
export const ensureWritePermission = (
  filePath: string
): Effect.Effect<void, FileSystemPermissionError | ShellCommandFailureError, never> =>
  Effect.gen(function* _ensureWritePermission() {
    const dir = dirname(filePath);

    // `nothrow`: a non-zero `test -w` is the answer, not an error to catch.
    const exitCode = yield* Effect.tryPromise({
      try: () =>
        $`test -w ${dir}`
          .quiet()
          .nothrow()
          .then((r) => r.exitCode),
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `Failed to test write permission for path ${filePath}`,
        }),
    });

    if (exitCode !== 0) {
      return yield* Effect.fail(new FileSystemPermissionError({ path: filePath }));
    }
  });
