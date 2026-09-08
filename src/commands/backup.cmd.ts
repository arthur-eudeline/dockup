import { intro, log, outro, spinner, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect, Ref } from "effect";

import { backupMariaDB, backupPostgres, backupVolumes } from "../lib/backup";
import { runCommand } from "../lib/cli";
import { formatDiscordReport, notifyDiscord } from "../lib/discord";
import type { ContainerBackupConfig } from "../lib/docker";
import { listBackupEnabledContainers } from "../lib/docker";
import type { ConfigTag } from "../lib/effect";
import { resticCleanUp } from "../lib/restic";
import type { ResticStructuredOutput } from "../lib/restic";
import type { TaskLog } from "../lib/types";

type Report = Ref.Ref<ResticStructuredOutput[]>;

const record = (report: Report, ...lines: ResticStructuredOutput[]) => Ref.update(report, (acc) => [...acc, ...lines]);

/**
 * Backs up a single container and appends its outcome to the shared report.
 * A failure is caught and turned into a report line so the loop moves on to
 * the next container instead of aborting the whole run.
 */
const backupOne = (
  report: Report,
  container: ContainerBackupConfig,
  task: TaskLog
): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* _backupOne() {
    const backup = Effect.gen(function* _backup() {
      switch (container.type) {
        case "mariadb": {
          return yield* backupMariaDB(container, task);
        }
        case "postgres": {
          return yield* backupPostgres(container, task);
        }
        case "volumes": {
          return yield* backupVolumes(container, task);
        }
        default: {
          return yield* Effect.dieMessage("Unhandled backup type.");
        }
      }
    });

    yield* backup.pipe(
      Effect.tap((line) =>
        Effect.sync(() =>
          task.success(`Backuped ${chalk.green(container.backupName)} in ${chalk.yellow(line.totalDuration)}`)
        )
      ),
      Effect.tap((line) => record(report, line)),
      Effect.catchAll((e) =>
        Effect.zipRight(
          Effect.sync(() => task.error(`Backup failed ${chalk.red(container.backupName)} : ${e._tag} ${e.message}`)),
          record(report, {
            type: "backup",
            success: false,
            backupName: container.backupName,
            message: e.message,
            code: e._tag,
          })
        )
      )
    );
  });

export const BackupCommand = new Command()
  .name("backup")
  .description("Scans the containers running on the system and back them up according to their labels")
  .action(() =>
    runCommand(
      Effect.gen(function* _backupCommand() {
        const report: Report = yield* Ref.make<ResticStructuredOutput[]>([]);

        const { containers, invalid } = yield* listBackupEnabledContainers().pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* _onListError() {
              yield* notifyDiscord(
                `🔴 failed to list containers to backup : (\`${e._tag}\`) ${e.message}\n\n(@everyone)`
              );
              return yield* Effect.fail(e);
            })
          )
        );

        if (containers.length === 0 && invalid.length === 0) {
          log.warn(`No running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label.`);
          return;
        }

        intro(`Backuping ${chalk.yellow(containers.length)} containers`);

        // Containers that opted in but whose labels are unusable: they cannot be
        // backed up, but they must show up in the report rather than vanish.
        for (const { id, error } of invalid) {
          log.error(`Skipping ${chalk.red(id)} : ${error._tag} ${error.message}`);
          yield* record(report, {
            type: "backup",
            success: false,
            backupName: id,
            message: `unreadable dockup labels — ${error.message}`,
            code: error._tag,
          });
        }

        for (const container of containers) {
          const task: TaskLog = taskLog({
            title: `Backuping ${chalk.blue(container.backupName)} (${chalk.yellow(container.id)})`,
            spacing: 0,
          });
          yield* backupOne(report, container, task);
        }

        // Retention cleanup — a failure here must not drop the backup report.
        const cleanUpTask = spinner();
        cleanUpTask.start("Cleaning up old snapshots...");
        yield* resticCleanUp().pipe(
          Effect.tap((cleanUpReport) =>
            Effect.zipRight(
              Effect.sync(() =>
                cleanUpTask.stop(chalk.green(`${cleanUpReport.snapshotsRemoved} snapshots cleaned up !`))
              ),
              record(report, cleanUpReport)
            )
          ),
          Effect.catchAll((e) => Effect.sync(() => cleanUpTask.stop(chalk.red(`Cleanup failed : ${e.message}`))))
        );

        // Always report whatever we managed to do.
        const lines = yield* Ref.get(report);
        const messages = yield* formatDiscordReport(lines);
        yield* Effect.all(messages.map(notifyDiscord), { concurrency: 1 });

        outro(`Done the ${new Date().toLocaleDateString("fr")} at ${new Date().toLocaleTimeString("fr")}`);
      })
    )
  );
