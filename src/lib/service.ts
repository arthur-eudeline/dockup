import { file, $ } from "bun";
import { Effect } from "effect";

import { DOCKUP_SHELL_USER } from "./config";
import { ShellCommandFailureError } from "./errors";
import { getShellOutput } from "./utils";

export const SERVICE_NAME = "dockup-auto-backup";
export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
export const TIMER_PATH = `/etc/systemd/system/${SERVICE_NAME}.timer`;

export const writeServiceFile = () =>
  Effect.gen(function* _writeServiceFile() {
    yield* Effect.tryPromise({
      try: async () => {
        await file(SERVICE_PATH).write(`[Unit]
Description=Dockup Backup Service
After=network.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/dockup/dockup backup
WorkingDirectory=/opt/dockup
User=${DOCKUP_SHELL_USER}
Group=${DOCKUP_SHELL_USER}
`);
      },
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `Failed to create ${SERVICE_PATH} file.`,
        }),
    });
  });

export const writeTimerFile = () =>
  Effect.gen(function* _writeTimerFile() {
    yield* Effect.tryPromise({
      try: async () => {
        await file(TIMER_PATH).write(`[Unit]
Description=Run dockup backup daily at 02:00 AM

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
`);
      },
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `Failed to create ${TIMER_PATH} file.`,
        }),
    });
  });

export const registerService = () =>
  Effect.tryPromise({
    try: async () => {
      await $`systemctl daemon-reload`.quiet();
      await $`systemctl enable ${SERVICE_NAME}.timer`.quiet();
    },
    catch: (e) =>
      new ShellCommandFailureError({
        message: `Failed to register service`,
        cause: e,
      }),
  });

export const checkServiceStatus = () => getShellOutput(`systemctl list-timers ${SERVICE_NAME}.timer`);

export const readServiceLogs = () => getShellOutput(`jounalctl -u ${SERVICE_NAME} -n 20 --no-pager`);
