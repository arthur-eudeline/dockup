import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect } from "effect";
import { z } from "zod";

import { ParsingError, ReleaseFetchError, UnsupportedPlatformError, UpgradeError } from "./errors";
import type { ShellCommandFailureError } from "./errors";
import {
  ensureWritePermission,
  getShellOutput,
  primeSudo as primeSudoOnTerminal,
  raw,
  resolveBinaryPath,
  sh,
} from "./utils";
import { VERSION } from "./version";

export const GITHUB_REPO = "arthur-eudeline/dockup";
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Checksum file published next to the binaries by `.github/workflows/release.yml`. */
const CHECKSUMS_ASSET = "SHA256SUMS.txt";

/** Targets the release workflow compiles, as `${process.platform}-${process.arch}`. */
const SUPPORTED_TARGETS = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);

const RELEASE_SCHEMA = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

export interface Release {
  /** Tag as published, e.g. `v0.2.0`. */
  tag: string;
  /** Tag without its leading `v`, comparable to {@link VERSION}. */
  version: string;
  /** Human-facing release page. */
  url: string;
  assets: { name: string; browser_download_url: string }[];
}

/** GitHub rejects an API call without a User-Agent, so every request carries one. */
const headers = (accept: string): Record<string, string> => ({
  Accept: accept,
  "User-Agent": `dockup/${VERSION}`,
});

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A `fetch` that resolves is not a success: GitHub answers 404 for a repository
 * without releases and 403 when the anonymous rate limit is spent, and both must
 * fail rather than be parsed as a release.
 */
const request = (url: string, accept: string): Effect.Effect<Response, ReleaseFetchError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { headers: headers(accept), redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    },
    catch: (e) => new ReleaseFetchError({ cause: e, message: `Failed to fetch ${url} : ${describe(e)}` }),
  });

const fetchText = (url: string, accept: string): Effect.Effect<string, ReleaseFetchError> =>
  request(url, accept).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new ReleaseFetchError({ cause: e, message: `Failed to read ${url} : ${describe(e)}` }),
      })
    )
  );

const fetchBytes = (url: string): Effect.Effect<Uint8Array, ReleaseFetchError> =>
  request(url, "application/octet-stream").pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await response.arrayBuffer()),
        catch: (e) => new ReleaseFetchError({ cause: e, message: `Failed to download ${url} : ${describe(e)}` }),
      })
    )
  );

/** Reads the latest published release off the GitHub API. */
export const fetchLatestRelease = (): Effect.Effect<Release, ReleaseFetchError | ParsingError> =>
  Effect.gen(function* _fetchLatestRelease() {
    const body = yield* fetchText(LATEST_RELEASE_API, "application/vnd.github+json");

    const payload = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new ParsingError({ cause: e, message: "GitHub returned an unreadable release payload." }),
    });

    const parsed = RELEASE_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return yield* Effect.fail(
        new ParsingError({
          cause: parsed.error,
          message: `Unexpected GitHub release payload :\n${z.prettifyError(parsed.error)}`,
        })
      );
    }

    return {
      tag: parsed.data.tag_name,
      version: parsed.data.tag_name.replace(/^v/, ""),
      url: parsed.data.html_url,
      assets: parsed.data.assets,
    };
  });

const SEGMENTS = 3;

/** `1.2.3`, `v1.2.3` and `1.2.3-rc.1` all read as `[1, 2, 3]`; anything else as `0`. */
const toSegments = (version: string): number[] => {
  const core = version.replace(/^v/, "").split("-")[0] ?? "";
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return Array.from({ length: SEGMENTS }, (_, index) => {
    const value = parts[index];
    return value === undefined || Number.isNaN(value) ? 0 : value;
  });
};

/** `true` when `candidate` is a strictly higher version than `current`. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const left = toSegments(candidate);
  const right = toSegments(current);

  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    if (value !== other) return value > other;
  }

  return false;
};

/** Name of the release asset matching the host, as published by the CI workflow. */
export const currentTargetAsset = (): Effect.Effect<string, UnsupportedPlatformError> => {
  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.has(target)) return Effect.fail(new UnsupportedPlatformError({ target }));
  return Effect.succeed(`dockup-${target}`);
};

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Digest published for `assetName` in the release's `SHA256SUMS.txt`.
 *
 * A release that ships no checksum file is refused rather than trusted: the
 * downloaded file replaces a binary that runs nightly as a privileged user.
 */
