import { basename, dirname } from "node:path";

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

/** How many trailing stderr lines a failure quotes back in its message. */
const ERROR_CONTEXT_LINES = 10;

/** Environment handed to a child process: the ambient one plus explicit overrides. */
const childEnv = (env?: Record<string, string>): Record<string, string | undefined> => ({ ...process.env, ...env });

interface RunBashOptions {
  /** The shell command — build it with {@link sh} when it interpolates anything */
  cmd: string;
  env?: Record<string, string>;
  /** Fed to the command's stdin — for content too big or too secret for a command line. */
  stdin?: string;
  /** Given every line of stdout *and* stderr as it arrives. */
  logger?: { message: (str: string) => void };
}

interface BashResult {
  stdout: string;
  stderr: string;
}

/**
 * Splits what a stream produced into lines *as they arrive*, and hands the whole
 * of it back at the end.
 *
 * `\r` ends a line just like `\n` does: restic redraws its progress counter with
 * a carriage return, so splitting on newlines alone turns a whole restore into a
 * single line that only shows up once it is over. The raw text is accumulated
 * untouched next to it, because that is what the callers parse.
 */
const pumpStream = async (stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> => {
  const decoder = new TextDecoder();
  let whole = "";
  let pending = "";

  const emit = (text: string, last = false) => {
    if (!onLine) return;
    pending += text;
    const lines = pending.split(/\r\n|[\r\n]/);
    // The last piece has no terminator yet — it is the start of the next line,
    // unless the stream is over and it is all that is left.
    pending = last ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      if (!last || line.length > 0) onLine(line);
    }
  };

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    whole += text;
    emit(text);
  }

  const tail = decoder.decode();
  whole += tail;
  emit(tail, true);

  return whole;
};

/** The one process every command in dockup goes through. */
const spawnBash = (options: RunBashOptions) =>
  Bun.spawn(["bash", "-o", "pipefail", "-c", options.cmd], {
    env: childEnv(options.env),
    stderr: "pipe",
    // Same as Bun's shell when nothing is piped in: a child left waiting on a
    // terminal would hang an unattended run.
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
  });

/**
 * Runs a command through `bash -o pipefail -c`, streaming what it prints.
 *
 * Two reasons this spawns bash itself instead of using Bun's shell. `$` reports
 * only the *last* command of a pipeline, so `pg_dump … | restic backup --stdin`
 * exited 0 even when the dump had failed — committing an empty snapshot reported
 * as a success; hence `pipefail`. And `$` exposes stdout only, while restic, the
 * database clients, systemctl and sudo all say what actually went wrong on
 * **stderr** — which used to be dropped on the floor, leaving a failed restore
 * or a failed `service init` with nothing but an exit code to explain itself.
 *
 * Both streams are drained concurrently — a child whose stderr pipe fills up
 * while nobody reads it blocks forever — but kept apart on the way out: callers
 * parse stdout (restic's `--json` summary is looked up as its last line), and
 * mixing the two would corrupt it.
 */
const runBash = (options: RunBashOptions): Effect.Effect<BashResult, ShellCommandFailureError> =>
  Effect.gen(function* _runBash() {
    let stderr = "";

    const spawn = Effect.sync(() => spawnBash(options));

    const drain = (child: ReturnType<typeof spawnBash>) =>
      Effect.tryPromise({
        try: async () => {
          const onLine = options.logger ? (line: string) => options.logger?.message(redact(line)) : undefined;

          const [stdout, collected] = await Promise.all([
            pumpStream(child.stdout, onLine),
            pumpStream(child.stderr, onLine),
          ]);
          stderr = collected;

          const exitCode = await child.exited;
          if (exitCode !== 0) {
            throw new Error(`exited with code ${exitCode}`);
          }

          return { stderr, stdout } satisfies BashResult;
        },
        catch: (e) =>
          new ShellCommandFailureError({
            cause: e,
            // What stderr said is the only thing that explains the failure, so it
            // travels with the error — all the way to the Discord report.
            message: redact(`The command ${options.cmd} failed${formatErrorContext(stderr)}`),
          }),
      });

    // Interruption kills the shell instead of leaving it running with nobody
    // reading it. A Ctrl-C reaches the whole process group anyway — this covers
    // an interruption that comes from the code, and closes the pipes either way.
    return yield* Effect.acquireUseRelease(spawn, drain, (child) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      })
    );
  });

