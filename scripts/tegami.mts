/**
 * Release pipeline: conventional commits → changelog → version bump → git tag.
 *
 * Tegami is script-driven rather than a CLI, so this file *is* the release
 * configuration. Three things happen here:
 *
 * 1. `generateChangelog` parses the conventional commits since the latest tag and
 *    tells us the bump each one implies (feat → minor, fix/perf/revert → patch,
 *    `!` or a `BREAKING CHANGE:` footer → major; anything else is not releasable).
 * 2. Those commits are rewritten into a single pending changelog file targeting
 *    `dockup`. Tegami reads a commit's *scope* as the name of the package it
 *    touches, which is a monorepo assumption: here scopes name modules
 *    (`fix(restic,report): …`), so left alone every commit would resolve to a
 *    package that does not exist and bump nothing. Rewriting them keeps the scopes
 *    where they belong — in the changelog text — and lets a single-package
 *    workspace bump normally.
 * 3. Tegami applies the draft (package.json + CHANGELOG.md), then this script
 *    commits and tags it. Pushing the tag is left to you: `git push --follow-tags`
 *    is what triggers .github/workflows/release.yml, which builds the binaries and
 *    publishes the GitHub release.
 *
 * Usage: `bun run release [--dry-run] [--yes]`
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import { tegami } from "tegami";
import type { BumpType, CommitChangelog } from "tegami";

/** One releasable commit, as parsed by Tegami. */
type CommitChange = CommitChangelog["changes"][number];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The only package of this workspace — every releasable commit bumps it. */
const PACKAGE_NAME = "dockup";

/**
 * Pending changelog written before versioning. The name is fixed on purpose: a
 * second run overwrites it instead of stacking a duplicate entry, and Tegami
 * deletes it once the draft is applied.
 */
const PENDING_CHANGELOG = join(ROOT, ".tegami", "conventional-commits.md");

/**
 * `stdio: pipe` on stderr too: `git describe` on a repository without a tag is an
 * expected outcome here, and its `fatal:` line has no business in the output. A
 * failure that is *not* expected re-throws with that stderr attached.
 */
const git = (...args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
};

// -----------------------------------------------------------------------------
// Rendering the pending changelog
// -----------------------------------------------------------------------------

/** Same header shape Tegami parses, re-read here only to label the section. */
const CONVENTIONAL_HEADER = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: /;

