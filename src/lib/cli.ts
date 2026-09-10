import { cancel, log } from "@clack/prompts";
import chalk from "chalk";
import { Cause, Effect } from "effect";

import { AppConfig } from "./effect";
import type { AnyTaggedError, ConfigTag } from "./effect";
import { RELEASES_URL } from "./upgrade";

/**
 * Remediation hints shown under an error, keyed by its `_tag`.
 * Turns a bare failure into an actionable message.
 */
const HINTS: Record<string, string> = {
  CONFIGURATION_RETRIEVAL_ERROR: `Run ${chalk.yellow("dockup config init")} to (re)create the config file.`,
  INVALID_CONFIGURATION_ERROR: `Run ${chalk.yellow("dockup config init")} to rewrite a valid config file.`,
  NON_INTERACTIVE_CONFIG_ERROR: `Supply each value as a ${chalk.yellow("--flag")}, a ${chalk.yellow("DOCKUP_*")} env var, or a key in ${chalk.yellow("--json")} — or run ${chalk.yellow("dockup config init")} in a terminal for the prompts.`,
  RESTIC_REPO_NOT_INITIALIZED_ERROR: `Run ${chalk.yellow("dockup restic init")} to initialize the S3 repository.`,
  PERMISSION_ERROR: `Add your user to the ${chalk.yellow("docker")} group and re-log, or run ${chalk.yellow("dockup service init")}.`,
  FILE_SYSTEM_PERMISSION_ERROR: `Re-run with enough privileges to write the config file.`,
  SHELL_COMMAND_FAILURE_ERROR: `Check that ${chalk.yellow("docker")}, ${chalk.yellow("restic")} and ${chalk.yellow("bash")} are installed and on your PATH.`,
  EMPTY_BACKUP_ERROR: `The dump command wrote nothing — check the container is up and its DB credentials are the ones dockup reads from its environment.`,
  STATE_PERSISTENCE_ERROR: `Run ${chalk.yellow("dockup service init")} to create the state directory, or delete the file if it is corrupt.`,
  RELEASE_FETCH_ERROR: `Check this host can reach ${chalk.yellow("github.com")}, or install the release by hand from ${chalk.yellow(RELEASES_URL)}.`,
  UNSUPPORTED_PLATFORM_ERROR: `Build dockup from source with ${chalk.yellow("bun run build")}.`,
  UPGRADE_ERROR: `Re-run ${chalk.yellow("dockup upgrade")}, or install the asset by hand from ${chalk.yellow(RELEASES_URL)}.`,
};

const isTagged = (u: unknown): u is AnyTaggedError =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as { _tag?: unknown })._tag === "string" &&
  typeof (u as { message?: unknown }).message === "string";

/** Render a fully-typed domain error and return the exit code it maps to. */
const renderError = (error: AnyTaggedError): number => {
  if (error._tag === "PROMPT_CANCELLED_ERROR") {
    cancel("Cancelled.");
    return 130;
  }

  if (error._tag === "NO_SNAPSHOTS_ERROR") {
    log.warn(error.message);
    return 1;
  }

  const hint = HINTS[error._tag];
  log.error(`${chalk.red(error._tag)}\n${error.message}${hint ? `\n\n${chalk.dim(hint)}` : ""}`);
  return 1;
};

/** Render an unexpected failure (a thrown bug, or an interruption). */
const renderDefect = (cause: Cause.Cause<unknown>): number => {
  if (Cause.isInterruptedOnly(cause)) {
    cancel("Interrupted.");
    return 130;
  }

  const defect = Cause.squash(cause);
  const detail = defect instanceof Error ? (defect.stack ?? defect.message) : String(defect);
  log.error(
    `${chalk.red("UNEXPECTED_ERROR")}\n${detail}\n\n${chalk.dim("This is a bug in dockup — please report it.")}`
  );
  return 1;
};

const toExitCode = (cause: Cause.Cause<unknown>): number => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some" && isTagged(failure.value)) return renderError(failure.value);
  return renderDefect(cause);
};

/**
 * Collapse a command effect into an always-succeeding `Effect<number>`:
 * every failure, defect and interruption is rendered and turned into an exit code.
 */
const withHandler = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<number, never, R> =>
  Effect.matchCause(effect, { onFailure: toExitCode, onSuccess: () => 0 });

const applyExitCode = (code: number): void => {
  if (code !== 0) process.exitCode = code;
};

/**
 * Runs a command effect, wiring SIGINT/SIGTERM to Effect interruption so
 * `ensuring` finalizers (e.g. "restart the container") still run on Ctrl-C.
 */
const execute = async (effect: Effect.Effect<number, never, never>): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  try {
    applyExitCode(await Effect.runPromise(effect, { signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) {
      cancel("Interrupted.");
      applyExitCode(130);
    } else {
      applyExitCode(renderDefect(Cause.die(error)));
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
};

/**
 * Entry point for a command that needs the (decrypted) dockup config.
 *
 * Guarantees:
 * - every typed error — a missing/invalid config file included — is rendered
 *   uniformly and mapped to an exit code (never a raw stack trace);
 * - defects and interruptions are caught, never leaked as unhandled rejections;
 * - failures set `process.exitCode` instead of calling `process.exit`, so
 *   `Effect.ensuring` finalizers get to run.
 */
export const runCommand = <E extends AnyTaggedError>(effect: Effect.Effect<void, E, ConfigTag>): Promise<void> =>
  execute(withHandler(effect.pipe(Effect.provide(AppConfig))));

/** Same guarantees as {@link runCommand}, for commands that run without a config file. */
export const runStandalone = <E extends AnyTaggedError>(effect: Effect.Effect<void, E, never>): Promise<void> =>
  execute(withHandler(effect));
