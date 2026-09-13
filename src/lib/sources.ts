/**
 * The tags dockup writes on a snapshot, and what a restore reads back out of them.
 *
 * `restore` picks its destination first and then the data to pour into it, so
 * the two sides have to be matched — and a restic snapshot has nowhere to say
 * what dockup made it from. So `backup` says it, in a second tag:
 * `dockup.type=postgres`. The alternative was an index file next to the
 * repository listing every backup and its type; a tag is better because it
 * cannot drift — it is written in the same call as the snapshot it describes,
 * it is pruned with it, and a repository written to by two hosts has no shared
 * file for them to overwrite each other in.
 *
 * Older snapshots carry no such tag. Their type is then taken from a target
 * still declaring that name, and failing that from what the snapshot looks like:
 * one `/<name>.sql` path is a dump, anything else a file tree. That last step
 * cannot tell `postgres` from `mariadb` — both are one `.sql` file — which is
 * exactly the gap the tag closes going forward.
 *
 * Pure, like `targets.ts`: no I/O, no docker, no restic.
 */

import type { ResticSnapshotItemStructredOutput } from "./restic";
import type { BackupTarget, BackupType } from "./targets";
import { BACKUP_TYPES } from "./targets";

/** A dump is a single `/<backup name>.sql` file; anything else is a file tree. */
const DUMP_PATH = /^\/.+\.sql$/;

/** Namespace of every tag dockup writes for itself rather than for the user. */
const META_TAG = "dockup.";
const TYPE_TAG = `${META_TAG}type=`;

/**
 * The tag declaring what a snapshot was taken from.
 *
 * Written by every `backup`, read by every `restore`. Beware when touching this:
 * the retention policy groups by `--host` precisely so that adding a tag cannot
 * split one backup into two groups (see `resticCleanUp`).
 */
export const typeTag = (type: BackupType): string => `${TYPE_TAG}${type}`;

const isBackupType = (value: string): value is BackupType => (BACKUP_TYPES as readonly string[]).includes(value);

/** The backup name a snapshot was taken under — the one tag that is not dockup's own. */
export const snapshotBackupName = (tags: string[]): string | null =>
  tags.find((tag) => !tag.startsWith(META_TAG)) ?? null;

/** The type a snapshot declares about itself, when it is recent enough to say. */
export const snapshotDeclaredType = (tags: string[]): BackupType | null => {
  const declared = tags.find((tag) => tag.startsWith(TYPE_TAG))?.slice(TYPE_TAG.length);

  return declared !== undefined && isBackupType(declared) ? declared : null;
};

/**
 * What a snapshot looks like from the outside — as far as its paths can tell.
 */
export type BackupKind = "database" | "volumes";

/** Where a source's type came from, so the prompt can say how sure it is. */
export type TypeOrigin = "snapshot" | "target" | "unknown";

/** Every snapshot taken under one backup name, and what can be done with them. */
export interface BackupSource {
  backupName: string;
  /** Newest first. */
  snapshots: ResticSnapshotItemStructredOutput[];
  /** What it was backed up from, `null` when nothing says any more. */
  type: BackupType | null;
  origin: TypeOrigin;
  kind: BackupKind;
  /** What the most recent snapshot holds — the paths a volume restore could write. */
  paths: string[];
}

const kindOf = (paths: string[], type: BackupType | null): BackupKind => {
  if (type !== null) return type === "volumes" ? "volumes" : "database";

  return paths.length === 1 && DUMP_PATH.test(paths[0] ?? "") ? "database" : "volumes";
};

/** Whether the type came from the snapshot's own tag, from a live target, or nowhere. */
const originOf = (declared: BackupType | null, type: BackupType | null): TypeOrigin => {
  if (declared !== null) return "snapshot";

  return type === null ? "unknown" : "target";
};

