import { dirname } from "node:path";

// oxlint-disable prefer-destructuring
import { $ } from "bun";
import { Effect } from "effect";

import { UndefinedVariableError, ShellCommandFailureError, FileSystemPermissionError } from "./errors";

/**
 * Executes a shell command and returns its output trimed
 * @param cmd The shell command
 * @returns The command output
 */
export const getShellOutput = (cmd: string): Effect.Effect<string, ShellCommandFailureError> =>
  Effect.gen(function* _getShellOutput() {
    const result = yield* Effect.tryPromise({
      try: () => $`${{ raw: cmd }}`.text(),
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `The command "${cmd}" failed`,
        }),
    }).pipe(Effect.map((r) => r.trim()));

    return yield* Effect.succeed(result);
  });

interface StreamShellOutputArgs {
  cmd: string;
  fileWriter?: Bun.FileSink;
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
        for await (const line of $`${{ raw: args.cmd }}`.env(args.env ?? {}).lines()) {
          output.push(line);
          args.logger?.message(line);
        }
      },
      catch: (e) => {
        args.onError?.(e);
        return new ShellCommandFailureError({
          cause: e,
          message: `The command ${args.cmd} failed`,
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

export const ensureWritePermission = (
  p: string
): Effect.Effect<void, FileSystemPermissionError | ShellCommandFailureError, never> =>
  Effect.promise(async () => {
    const dir = dirname(p);
    let exitCode: number = -1;

    try {
      const result = await $`test -w ${dir}`.quiet();
      exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof $.ShellError) {
        exitCode = error.exitCode;
      } else {
        return Effect.fail(
          new ShellCommandFailureError({
            cause: error,
            message: `Failed to test write permission for path ${p}`,
          })
        );
      }
    }

    if (exitCode !== 0) return Effect.fail(new FileSystemPermissionError({ path: p }));

    return Effect.void;
  });
