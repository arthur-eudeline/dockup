// oxlint-disable promise/prefer-await-to-then
import { isCancel, select } from "@clack/prompts";
import type { SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { Effect } from "effect";

import type { ContainerBackupConfig } from "./docker";
import type { ResticSnapshotItemStructredOutput } from "./restic";

export const promptSelect = <T>(args: SelectOptions<T>) =>
  Effect.promise(() =>
    select<T>(args).then((v) => {
      if (isCancel(v)) {
        process.exit(0);
      }
      return v;
    })
  );

export const promptSelectContainer = (
  containers: ContainerBackupConfig[]
): Effect.Effect<ContainerBackupConfig, never, never> =>
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
