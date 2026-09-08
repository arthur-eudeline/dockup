/**
 * What dockup backs up, whatever it lives in.
 *
 * A container declares itself through its docker labels and hands over its own
 * credentials (`docker exec <id> env`). A database running on the host has
 * neither — no label to carry, no container to exec into — so it is declared in
 * the configuration file and reached over TCP instead. A host target may also
 * cover more than one database (see `resolveHostTargets` in `backup.ts`, which
 * asks the server for the list) — by the time targets reach this module, that
 * question is already answered and every entry names exactly one database.
 *
 * Everything downstream is already source-agnostic: restic is called with
 * `--host <backupName> --tag <backupName>`, the retention policy groups by tag,
 * and `health.ts`/`state.ts` are keyed by backup name. So the two sources only
 * have to meet here, and in the command that builds a dump.
 */

import type { ContainerBackupConfig } from "./docker";

/** Enough to open exactly one database — resolved from a `HostTarget`. */
export interface ResolvedHostConnection {
  database: string;
  host: string;
  password: string;
  port: number;
  user: string;
}

/** A database backed up directly on the host, outside any container. */
export interface HostBackupTarget {
  source: "host";
  backupName: string;
  type: "postgres";
  connection: ResolvedHostConnection;
}

export type BackupTarget = ContainerBackupConfig | HostBackupTarget;

/** The targets `backupPostgres` / `restorePostgres` know how to handle. */
export type PostgresTarget = Extract<BackupTarget, { type: "postgres" }>;

export interface MergedTargets {
  targets: BackupTarget[];
  /** Backup names claimed by both a host target and a container. */
  collisions: string[];
}

/**
 * Merges the two discovery sources.
 *
 * A host target and a container claiming the same backup name would share a
 * restic tag: interleaved snapshots, and a retention policy pruning across both.
 * The collision is reported and the container is the one dropped — an explicit
 * declaration in the config file outranks an ambient label.
 */
export const mergeTargets = (hosts: HostBackupTarget[], containers: ContainerBackupConfig[]): MergedTargets => {
  const claimed = new Set(hosts.map((host) => host.backupName));
  const collisions: string[] = [];
  const targets: BackupTarget[] = [...hosts];

  for (const container of containers) {
    if (claimed.has(container.backupName)) {
      collisions.push(container.backupName);
      continue;
    }

    claimed.add(container.backupName);
    targets.push(container);
  }

  return { collisions, targets };
};
