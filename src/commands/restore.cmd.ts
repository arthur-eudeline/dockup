import { intro, log, outro, password } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import {
  resolveContainerTargets,
  resolveHostTargets,
  restoreClickhouse,
  restoreMariaDB,
  restorePostgres,
  restoreVolumes,
  setPostgresRolePassword,
} from "../lib/backup";
import { runCommand } from "../lib/cli";
import type { ContainerDiscovery } from "../lib/docker";
import { ensureDockerPermissions, getContainerVolumes, listBackupEnabledContainers } from "../lib/docker";
import { ConfigTag } from "../lib/effect";
import { NoCompatibleBackupError, NoSnapshotsError } from "../lib/errors";
import {
  prompt,
  promptConfirm,
  promptSelectSnapshot,
  promptSelectSource,
  promptSelectTarget,
  streamingTaskLog,
} from "../lib/prompts";
import { listSnapshots } from "../lib/restic";
import { compatibleSources, dumpPath, groupSnapshotsIntoSources } from "../lib/sources";
import type { PostgresTarget } from "../lib/targets";
import { mergeTargets } from "../lib/targets";
import type { TaskLog } from "../lib/types";

/**
 * Restores a snapshot into a target.
 *
 * Destination first, data second: a target is picked among those discovered on
 * this host, and only then the backup to pour into it — any backup that fits,
 * not just the one bearing its name (see `sources.ts` for what "fits" means).
 * That is what makes restoring one database into another, or last month's
 * container into the one that replaced it, possible at all.
 *
 * The whole flow is a single Effect handed to `runCommand`: discovery, prompts
 * and the restore itself all report through the typed error channel, so any
 * failure is rendered uniformly and mapped to an exit code. Nothing here calls
 * `process.exit`, and for volume restores the container is guaranteed to be
 * restarted even on failure or Ctrl-C (see `restoreVolumes`).
 */
/** Restoring anything but postgres creates no role, so there is nothing to ask about. */
const NO_ROLES: string[] = [];

/**
 * Asks for the password of every role the restore had to create.
 *
 * A dump carries its owners but not their passwords, so those roles come back
 * with the right name, the right tables and no way to authenticate: the restore
 * reports success and the application still cannot connect. This is the one
 * moment someone is watching, so it is asked here rather than left to be found
 * out later.
 *
 * An empty answer skips — the operator does not always have the password to
 * hand, and a role may exist only to own things. Whatever is skipped is named at
 * the end: replacing a silent failure with a prompt nobody has to answer would
 * only move the surprise.
 */
const promptRestoredRolePasswords = (target: PostgresTarget, roles: string[]) =>
  Effect.gen(function* _promptRestoredRolePasswords() {
    const named = roles.map((role) => chalk.yellow(role)).join(", ");
    log.warn(
      `The restore created ${roles.length === 1 ? "a role that has" : `${roles.length} roles that have`} no password yet: ${named}`
    );

    const skipped: string[] = [];

    for (const role of roles) {
      const value = yield* prompt(() => password({ message: `Password for ${chalk.yellow(role)} (empty to skip)` }));

      if (value) {
        yield* setPostgresRolePassword(target, role, value);
        log.success(`Password set for ${chalk.yellow(role)}.`);
      } else {
        skipped.push(role);
      }
    }

    if (skipped.length > 0) {
      log.warn(`Still unable to connect, no password set: ${skipped.map((role) => chalk.yellow(role)).join(", ")}`);
    }
  });

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

        // Expands every `allDatabases` postgres container into one target per
        // database found on it, the same way `backup` does.
        const containerResolution = yield* resolveContainerTargets(discovery.containers);

        // An unreadable container, or a host instance that could not be reached,
        // must not hide the targets that are restorable.
        for (const { id, error } of discovery.invalid) {
          log.warn(`Ignoring ${chalk.yellow(id)} — unreadable dockup labels : ${error._tag} ${error.message}`);
        }
        for (const { id, error } of containerResolution.invalid) {
          log.warn(`Ignoring ${chalk.yellow(id)} — could not list its databases : ${error._tag} ${error.message}`);
        }
        for (const { name, error } of hostDiscovery.invalid) {
          log.warn(`Ignoring host target ${chalk.yellow(name)} — ${error._tag} ${error.message}`);
        }

        const { collisions, targets } = mergeTargets(hostDiscovery.targets, containerResolution.containers);
        for (const name of collisions) {
          log.warn(`Two targets claim the backup name ${chalk.yellow(name)} — the container one is ignored.`);
        }

        if (targets.length === 0) {
          log.warn(
            `No running container carries the ${chalk.yellow("dockup.backup.enabled=true")} label and no host target is declared — nothing to restore.`
          );
          return;
        }

        // 1. Where the data goes. Asked first : the destination is what decides
        //    which backups are worth offering at all.
        const target = yield* promptSelectTarget(targets);

        const snapshots = yield* listSnapshots();
        if (snapshots.length === 0) {
          return yield* Effect.fail(new NoSnapshotsError({ backupName: target.backupName }));
        }

        // A volume restore writes a snapshot back to the absolute paths it was
        // taken from, so what this container mounts is what decides whether a
        // snapshot has anything to give it.
        const destinationPaths =
          target.type === "volumes" ? (yield* getContainerVolumes(target.id)).map((volume) => volume.Destination) : [];

        // 2. What is poured into it, among the backups that fit.
        const sources = compatibleSources(target, groupSnapshotsIntoSources(snapshots, targets), destinationPaths);
        if (sources.length === 0) {
          return yield* Effect.fail(new NoCompatibleBackupError({ backupName: target.backupName, type: target.type }));
        }

        const source = yield* promptSelectSource(sources, target);
        const snapshot = yield* promptSelectSnapshot(source.snapshots);

        // Restoring a backup into the target it came from is the ordinary case;
        // pouring one target's data into another is not, and it overwrites what
        // is there — so it is confirmed rather than assumed.
        if (source.backupName !== target.backupName) {
          yield* promptConfirm(
            `Restore ${chalk.yellow(source.backupName)} into ${chalk.blue(target.backupName)}? Its current data is overwritten.`
          );
        }

        const logger: TaskLog = streamingTaskLog(
          `Restoring ${chalk.blue(target.backupName)} from ${chalk.yellow(source.backupName)} snapshot ${chalk.yellow(snapshot.id)} (${snapshot.relativeDate})`
        );

        const dump = { path: dumpPath(snapshot, source), snapshotId: snapshot.id };

        const restore = Effect.gen(function* _doRestore() {
          switch (target.type) {
            case "postgres": {
              return yield* restorePostgres(target, dump, logger);
            }
            case "mariadb": {
              yield* restoreMariaDB(target, dump, logger);
              return NO_ROLES;
            }
            case "clickhouse": {
              yield* restoreClickhouse(target, dump, logger);
              return NO_ROLES;
            }
            case "volumes": {
              yield* restoreVolumes(target, snapshot.id, logger);
              return NO_ROLES;
            }
            default: {
              return yield* Effect.dieMessage("Unhandled backup type.").pipe(Effect.as(NO_ROLES));
            }
          }
        });

        const createdRoles = yield* restore.pipe(
          Effect.tapError(() => Effect.sync(() => logger.error("Restore failed."))),
          Effect.tap(() => Effect.sync(() => logger.success("Snapshot restored.")))
        );

        if (target.type === "postgres" && createdRoles.length > 0) {
          yield* promptRestoredRolePasswords(target, createdRoles);
        }

        outro("Done.");
      })
    )
  );
