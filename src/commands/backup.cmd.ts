import { intro, log, outro, spinner, taskLog } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect, Ref } from "effect";

import { backupMariaDB, backupPostgres, backupVolumes } from "../lib/backup";
import { runCommand } from "../lib/cli";
import { deliverDiscordMessages, formatDiscordReport } from "../lib/discord";
import type { DiscordMessage } from "../lib/discord";
import type { ContainerBackupConfig } from "../lib/docker";
import { ensureDockerPermissions, listBackupEnabledContainers } from "../lib/docker";
import type { AnyTaggedError, ConfigTag } from "../lib/effect";
import { applyRun, outcomesFromReport, preflightOutcomes } from "../lib/health";
import { ensureRepoInitialized, resticCleanUp } from "../lib/restic";
import type { ResticStructuredOutput } from "../lib/restic";
import { emptyState, knownBackupNames, readState, STATE_PATH, writeState } from "../lib/state";
import type { DockupState } from "../lib/state";
import type { TaskLog } from "../lib/types";

type Report = Ref.Ref<ResticStructuredOutput[]>;

/** Report lines about dockup itself rather than about a backup. */
type Notes = Ref.Ref<string[]>;

const record = (report: Report, ...lines: ResticStructuredOutput[]) => Ref.update(report, (acc) => [...acc, ...lines]);

const note = (notes: Notes, line: string) => Ref.update(notes, (acc) => [...acc, line]);

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
        const now = new Date();
        const report: Report = yield* Ref.make<ResticStructuredOutput[]>([]);
        const notes: Notes = yield* Ref.make<string[]>([]);

        /**
         * The state carried over from previous runs: failure streaks, and the
         * Discord messages those runs could not deliver. Losing it disables the
         * streak alerting but nothing else, so a read failure is reported — both
         * locally and to Discord — and the run carries on with a blank slate.
         */
        const state = yield* readState().pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* _blankState() {
              log.warn(`Backup health state unavailable : ${e.message}`);
              yield* note(
                notes,
                `⚠️ dockup could not read its state at \`${STATE_PATH}\` — failure-streak alerts are disabled until it can. (${e.message})`
              );
              return emptyState();
            })
          )
        );

        /**
         * Hands Discord everything we owe it — messages stranded by previous
         * runs first — then persists what came back undelivered so the next run
         * picks them up. Nothing here is allowed to fail the backup.
         */
        const flush = (messages: string[], nextState: DockupState): Effect.Effect<void, never, ConfigTag> =>
          Effect.gen(function* _flush() {
            const outbox: DiscordMessage[] = [
              ...nextState.pending,
              ...messages.map((content) => ({ at: now.toISOString(), content })),
            ];

            const delivery = yield* deliverDiscordMessages(outbox);

            for (const { reason } of delivery.dropped) {
              log.error(`Discord refused a message and it was dropped : ${reason}`);
            }

            if (delivery.retryable.length > 0) {
              log.warn(
                `${chalk.yellow(delivery.retryable.length)} Discord message(s) undelivered (${delivery.retryable[0]?.reason}) — kept for the next run.`
              );
            }

            yield* writeState({ ...nextState, pending: delivery.retryable.map((f) => f.message) }).pipe(
              Effect.catchAll((e) => Effect.sync(() => log.warn(`Could not persist the dockup state : ${e.message}`)))
            );
          });

        /** Renders an alert locally too — an unattended run still logs to the journal. */
        const announce = (alerts: string[]) =>
          Effect.sync(() => {
            for (const alert of alerts) log.warn(alert);
          });

        /**
         * Aborts the run on a failure that would otherwise repeat itself for every
         * container, after telling Discord why. This command runs unattended from
         * a timer, so one clear diagnostic beats N identical alerts.
         *
         * A run that never started is still a night without backups: every known
         * backup is marked failed, so three aborted nights escalate exactly like
         * three failed ones.
         */
        const preflight = <A, E extends AnyTaggedError, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.tapError((e) =>
              Effect.gen(function* _aborted() {
                const outcomes = preflightOutcomes(knownBackupNames(state), `(\`${e._tag}\`) ${e.message}`);
                const { alerts, state: nextState } = applyRun(state, outcomes, now);

                yield* announce(alerts);
                yield* flush(
                  [
                    `🔴 backup aborted before it started : (\`${e._tag}\`) ${e.message}\n\n(@everyone)`,
                    ...alerts,
                    ...(yield* Ref.get(notes)),
                  ],
                  nextState
                );
              })
            )
          );

        // Same preconditions `restore` and `config check` verify. Without them, a
        // service account missing from the `docker` group failed once per
        // container instead of saying so once.
        yield* preflight(ensureDockerPermissions());
        yield* preflight(ensureRepoInitialized());

        const { containers, invalid } = yield* preflight(listBackupEnabledContainers());

        if (containers.length === 0 && invalid.length === 0) {
          log.warn(`No running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label.`);

          // Nothing to back up is not nothing to say: backups that used to run
          // and no longer show up are exactly what the staleness check catches.
          const { alerts, state: nextState } = applyRun(state, [], now);
          yield* announce(alerts);
          yield* flush([...alerts, ...(yield* Ref.get(notes))], nextState);
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
        const { alerts, state: nextState } = applyRun(state, outcomesFromReport(lines), now);
        yield* announce(alerts);

        const header = `📦 dockup — backup of ${now.toLocaleDateString("fr")} at ${now.toLocaleTimeString("fr")}`;
        const messages = yield* formatDiscordReport(lines, header);

        // Alerts lead: a three-day-old failure matters more than tonight's lines.
        yield* flush([...alerts, ...(yield* Ref.get(notes)), ...messages], nextState);

        outro(`Done the ${new Date().toLocaleDateString("fr")} at ${new Date().toLocaleTimeString("fr")}`);
      })
    )
  );