/** The tail of what a failing command said, appended to its error message. */
const formatErrorContext = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-ERROR_CONTEXT_LINES);

  return lines.length > 0 ? `:\n${lines.join("\n")}` : "";
};

interface GetShellOutputOptions {
  env?: Record<string, string>;
  /** Fed to the command's stdin — for content too big or too secret for a command line. */
  stdin?: string;
}

/**
 * Executes a shell command and returns its output trimed
 *
 * Nothing is streamed and nothing is redacted here : the output is read by the
 * code, not by a human, and some of it *is* the secret being looked up (a
 * container's `env`). Use {@link streamShellOutput} for a command whose progress
 * someone is waiting on.
 *
 * @param cmd The shell command — build it with {@link sh} when it interpolates anything
 * @returns The command output
 */
export const getShellOutput = (
  cmd: string,
  options: GetShellOutputOptions = {}
): Effect.Effect<string, ShellCommandFailureError> =>
  runBash({ cmd, env: options.env, stdin: options.stdin }).pipe(Effect.map((result) => result.stdout.trim()));

interface StreamShellOutputArgs {
  /** The shell command — build it with {@link sh} when it interpolates anything */
  cmd: string;
  env?: Record<string, string>;
  logger?: { message: (str: string) => void };
  onError?: (error: unknown) => void;
  onSuccess?: () => void;
}

/**
 * Runs a command and streams every line it prints — stdout *and* stderr — to
 * `logger`, live, as it arrives. Only stdout is returned.
 */
export const streamShellOutput = (args: StreamShellOutputArgs): Effect.Effect<string, ShellCommandFailureError> =>
  runBash({ cmd: args.cmd, env: args.env, logger: args.logger }).pipe(
    Effect.tapError((failure) => Effect.sync(() => args.onError?.(failure.cause))),
    Effect.tap(() => Effect.sync(() => args.onSuccess?.())),
    // Unlike `getShellOutput`, this output is never a credential — it is restic
    // JSON or a list of database names — and it ends up quoted in parsing errors.
    Effect.map((result) => redact(result.stdout))
  );

/**
 * Asks sudo for its password now, on the terminal.
 *
 * Every other command here captures stderr — which is where sudo writes its
 * prompt — so a password asked from inside a spinner or a task log is invisible
 * and the command just looks frozen. This one inherits the terminal instead, and
 * the cached credentials carry the `sudo` commands that follow.
 */
export const primeSudo = (): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["sudo", "-v"], { stderr: "inherit", stdin: "inherit", stdout: "inherit" });
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new Error(`sudo -v exited with code ${proc.exitCode}`);
      }
    },
    catch: (e) => new ShellCommandFailureError({ cause: e, message: "sudo authentication failed" }),
  });

/** Where `upload.sh` and `dockup upgrade` install the compiled binary. */
export const DEFAULT_INSTALL_PATH = "/usr/local/bin/dockup";

/**
 * Absolute path of the dockup binary — the one systemd must call, and the one
 * `upgrade` replaces.
 *
 * A compiled standalone binary reports itself in `process.execPath`; running from
 * source (`bun src/main.ts`) reports the bun binary instead, in which case the
 * only sensible answer is the path the binary is installed at.
 */
export const resolveBinaryPath = (): string =>
  basename(process.execPath) === "dockup" ? process.execPath : DEFAULT_INSTALL_PATH;

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
export const ensureWritePermission = (filePath: string): Effect.Effect<void, FileSystemPermissionError, never> =>
  // A non-zero `test -w` is the answer, not an error to report : both it and a
  // shell that could not even run mean the same thing to the caller.
  getShellOutput(sh`test -w ${dirname(filePath)}`).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.fail(new FileSystemPermissionError({ path: filePath })))
  );
