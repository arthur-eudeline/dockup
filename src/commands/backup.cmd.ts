import { intro, log, outro, spinner, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { backupMariaDB, backupPostgres, backupVolumes } from "../lib/backup";
import { formatDiscordReport, notifyDiscord } from "../lib/discord";
import { listBackupEnabledContainers } from "../lib/docker";
import { effectRuntime } from "../lib/effect";
import type { AnyTaggedError } from "../lib/effect";
import { resticCleanUp } from "../lib/restic";
import type {
  ResticStructuredOutput,
  ResticSuccessfulBackupStructuredOutput,
  ResticSuccessfulVolumeBackupStructuredOutput,
} from "../lib/restic";
import type { TaskLog } from "../lib/types";

const reportLines: ResticStructuredOutput[] = [];

const handleTaskError =
  (task: TaskLog, backupName: string) =>
  <R, E extends AnyTaggedError, A>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchAll(effect, (e) => {
      // 1. Mise à jour de l'UI
      task.error(`Backup failed ${chalk.red(backupName)} : ${e._tag} ${e.message}`);

      // 2. Ajout au rapport (Effet de bord sur reportLines)
      reportLines.push({
        type: "backup",
        success: false,
        backupName: backupName,
        message: e.message,
        code: e._tag,
      });

      // 3. On "récupère" l'erreur en retournant un succès (null)
      // pour que la boucle continue sur les conteneurs suivants
      return Effect.void;
    });

const handleTaskSuccess =
  (task: TaskLog, backupName: string) =>
  <A extends ResticSuccessfulBackupStructuredOutput | ResticSuccessfulVolumeBackupStructuredOutput[], E, R>(
    effect: Effect.Effect<A, E, R>
  ) =>
    Effect.tap(effect, (report) => {
      if (Array.isArray(report)) {
        const lines = report.map(
          (line) => `\t - ${chalk.blue(line.volumeName)} in ${chalk.yellow(line.totalDuration)}`
        );
        task.success(`Backuped ${chalk.green(backupName)} :\n${lines.join("\n")}`);
        reportLines.push(...report);
      } else {
        task.success(`Backuped ${chalk.green(backupName)} in ${chalk.yellow(report.totalDuration)}`);
        reportLines.push(report);
      }
    });

export const BackupCommand = new Command()
  .name("backup")
  .description("Scans the containers running on the system and back them up according to their labels")
  .action(async () => {
    const program = Effect.gen(function* _program() {
      const containers = yield* listBackupEnabledContainers().pipe(
        Effect.catchAll((e) =>
          Effect.gen(function* _onListError() {
            const msg = `🔴 failed to backup : (\`${e._tag}\`) ${e.message}\n\n(@everyone)`;
            yield* notifyDiscord(msg);
            log.error(msg.slice(2));
            process.exit(1);
          })
        )
      );

      intro(`Backuping ${chalk.yellow(containers.length)} containers`);
      for (const container of containers) {
        const logger = taskLog({
          title: `Backuping ${chalk.blue(container.backupName)} (${chalk.yellow(container.id)})`,
          spacing: 0,
        });

        if (container.type === "mariadb") {
          yield* backupMariaDB(container).pipe(
            handleTaskSuccess(logger, container.backupName),
            handleTaskError(logger, container.backupName)
          );
          continue;
        } else if (container.type === "postgres") {
          yield* backupPostgres(container, logger).pipe(
            handleTaskSuccess(logger, container.backupName),
            handleTaskError(logger, container.backupName)
          );
          continue;
        } else if (container.type === "volumes") {
          yield* backupVolumes(container, logger).pipe(
            handleTaskSuccess(logger, container.backupName),
            handleTaskError(logger, container.backupName)
          );
          continue;
        }
      }

      // Clean up
      const cleanUpTask = spinner();
      cleanUpTask.start("Cleaning up old snapshots...");
      const cleanUpReport = yield* resticCleanUp();
      cleanUpTask.stop(chalk.green(`${cleanUpReport.snapshotsRemoved} snapshots cleaned up !`));
      reportLines.push(cleanUpReport);

      // Notify
      const messages = yield* formatDiscordReport(reportLines);
      // yield* Effect.all(messages.map(notifyDiscord));
    }).pipe(
      Effect.catchAll((e) => {
        console.error(e);
        return Effect.void;
      }),
      Effect.ensureErrorType<never>()
    );

    await effectRuntime.runPromise(program);
    outro(`Done the ${new Date().toLocaleDateString("fr")} at ${new Date().toLocaleTimeString("fr")}`);
  });
