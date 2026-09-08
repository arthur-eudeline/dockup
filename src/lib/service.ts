import { $ } from "bun";
import { Effect } from "effect";

import { DOCKUP_SHELL_USER } from "./config";
import { ShellCommandFailureError } from "./errors";
import { resolveBinaryPath } from "./utils";

export const SERVICE_NAME = "dockup-auto-backup";
export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
export const TIMER_PATH = `/etc/systemd/system/${SERVICE_NAME}.timer`;

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

/**
 * `ExecStart` must be an absolute path — systemd refuses the unit otherwise
 * (`Executable path is not absolute`) — hence `resolveBinaryPath()`.
 */
export const writeServiceFile = () =>
  writeSystemFile(
    SERVICE_PATH,
    `[Unit]
Description=Dockup Backup Service
After=network.target docker.service

[Service]
Type=oneshot
ExecStart=${resolveBinaryPath()} backup
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