/**
 * Groups a repository's snapshots by the backup name they were taken under.
 *
 * Untagged snapshots are dropped: dockup always tags what it writes, so anything
 * without one was put in the repository by something else and is not ours to
 * restore.
 *
 * @param snapshots The whole listing, newest first
 * @param targets The targets discovered on this host — the fallback for a snapshot
 *   taken before dockup tagged its type
 */
export const groupSnapshotsIntoSources = (
  snapshots: ResticSnapshotItemStructredOutput[],
  targets: BackupTarget[]
): BackupSource[] => {
  const types = new Map(targets.map((target) => [target.backupName, target.type]));
  const sources = new Map<string, BackupSource>();

  for (const snapshot of snapshots) {
    const backupName = snapshotBackupName(snapshot.tags);
    if (backupName === null) continue;

    const known = sources.get(backupName);
    if (known) {
      known.snapshots.push(snapshot);
      continue;
    }

    // The listing is sorted newest first, so the snapshot opening a group is the
    // most recent one: what the backup looks like *now*, and the one whose tag
    // is trusted for the whole group.
    const declared = snapshotDeclaredType(snapshot.tags);
    const type = declared ?? types.get(backupName) ?? null;
    const origin = originOf(declared, type);

    sources.set(backupName, {
      backupName,
      kind: kindOf(snapshot.paths, type),
      origin,
      paths: snapshot.paths,
      snapshots: [snapshot],
      type,
    });
  }

  return [...sources.values()];
};

/**
 * Whether a source's data can be poured into a destination.
 *
 * A database destination takes any dump of its own type. A dump nothing can put
 * a type on — no tag, no target left — is offered rather than hidden: a backup
 * outliving the container it came from is precisely when a restore is needed,
 * and the caller is expected to say so (see `describeSource`).
 *
 * A volumes destination is stricter, because a volume restore writes a snapshot
 * back to the *absolute paths* it was taken from: unless the snapshot holds one
 * of the destination's own mount points, restoring it would write nothing at all.
 *
 * @param destinationPaths The destination container's mount points — volumes only
 */
export const isCompatibleSource = (
  destination: BackupTarget,
  source: BackupSource,
  destinationPaths: string[]
): boolean => {
  if (destination.type === "volumes") {
    return source.kind === "volumes" && source.paths.some((path) => destinationPaths.includes(path));
  }

  return source.kind === "database" && (source.type === null || source.type === destination.type);
};

/** The sources that can be restored into `destination`, most recently backed up first. */
export const compatibleSources = (
  destination: BackupTarget,
  sources: BackupSource[],
  destinationPaths: string[] = []
): BackupSource[] =>
  sources
    .filter((source) => isCompatibleSource(destination, source, destinationPaths))
    .toSorted((a, b) => (b.snapshots[0]?.date.getTime() ?? 0) - (a.snapshots[0]?.date.getTime() ?? 0));

/** How a source is described in the prompt : what it is, and how sure dockup is of it. */
export const describeSource = (source: BackupSource, destination: BackupTarget): string => {
  const count = `${source.snapshots.length} snapshot${source.snapshots.length > 1 ? "s" : ""}`;
  const latest = source.snapshots[0]?.relativeDate ?? "";
  const own = source.backupName === destination.backupName ? " · its own backup" : "";

  switch (source.origin) {
    case "snapshot": {
      return `${count} · ${latest} · ${source.type}${own}`;
    }
    case "target": {
      // Not the snapshot's word : the type of whatever declares that name today.
      return `${count} · ${latest} · ${source.type} (untagged, assumed from the current target)${own}`;
    }
    default: {
      return `${count} · ${latest} · type unknown — untagged, and no target declares this name any more`;
    }
  }
};

/**
 * The file a database restore reads back out of the snapshot.
 *
 * Taken from the snapshot itself rather than rebuilt from the destination's
 * name: the dump is called after the backup it came *from*, and those are no
 * longer the same thing.
 */
export const dumpPath = (snapshot: ResticSnapshotItemStructredOutput, source: BackupSource): string =>
  snapshot.paths[0] ?? `/${source.backupName}.sql`;