const SECTIONS = [
  { id: "breaking", title: "⚠ Breaking changes" },
  { id: "feat", title: "Features" },
  { id: "fix", title: "Bug fixes" },
  { id: "perf", title: "Performance" },
  { id: "revert", title: "Reverts" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const sectionOf = (change: CommitChange): SectionId => {
  // A breaking change is a breaking change whatever its type says.
  if (change.type === "major") return "breaking";

  const type = CONVENTIONAL_HEADER.exec(change.subject)?.groups?.type?.toLowerCase();
  const section = SECTIONS.find((candidate) => candidate.id === type);
  return section ? section.id : "fix";
};

const BUMP_WEIGHT: Record<BumpType, number> = { patch: 0, minor: 1, major: 2 };

const highestBump = (changes: CommitChange[]): BumpType => {
  let highest: BumpType = "patch";
  for (const change of changes) {
    if (BUMP_WEIGHT[change.type] > BUMP_WEIGHT[highest]) highest = change.type;
  }
  return highest;
};

const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:[ \t]*(?<detail>[\s\S]+)$/m;

/**
 * `- **restic:** repair the thing (a1b2c3d)` — the scopes Tegami could not map to
 * a package are exactly the module names worth showing.
 *
 * A breaking change also carries its `BREAKING CHANGE:` footer: what exactly
 * broke is the one thing a reader of that section needs.
 */
const renderChange = (change: CommitChange): string => {
  const scopes = change.packages.filter((scope) => scope !== PACKAGE_NAME);
  const prefix = scopes.length > 0 ? `**${scopes.join(", ")}:** ` : "";
  const line = `- ${prefix}${change.title} (${change.hash.slice(0, 7)})`;

  const detail = change.type === "major" ? BREAKING_FOOTER.exec(change.body)?.groups?.detail?.trim() : undefined;
  return detail ? `${line}\n\n  ${detail.replaceAll("\n", "\n  ")}` : line;
};

const renderChangelog = (changes: CommitChange[]): string => {
  const body = SECTIONS.flatMap(({ id, title }) => {
    const entries = changes.filter((change) => sectionOf(change) === id);
    return entries.length > 0 ? [`### ${title}\n\n${entries.map(renderChange).join("\n")}`] : [];
  }).join("\n\n");

  return `---\npackages:\n  ${PACKAGE_NAME}: ${highestBump(changes)}\n---\n\n${body}\n`;
};

// -----------------------------------------------------------------------------
// Release
// -----------------------------------------------------------------------------

const readVersion = async (): Promise<string> =>
  (JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

/** Preview of the version Tegami will write, which bumps through `semver.inc`. */
const bumpedVersion = (version: string, type: BumpType): string => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const dryRun = process.argv.includes("--dry-run");
const assumeYes = process.argv.includes("--yes") || process.argv.includes("-y");

const latestTag = (): string | null => {
  try {
    return git("describe", "--tags", "--abbrev=0");
  } catch {
    return null;
  }
};

/** Never `process.exit()` in here: it would skip the pending-changelog cleanup. */
const release = async (): Promise<number> => {
  intro("Releasing dockup");

  // A dirty tree would be swept into the release commit.
  if (!dryRun && git("status", "--porcelain") !== "") {
    log.error("Working tree is not clean — commit or stash your changes first.");
    return 1;
  }

  const paper = tegami({ cwd: ROOT });
  const from = latestTag();

  // `write: false`: the entries Tegami generates target the commit scopes; they
  // are rewritten against the package below.
  const generated = await paper.generateChangelog({ write: false });
  const changes = generated.flatMap((entry) => entry.changes);

  if (changes.length === 0) {
    log.warn(`No releasable commit since ${from ?? "the start of the history"}.`);
    outro("Nothing to release.");
    return 0;
  }

  log.info(
    `${changes.length} releasable commit(s) since ${from ?? "the start of the history"}:\n${changes
      .map((change) => `  ${change.type.padEnd(5)} ${change.subject}`)
      .join("\n")}`
  );

  await mkdir(dirname(PENDING_CHANGELOG), { recursive: true });
  await writeFile(PENDING_CHANGELOG, renderChangelog(changes));

  const draft = await paper.draft();
  const bump = draft.getPackageDrafts().values().next().value?.type;

  if (!bump) {
    log.error("Tegami produced no version bump for dockup — is the changelog frontmatter still valid?");
    return 1;
  }

  const current = await readVersion();
  log.step(`${PACKAGE_NAME}: ${current} → ${bumpedVersion(current, bump)} (${bump})`);

  if (dryRun) {
    outro("Dry run — nothing was written.");
    return 0;
  }

  if (!assumeYes) {
    const confirmed = await confirm({ message: `Release v${bumpedVersion(current, bump)}?` });
    if (isCancel(confirmed) || !confirmed) {
      outro("Cancelled.");
      return 0;
    }
  }

  await draft.apply();

  // The publish lock drives Tegami's publishing phase, which dockup does not use
  // (it ships GitHub release binaries, not an npm package): don't commit it.
  await rm(join(ROOT, ".tegami", "publish-lock.yaml"), { force: true });

  const version = await readVersion();
  git("add", "-A");
  git("commit", "-m", `chore(release): v${version}`);
  git("tag", `v${version}`);

  outro(`Released v${version} locally — push it with: git push --follow-tags`);
  return 0;
};

try {
  process.exitCode = await release();
} finally {
  // Applying the draft consumes the file; every other path has to clean up after
  // itself, since a leftover would be picked up by the next run.
  await rm(PENDING_CHANGELOG, { force: true });

  // `.tegami/` only exists for that file here — but never take it down on someone
  // who put something else in it.
  const changelogDir = dirname(PENDING_CHANGELOG);
  if (existsSync(changelogDir)) {
    const remaining = await readdir(changelogDir);
    if (remaining.length === 0) await rmdir(changelogDir);
  }
}
