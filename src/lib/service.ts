import { basename } from "node:path";

import { $ } from "bun";
import { Effect } from "effect";

import { DOCKUP_SHELL_USER } from "./config";
import { ShellCommandFailureError } from "./errors";
import { getShellOutput, sh } from "./utils";

export const SERVICE_NAME = "dockup-auto-backup";
export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
export const TIMER_PATH = `/etc/systemd/system/${SERVICE_NAME}.timer`;

/** Where `upload.sh` installs the compiled binary. */
const DEFAULT_INSTALL_PATH = "/usr/local/bin/dockup";

/**
 * Absolute path to the dockup binary for `ExecStart` — systemd refuses a unit
 * whose executable path is relative (`Executable path is not absolute`).
 *
 * A compiled standalone binary reports itself in `process.execPath`; running from
 * source (`bun src/main.ts`) reports the bun binary instead, in which case the
 * unit points at the install path the deploy script uses.
 */
const resolveExecStart = (): string =>
  basename(process.execPath) === "dockup" ? process.execPath : DEFAULT_INSTALL_PATH;

/**
 * Writes a file under `/etc/systemd/system`, which needs root.
 *
 * `Bun.file().write()` cannot do that as a normal user, and every other step of
 * `service init` already goes through `sudo` — so pipe the content into `sudo tee`
 * rather than making the whole command require being run as root.
 */
const writeSystemFile = (path: string, content: string): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.tryPromise({
    try: () => $`sudo tee ${path} < ${Buffer.from(content)}`.quiet(),
    catch: (e) =>
      new ShellCommandFailureError({
        cause: e,
        message: `Failed to create ${path} file.`,
      }),
  });

export const writeServiceFile = () =>
  writeSystemFile(
    SERVICE_PATH,
    `[Unit]
Description=Dockup Backup Service
After=network.target docker.service

[Service]
Type=oneshot
ExecStart=${resolveExecStart()} backup
User=${DOCKUP_SHELL_USER}
Group=${DOCKUP_SHELL_USER}
`
  );

export const writeTimerFile = () =>
  writeSystemFile(
    TIMER_PATH,
    `[Unit]
Description=Run dockup backup daily at 02:00 AM

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
`
  );

export const registerService = () =>
  Effect.tryPromise({
    try: async () => {
      await $`sudo systemctl daemon-reload`.quiet();
      await $`sudo systemctl enable ${SERVICE_NAME}.timer`.quiet();
      await $`sudo systemctl start ${SERVICE_NAME}.timer`.quiet();
    },
    catch: (e) =>
      new ShellCommandFailureError({
        message: `Failed to register service`,
        cause: e,
      }),
  });

export const checkServiceStatus = () => getShellOutput(sh`systemctl list-timers ${`${SERVICE_NAME}.timer`}`);

export const readServiceLogs = () => getShellOutput(sh`journalctl -u ${SERVICE_NAME} -n 20 --no-pager`);
