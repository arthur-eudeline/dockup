import { intro, log, outro, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { restoreMariaDB, restorePostgres, restoreVolumes } from "../lib/backup";
import { runCommand } from "../lib/cli";
import { ensureDockerPermissions, listBackupEnabledContainers } from "../lib/docker";
import { NoSnapshotsError } from "../lib/errors";
import { promptSelectContainer, promptSelectSnapshot } from "../lib/prompts";
import { listSnapshots } from "../lib/restic";
import type { TaskLog } from "../lib/types";

/**
 * Restores a restic snapshot into its container.
 *
 * The whole flow is a single Effect handed to `runCommand`: discovery, prompts
 * and the restore itself all report through the typed error channel, so any
 * failure is rendered uniformly and mapped to an exit code. Nothing here calls
 * `process.exit`, and for volume restores the container is guaranteed to be
 * restarted even on failure or Ctrl-C (see `restoreVolumes`).
 */
export const RestoreCommand = new Command()
  .name("restore")
  .description("Restores a restic snapshot")
  .action(() =>
    runCommand(
      Effect.gen(function* _restore() {
        intro("Restoring backup");

        yield* ensureDockerPermissions();

        const { containers, invalid } = yield* listBackupEnabledContainers();

        // An unreadable container must not hide the ones that are restorable.
        for (const { id, error } of invalid) {
          log.warn(`Ignoring ${chalk.yellow(id)} — unreadable dockup labels : ${error._tag} ${error.message}`);
        }

        if (containers.length === 0) {
          log.warn(
            `No running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label — nothing to restore.`
          );
          return;
        }

        const container = yield* promptSelectContainer(containers);

        const snapshots = yield* listSnapshots(container.backupName);
        if (snapshots.length === 0) {
          return yield* Effect.fail(new NoSnapshotsError({ backupName: container.backupName }));
        }

        const snapshot = yield* promptSelectSnapshot(snapshots);

        const logger: TaskLog = taskLog({
          title: `Restoring ${chalk.blue(container.backupName)} from snapshot ${chalk.yellow(snapshot.id)} (${snapshot.relativeDate})`,
          spacing: 0,
        });

        const restore = Effect.gen(function* _doRestore() {
          switch (container.type) {
            case "postgres": {
              return yield* restorePostgres(container, snapshot.id, logger);
            }
            case "mariadb": {
              return yield* restoreMariaDB(container, snapshot.id, logger);
            }
            case "volumes": {
              return yield* restoreVolumes(container, snapshot.id, logger);
            }
            default: {
              return yield* Effect.dieMessage("Unhandled backup type.");
            }
          }
        });

        yield* restore.pipe(
          Effect.tapError(() => Effect.sync(() => logger.error("Restore failed."))),
          Effect.tap(() => Effect.sync(() => logger.success("Snapshot restored.")))
        );

        outro("Done.");
      })
    )
  );
