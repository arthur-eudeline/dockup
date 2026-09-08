import { intro, log, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { Effect } from "effect";

import { runStandalone } from "../lib/cli";
import { stepSpinner } from "../lib/prompts";
import {
  downloadRelease,
  fetchLatestRelease,
  installBinary,
  isNewerVersion,
  needsSudo,
  primeSudo,
} from "../lib/upgrade";
import { formatBytes, resolveBinaryPath } from "../lib/utils";
import { VERSION } from "../lib/version";

interface UpgradeOptions {
  check?: boolean;
  force?: boolean;
}

/**
 * Replaces the dockup binary with the latest release published on GitHub.
 *
 * Deliberately non-interactive — it is also the command a bored admin runs over
 * SSH — but abort-on-first-error: a half-downloaded or unverified binary must
 * never reach `/usr/local/bin`, so every step fails the whole command.
 */
export const UpgradeCommand = new Command()
  .name("upgrade")
  .alias("update")
  .description("Upgrade dockup to the latest release published on GitHub")
  .option("-c, --check", "Only report whether a newer version is available")
  .option("-f, --force", "Re-install the latest release even when it is already the running version")
  .action((options: UpgradeOptions) =>
    runStandalone(
      Effect.gen(function* _upgrade() {
        intro(`Upgrading dockup ${chalk.dim(`(current : v${VERSION})`)}`);

        const release = yield* stepSpinner(fetchLatestRelease(), {
          title: "looking up the latest release...",
          onSuccess: (latest) => chalk.green(`latest release : ${chalk.yellow(latest.tag)}`),
          onError: () => chalk.red("could not read the latest release from GitHub"),
        });

        const upToDate = !isNewerVersion(release.version, VERSION);

        if (options.check) {
          if (upToDate) log.success(`dockup is up to date (${chalk.yellow(`v${VERSION}`)}).`);
          else log.warn(`A newer version is available : ${chalk.yellow(release.tag)}\n${release.url}`);
          outro("Done.");
          return;
        }

        if (upToDate && !options.force) {
          log.success(`dockup is already up to date (${chalk.yellow(`v${VERSION}`)}).`);
          outro(`Run ${chalk.yellow("dockup upgrade --force")} to re-install ${release.tag} anyway.`);
          return;
        }

        const bytes = yield* stepSpinner(downloadRelease(release), {
          title: `downloading ${chalk.yellow(release.tag)}...`,
          onSuccess: (payload) => chalk.green(`downloaded and verified (${formatBytes(payload.byteLength)})`),
          onError: () => chalk.red(`failed to download ${release.tag}`),
        });

        const target = resolveBinaryPath();

        // Ask for the password before the spinner starts: sudo's prompt would be
        // swallowed by the install step, leaving the user in front of a spinner
        // that is in fact waiting for input.
        if (yield* needsSudo(target)) {
          log.info(`${chalk.yellow(target)} is not writable by you — sudo will ask for your password.`);
          yield* primeSudo();
        }

        yield* stepSpinner(installBinary(bytes, target), {
          title: `installing to ${chalk.yellow(target)}...`,
          onSuccess: () => chalk.green(`installed at ${chalk.yellow(target)}`),
          onError: () => chalk.red(`failed to install to ${chalk.yellow(target)}`),
        });

        outro(chalk.green(`dockup upgraded to ${release.tag}.`));
      })
    )
  );
