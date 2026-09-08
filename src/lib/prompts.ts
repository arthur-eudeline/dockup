// oxlint-disable promise/prefer-await-to-then
import { isCancel, log, S_SUCCESS, select, spinner } from "@clack/prompts";
import type { SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { Effect } from "effect";

import type { ContainerBackupConfig } from "./docker";
import type { AnyTaggedError } from "./effect";
import { PromptCancelledError } from "./errors";
import type { ResticSnapshotItemStructredOutput } from "./restic";

export const promptSelect = <T>(args: SelectOptions<T>): Effect.Effect<T, PromptCancelledError> =>
  Effect.gen(function* _promptSelect() {
    const value = yield* Effect.promise(() => select<T>(args));
    if (isCancel(value)) return yield* Effect.fail(new PromptCancelledError({}));
    return value;
  });

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

export const safeSpinner = <A, E extends AnyTaggedError, R>(
  effect: Effect.Effect<A, E, R>,
  args: {
    title: string;
    onSuccess: (result: A) => string;
    onError: (msg: E) => string;
  }
): Effect.Effect<void, never, R> =>
  Effect.gen(function* _safeSpinner() {
    const s = spinner();
    s.start(args.title);
    yield* effect.pipe(
      Effect.map((result) => {
        s.stop(args.onSuccess(result));
        return Effect.void;
      }),
      Effect.catchAll((error) => {
        s.error(args.onError(error));
        return Effect.void;
      })
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
