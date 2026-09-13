import { Effect } from "effect";

import { DOCKUP_SHELL_USER } from "./config";
import { ShellCommandFailureError } from "./errors";
import { getShellOutput, resolveBinaryPath, sh } from "./utils";

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
  getShellOutput(sh`sudo tee ${path}`, { stdin: content }).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new ShellCommandFailureError({
          cause,
          message: `Failed to create ${path} file.\n${cause.message}`,
        })
    )
  );

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

export const registerService = (): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.gen(function* _registerService() {
    // Sequential and abort-on-first : enabling a timer systemd has not reloaded
    // yet, or starting one it refused to enable, only compounds the failure.
    yield* getShellOutput("sudo systemctl daemon-reload");
    yield* getShellOutput(`sudo systemctl enable ${SERVICE_NAME}.timer`);
    yield* getShellOutput(`sudo systemctl start ${SERVICE_NAME}.timer`);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ShellCommandFailureError({
          cause,
          message: `Failed to register service\n${cause.message}`,
        })
    )
  );