const expectedDigest = (release: Release, assetName: string): Effect.Effect<string, ReleaseFetchError | UpgradeError> =>
  Effect.gen(function* _expectedDigest() {
    const checksums = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET);
    if (!checksums) {
      return yield* Effect.fail(
        new UpgradeError({
          message: `Release ${release.tag} publishes no ${CHECKSUMS_ASSET} — refusing to install an unverified binary.`,
        })
      );
    }

    const body = yield* fetchText(checksums.browser_download_url, "text/plain");

    // `sha256sum` format: "<digest>␣␣<file name>".
    const line = body
      .split("\n")
      .map((entry) => entry.trim().split(/\s+/))
      .find(([, name]) => name === assetName);

    const digest = line?.[0];
    if (!digest) {
      return yield* Effect.fail(
        new UpgradeError({ message: `${CHECKSUMS_ASSET} of release ${release.tag} lists no digest for ${assetName}.` })
      );
    }

    return digest;
  });

/**
 * Downloads the asset built for this host and checks it against the release
 * checksums. Fails unless the bytes are exactly the ones CI published.
 */
export const downloadRelease = (
  release: Release
): Effect.Effect<Uint8Array, ReleaseFetchError | UnsupportedPlatformError | UpgradeError> =>
  Effect.gen(function* _downloadRelease() {
    const assetName = yield* currentTargetAsset();

    const asset = release.assets.find((candidate) => candidate.name === assetName);
    if (!asset) {
      return yield* Effect.fail(
        new UpgradeError({ message: `Release ${release.tag} publishes no ${assetName} asset.` })
      );
    }

    const digest = yield* expectedDigest(release, assetName);
    const bytes = yield* fetchBytes(asset.browser_download_url);

    const actual = sha256(bytes);
    if (actual !== digest) {
      return yield* Effect.fail(
        new UpgradeError({
          message: `Checksum mismatch on ${assetName} — expected ${digest}, got ${actual}. Refusing to install it.`,
        })
      );
    }

    return bytes;
  });

/** `true` unless the directory holding `target` is writable by the current user. */
export const needsSudo = (target: string): Effect.Effect<boolean> =>
  ensureWritePermission(target).pipe(
    Effect.as(false),
    Effect.catchAll(() => Effect.succeed(true))
  );

/** Asks sudo for its password before the install starts — see {@link primeSudoOnTerminal}. */
export const primeSudo = (): Effect.Effect<void, UpgradeError> =>
  primeSudoOnTerminal().pipe(
    Effect.mapError((cause) => new UpgradeError({ cause, message: `sudo authentication failed : ${describe(cause)}` }))
  );

/**
 * Writes the downloaded binary over the running one.
 *
 * The new binary is staged *inside the install directory* and moved into place,
 * because a same-directory `mv` is a `rename(2)`: atomic, and allowed while the
 * file it replaces is the executable currently running — writing to that file
 * directly fails with `ETXTBSY` instead.
 *
 * @param target The binary to replace, defaulting to the running one
 * @returns The path that was replaced
 */
export const installBinary = (
  bytes: Uint8Array,
  target: string = resolveBinaryPath()
): Effect.Effect<string, UpgradeError | ShellCommandFailureError> =>
  Effect.gen(function* _installBinary() {
    const download = join(tmpdir(), `dockup-upgrade-${process.pid}`);
    const staged = join(dirname(target), `.dockup-upgrade-${process.pid}`);

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(download, bytes);
        await chmod(download, 0o755);
      },
      catch: (e) => new UpgradeError({ cause: e, message: `Failed to write the downloaded binary to ${download}.` }),
    });

    const sudo = (yield* needsSudo(target)) ? "sudo " : "";

    yield* getShellOutput(
      sh`${raw(sudo)}cp ${download} ${staged} && ${raw(sudo)}chmod 755 ${staged} && ${raw(sudo)}mv ${staged} ${target}`
    ).pipe(
      // Neither temporary file may outlive the command, including when the move
      // failed halfway or the user hit Ctrl-C mid-install.
      Effect.ensuring(
        Effect.all([
          getShellOutput(sh`rm -f ${download}`).pipe(Effect.ignore),
          getShellOutput(sh`${raw(sudo)}rm -f ${staged}`).pipe(Effect.ignore),
        ])
      )
    );

    return target;
  });
