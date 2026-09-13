import { intro, log, outro, spinner } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect, Ref } from "effect";

import { backupMariaDB, backupPostgres, backupVolumes, resolveHostTargets } from "../lib/backup";
import { runCommand } from "../lib/cli";
import { deliverDiscordMessages, formatDiscordReport } from "../lib/discord";
import type { DiscordMessage } from "../lib/discord";
import type { ContainerDiscovery } from "../lib/docker";
import { ensureDockerPermissions, listBackupEnabledContainers } from "../lib/docker";
import type { AnyTaggedError } from "../lib/effect";
import { ConfigTag } from "../lib/effect";
import { applyRun, outcomesFromReport, preflightOutcomes } from "../lib/health";
import { streamingTaskLog } from "../lib/prompts";
import { ensureRepoInitialized, resticCleanUp } from "../lib/restic";
import type { ResticStructuredOutput } from "../lib/restic";
import { emptyState, knownBackupNames, readState, STATE_PATH, writeState } from "../lib/state";
import type { DockupState } from "../lib/state";
import { mergeTargets } from "../lib/targets";
import type { BackupTarget } from "../lib/targets";
import type { TaskLog } from "../lib/types";

type Report = Ref.Ref<ResticStructuredOutput[]>;

/** Report lines about dockup itself rather than about a backup. */
type Notes = Ref.Ref<string[]>;

const record = (report: Report, ...lines: ResticStructuredOutput[]) => Ref.update(report, (acc) => [...acc, ...lines]);

const note = (notes: Notes, line: string) => Ref.update(notes, (acc) => [...acc, line]);

/**
 * Backs up a single target and appends its outcome to the shared report.
 * A failure is caught and turned into a report line so the loop moves on to
 * the next target instead of aborting the whole run.
 */
const backupOne = (report: Report, target: BackupTarget, task: TaskLog): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* _backupOne() {
    const backup = Effect.gen(function* _backup() {
      switch (target.type) {
        case "mariadb": {
          return yield* backupMariaDB(target, task);
        }
        case "postgres": {
          return yield* backupPostgres(target, task);
        }
        case "volumes": {
          return yield* backupVolumes(target, task);
        }
        default: {
          return yield* Effect.dieMessage("Unhandled backup type.");
        }
      }
    });

    yield* backup.pipe(
      Effect.tap((line) =>
        Effect.sync(() =>
          task.success(`Backuped ${chalk.green(target.backupName)} in ${chalk.yellow(line.totalDuration)}`)
        )
      ),
      Effect.tap((line) => record(report, line)),
      Effect.catchAll((e) =>
        Effect.zipRight(
          Effect.sync(() => task.error(`Backup failed ${chalk.red(target.backupName)} : ${e._tag} ${e.message}`)),
          record(report, {
            type: "backup",
            success: false,
            backupName: target.backupName,
            message: e.message,
            code: e._tag,
          })
        )
      )
    );
  });

/** How a target is introduced in the task log — a host one has no container id. */
const describeTarget = (target: BackupTarget): string =>
  target.source === "host"
    ? `${chalk.blue(target.backupName)} (${chalk.yellow("host")} ${target.connection.host}:${target.connection.port})`
    : `${chalk.blue(target.backupName)} (${chalk.yellow(target.id)})`;

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

        // Nothing can be backed up without a repository, whatever the target.
        yield* preflight(ensureRepoInitialized());

        const config = yield* ConfigTag;

        // Same precondition `restore` and `config check` verify. Without it, a
        // service account missing from the `docker` group failed once per
        // container instead of saying so once.
        const discoverContainers = Effect.gen(function* _discoverContainers() {
          yield* ensureDockerPermissions();
          return yield* listBackupEnabledContainers();
        });

        /**
         * An unreachable docker daemon aborts the run only when there is nothing
         * else to back up. Host targets never go through docker, and a night
         * where they ran is not a night where nothing ran — so the failure is
         * reported and the container targets simply go unseen, which the
         * staleness rule already escalates after three days.
         */
        const containerDiscovery =
          config.hosts.length === 0
            ? yield* preflight(discoverContainers)
            : yield* discoverContainers.pipe(
                Effect.catchAll((e) =>
                  Effect.gen(function* _withoutDocker() {
                    log.error(`Docker unavailable — container backups skipped : ${e._tag} ${e.message}`);
                    yield* note(
                      notes,
                      `⚠️ docker is unavailable (\`${e._tag}\`) — only the host targets were backed up. ${e.message}`
                    );
                    return { containers: [], invalid: [] } satisfies ContainerDiscovery;
                  })
                )
              );

        // Per-target best-effort, same as container discovery : one broken
        // postgres instance must not cancel the databases another one, or a
        // container, would still back up.
        const hostDiscovery = yield* resolveHostTargets(config.hosts);

        const { containers, invalid } = containerDiscovery;
        const { collisions, targets } = mergeTargets(hostDiscovery.targets, containers);

        for (const name of collisions) {
          log.warn(`Two targets claim the backup name ${chalk.yellow(name)} — the container one is ignored.`);
          yield* note(
            notes,
            `⚠️ \`${name}\` is declared both as a host target and on a running container — the container was ignored.`
          );
        }

        if (targets.length === 0 && invalid.length === 0 && hostDiscovery.invalid.length === 0) {
          log.warn(
            `Nothing to back up : no running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label, and no host target is declared.`
          );

          // Nothing to back up is not nothing to say: backups that used to run
          // and no longer show up are exactly what the staleness check catches.
          const { alerts, state: nextState } = applyRun(state, [], now);
          yield* announce(alerts);
          yield* flush([...alerts, ...(yield* Ref.get(notes))], nextState);
          return;
        }

        intro(`Backuping ${chalk.yellow(targets.length)} targets`);

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

        // Host targets whose databases could not even be listed — the instance
        // is unreachable, typically. Reported the same way : a red line rather
        // than a silent gap in the report.
        for (const { name, error } of hostDiscovery.invalid) {
          log.error(`Skipping host target ${chalk.red(name)} : ${error._tag} ${error.message}`);
          yield* record(report, {
            type: "backup",
            success: false,
            backupName: name,
            message: `host target unreachable — ${error.message}`,
            code: error._tag,
          });
        }

        for (const target of targets) {
          const task: TaskLog = streamingTaskLog(`Backuping ${describeTarget(target)}`);
          yield* backupOne(report, target, task);
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
