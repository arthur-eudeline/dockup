import packageJson from "../../package.json";

/**
 * Single source of truth for the version dockup reports.
 *
 * Read from `package.json` — the bundler inlines it, so the compiled binary
 * carries the value it was built from and the release workflow only has to check
 * that the tag agrees with the manifest.
 */
export const VERSION: string = packageJson.version;
