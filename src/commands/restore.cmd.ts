import { intro, log, outro, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { restoreMariaDB, restorePostgres, restoreVolumes, resolveHostTargets } from "../lib/backup";
import { runCommand } from "../lib/cli";
import type { ContainerDiscovery } from "../lib/docker";
import { ensureDockerPermissions, listBackupEnabledContainers } from "../lib/docker";
import { ConfigTag } from "../lib/effect";
import { NoSnapshotsError } from "../lib/errors";
import { promptSelectSnapshot, promptSelectTarget } from "../lib/prompts";
import { listSnapshots } from "../lib/restic";
import { mergeTargets } from "../lib/targets";
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

        const config = yield* ConfigTag;

        const discoverContainers = Effect.gen(function* _discoverContainers() {
          yield* ensureDockerPermissions();
          return yield* listBackupEnabledContainers();
        });

        // Same rule as `backup` : docker is a hard requirement only when every
        // restorable target lives behind it.
        const discovery =
          config.hosts.length === 0
            ? yield* discoverContainers
            : yield* discoverContainers.pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    log.warn(`Docker unavailable — only host targets are restorable : ${e._tag} ${e.message}`);
                    return { containers: [], invalid: [] } satisfies ContainerDiscovery;
                  })
                )
              );

        const hostDiscovery = yield* resolveHostTargets(config.hosts);

        // An unreadable container, or a host instance that could not be reached,
        // must not hide the targets that are restorable.
        for (const { id, error } of discovery.invalid) {
          log.warn(`Ignoring ${chalk.yellow(id)} — unreadable dockup labels : ${error._tag} ${error.message}`);
        }
        for (const { name, error } of hostDiscovery.invalid) {
          log.warn(`Ignoring host target ${chalk.yellow(name)} — ${error._tag} ${error.message}`);
        }

        const { collisions, targets } = mergeTargets(hostDiscovery.targets, discovery.containers);
        for (const name of collisions) {
          log.warn(`Two targets claim the backup name ${chalk.yellow(name)} — the container one is ignored.`);
        }

        if (targets.length === 0) {
          log.warn(
            `No running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label and no host target is declared — nothing to restore.`
          );
          return;
        }

        const target = yield* promptSelectTarget(targets);

        const snapshots = yield* listSnapshots(target.backupName);
        if (snapshots.length === 0) {
          return yield* Effect.fail(new NoSnapshotsError({ backupName: target.backupName }));
        }

        const snapshot = yield* promptSelectSnapshot(snapshots);

        const logger: TaskLog = taskLog({
          title: `Restoring ${chalk.blue(target.backupName)} from snapshot ${chalk.yellow(snapshot.id)} (${snapshot.relativeDate})`,
          spacing: 0,
        });

        const restore = Effect.gen(function* _doRestore() {
          switch (target.type) {
            case "postgres": {
              return yield* restorePostgres(target, snapshot.id, logger);
            }
            case "mariadb": {
              return yield* restoreMariaDB(target, snapshot.id, logger);
            }
            case "volumes": {
              return yield* restoreVolumes(target, snapshot.id, logger);
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
