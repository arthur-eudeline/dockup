// oxlint-disable promise/prefer-await-to-then
import { isCancel, log, S_SUCCESS, select, spinner } from "@clack/prompts";
import type { SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { Effect } from "effect";

import type { ContainerBackupConfig } from "./docker";
import type { AnyTaggedError } from "./effect";
import { PromptCancelledError } from "./errors";
import type { ResticSnapshotItemStructredOutput } from "./restic";

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

export const promptSelectContainer = (
  containers: ContainerBackupConfig[]
): Effect.Effect<ContainerBackupConfig, PromptCancelledError, never> =>
  promptSelect({
    message: "Choose which backup to restore",
    options: containers.map((container) => ({
      label: container.backupName,
      hint: container.type,
      value: container,
    })),
  } as SelectOptions<ContainerBackupConfig>);

export const promptSelectSnapshot = (snapshots: ResticSnapshotItemStructredOutput[]) =>
  promptSelect({
    message: "Choose a snapshot",
    options: snapshots.map((snapshot) => ({
      label: `${chalk.yellow(snapshot.id)} - ${snapshot.size}\t ${snapshot.relativeDate}`,
      value: snapshot,
    })),
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
