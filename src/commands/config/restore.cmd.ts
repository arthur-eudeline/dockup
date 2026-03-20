import { intro, outro, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { restoreMariaDB, restorePostgres, restoreVolumes } from "../../lib/backup";
import { listBackupEnabledContainers } from "../../lib/docker";
import { effectRuntime } from "../../lib/effect";
import { promptSelectContainer, promptSelectSnapshot } from "../../lib/prompts";
import { listSnapshots } from "../../lib/restic";

/**
 * Restores a snapshot
 */
export const restoreCommand = new Command()
  .name("restore")
  .description("Restores a restic snapshot")
  .action(async () => {
    const program = Effect.gen(function* _program() {
      intro("Restauring backup");
      const containers = yield* listBackupEnabledContainers();

      const container = yield* promptSelectContainer(containers);
      const snapshots = yield* listSnapshots(container.backupName);
      const snapshot = yield* promptSelectSnapshot(snapshots);

      const logger = taskLog({
        title: `Restoring ${chalk.blue(container.backupName)} using snapshot ${chalk.yellow(snapshot.id)} (${snapshot.relativeDate})`,
        spacing: 0,
      });

      if (container.type === "postgres") {
        yield* restorePostgres(container, snapshot.id, logger);
      } else if (container.type === "volumes") {
        yield* restoreVolumes(container, snapshot.id, logger);
      } else if (container.type === "mariadb") {
        yield* restoreMariaDB(container, snapshot.id, logger);
      }

      logger.success(`Snapshot restored`);
      outro(`Done.`);
    });

    await effectRuntime.runPromise(program);
  });
