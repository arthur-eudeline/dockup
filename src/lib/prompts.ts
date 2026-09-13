// oxlint-disable promise/prefer-await-to-then
import { confirm, isCancel, log, S_SUCCESS, select, spinner, taskLog } from "@clack/prompts";
import type { SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { Effect } from "effect";

import type { AnyTaggedError } from "./effect";
import { PromptCancelledError } from "./errors";
import type { ResticSnapshotItemStructredOutput } from "./restic";
import { describeSource } from "./sources";
import type { BackupSource } from "./sources";
import type { BackupTarget } from "./targets";
import type { TaskLog } from "./types";

/** How many lines of a running command stay on screen. */
const TASK_LOG_LINES = 10;

/**
 * The task log a command streaming a child process' output writes to.
 *
 * `limit` is not cosmetic : without it clack keeps every line it was ever handed
 * and redraws the whole block on each new one, so a restore reporting its
 * progress once a second would get slower and slower and push everything else
 * off the screen. A ten line window is enough to watch a command work — and what
 * matters on a failure is quoted back in the error anyway.
 */
export const streamingTaskLog = (title: string): TaskLog => taskLog({ limit: TASK_LOG_LINES, spacing: 0, title });

/**
 * Run any `@clack/prompts` prompt as an Effect: a user cancel (Ctrl-C / Esc)
 * becomes a typed `PromptCancelledError` instead of a bare `process.exit`.
 */
export const prompt = <T>(run: () => Promise<T | symbol>): Effect.Effect<T, PromptCancelledError> =>
  Effect.gen(function* _prompt() {
    const value = yield* Effect.promise(run);
    if (isCancel(value)) return yield* Effect.fail(new PromptCancelledError({}));
    return value;
  });

export const promptSelect = <T>(args: SelectOptions<T>): Effect.Effect<T, PromptCancelledError> =>
  prompt(() => select<T>(args));

/** Where the data is going — asked first, because it decides what can be offered next. */
export const promptSelectTarget = (targets: BackupTarget[]): Effect.Effect<BackupTarget, PromptCancelledError, never> =>
  promptSelect({
    message: "Choose what to restore into",
    options: targets.map((target) => ({
      label: target.backupName,
      // The source matters here: restoring a host target writes straight into a
      // database nothing else is going to stop first.
      hint: target.source === "host" ? `${target.type} (host)` : target.type,
      value: target,
    })),
  } as SelectOptions<BackupTarget>);

/**
 * Which backup the data comes from.
 *
 * The destination's own backup is preselected when it still has one, so the
 * ordinary restore stays a matter of pressing enter, and restoring *another*
 * backup into this target is a deliberate move down the list.
 */
export const promptSelectSource = (
  sources: BackupSource[],
  destination: BackupTarget
): Effect.Effect<BackupSource, PromptCancelledError, never> =>
  promptSelect({
    initialValue: sources.find((source) => source.backupName === destination.backupName),
    message: `Choose the backup to restore into ${chalk.blue(destination.backupName)}`,
    options: sources.map((source) => ({
      hint: describeSource(source, destination),
      label: source.backupName === destination.backupName ? source.backupName : chalk.yellow(source.backupName),
      value: source,
    })),
  } as SelectOptions<BackupSource>);

export const promptSelectSnapshot = (snapshots: ResticSnapshotItemStructredOutput[]) =>
  promptSelect({
    message: "Choose a snapshot",
    options: snapshots.map((snapshot) => ({
      label: `${chalk.yellow(snapshot.id)} - ${snapshot.size}\t ${snapshot.relativeDate}`,
      value: snapshot,
    })),
  });

/**
 * Asks before doing something the user did not ask for twice.
 *
 * Declining is a cancellation, not a failure: it goes through
 * `PromptCancelledError` like a Ctrl-C, so the command stops the same way.
 */
export const promptConfirm = (message: string): Effect.Effect<void, PromptCancelledError> =>
  Effect.gen(function* _promptConfirm() {
    const accepted = yield* prompt(() => confirm({ initialValue: false, message }));
    if (!accepted) return yield* Effect.fail(new PromptCancelledError({}));
  });

/**
 * Runs a probe under a spinner, renders its outcome, and never fails.
 *
 * Returns the value on success and `null` on failure, so a caller can keep using
 * the result without assigning it from inside a callback.
 */
export const safeSpinner = <A, E extends AnyTaggedError, R>(
  effect: Effect.Effect<A, E, R>,
  args: {
    title: string;
    onSuccess: (result: A) => string;
    onError: (msg: E) => string;
  }
): Effect.Effect<A | null, never, R> =>
  Effect.gen(function* _safeSpinner() {
    const s = spinner();
    s.start(args.title);

    return yield* effect.pipe(
      Effect.tap((result) => Effect.sync(() => s.stop(args.onSuccess(result)))),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          s.error(args.onError(error));
          return null;
        })
      )
    );
  });

/**
 * Runs a step under a spinner, renders its outcome, and propagates its failure.
 *
 * Same shape as {@link taskSpinner} without the skip branch — so the success
 * value keeps its type and the caller can go on using it.
 */
export const stepSpinner = <A, E extends AnyTaggedError, R>(
  effect: Effect.Effect<A, E, R>,
  args: {
    title: string;
    onSuccess: (result: A) => string;
    onError: (error: E) => string;
  }
): Effect.Effect<A, E, R> =>
  Effect.gen(function* _stepSpinner() {
    const s = spinner();
    s.start(args.title);

    return yield* effect.pipe(
      Effect.tapError((error) => Effect.sync(() => s.error(args.onError(error)))),
      Effect.tap((result) => Effect.sync(() => s.stop(args.onSuccess(result))))
    );
  });

export const taskSpinner = <A, E extends AnyTaggedError, R>(
  effect: Effect.Effect<A, E, R>,
  args: {
    title: string;
    onSuccess: (result: A) => string;
    onError: (msg: E) => string;
    skip?: {
      onSkip: () => string;
      condition: Effect.Effect<boolean>;
    };
  }
): Effect.Effect<A | null, E, R> =>
  Effect.gen(function* _taskSpinner() {
    const s = spinner();
    s.start(args.title);

    if (args.skip) {
      const skip = yield* args.skip.condition;
      if (skip) {
        s.clear();
        log.message(args.skip.onSkip(), {
          symbol: chalk.yellow(S_SUCCESS),
          spacing: 0,
        });
        return null;
      }
    }

    const result = yield* effect.pipe(
      // On Error
      Effect.catchAll((e) => {
        s.clear();
        log.message(args.onError(e), {
          symbol: chalk.red(S_SUCCESS),
          spacing: 0,
        });
        return Effect.fail(e);
      })
    );

    s.clear();
    log.message(args.onSuccess(result), {
      symbol: chalk.green(S_SUCCESS),
      spacing: 0,
    });

    return result;
  });
