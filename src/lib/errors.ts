// oxlint-disable max-classes-per-file

import { Data } from "effect";
import { z } from "zod";
import type { ZodError } from "zod";

export class ParsingError extends Data.TaggedError("PARSING_ERROR")<{
  cause: unknown;
  message: string;
}> {}

export class ShellCommandFailureError extends Data.TaggedError("SHELL_COMMAND_FAILURE_ERROR")<{
  cause: unknown;
  message: string;
}> {}

export class ContainerBackupInfosParsingError extends Data.TaggedError("CONTAINER_BACKUP_INFOS_PARSING_ERROR")<{
  message: string;
}> {}

export class UndefinedVariableError extends Data.TaggedError("UNDEFINED_VARIABLE_ERROR")<{ variable: string }> {
  override get message() {
    return `The env variable ${this.variable} is undefined`;
  }
}

export class InvalidConfigurationError extends Data.TaggedError("INVALID_CONFIGURATION_ERROR")<{
  zodError: ZodError;
}> {
  override get message() {
    return `Invalid dockup configuration :\n${z.prettifyError(this.zodError)}\n\n`;
  }
}

export class ConfigurationRetrievalError extends Data.TaggedError("CONFIGURATION_RETRIEVAL_ERROR")<{
  configPath: string;
  cause: "DECRYPTION_FAILED" | "FILE_NOT_FOUND";
}> {
  override get message() {
    if (this.cause === "FILE_NOT_FOUND")
      return `Cannot retrieve the dockup configuration file at ${this.configPath}. Please set it up via the command "dockup config set"`;

    return `Cannot decrypt the dockup configuration file stored at ${this.configPath}. Please re-generate one via the commande "dockup config set"`;
  }
}

export class FileSystemPermissionError extends Data.TaggedError("FILE_SYSTEM_PERMISSION_ERROR")<{
  path: string;
}> {
  override get message() {
    return `You don't have the write permission to create ${this.path}`;
  }
}

/**
 * Raised when the cross-run state (backup health streaks + undelivered Discord
 * messages) cannot be read or written. Never fatal: a run that cannot persist
 * its state still backs everything up, it only loses the failure-streak
 * alerting — so callers report it and carry on rather than aborting.
 */
export class StatePersistenceError extends Data.TaggedError("STATE_PERSISTENCE_ERROR")<{
  cause: unknown;
  message: string;
}> {}

/**
 * Raised when a Discord webhook delivery fails.
 *
 * `retryable` separates "Discord is down / rate-limiting us" — worth another
 * attempt, and worth keeping the message for the next run — from "Discord
 * refused this message" (a 4xx), which would be refused just as firmly forever.
 */
export class DiscordNotificationError extends Data.TaggedError("DISCORD_NOTIFICATION_ERROR")<{
  message: string;
  retryable: boolean;
  /** Delay Discord itself asked us to wait (429 `Retry-After`), in milliseconds. */
  retryAfterMs?: number;
}> {}

export class ResticRepoNotInitializedError extends Data.TaggedError("RESTIC_REPO_NOT_INITIALIZED_ERROR")<{
  cause: unknown;
  message: string;
}> {}

/**
 * Raised when a database dump piped into `restic backup --stdin` carried zero
 * byte. `pipefail` already catches a dump that *exits* non-zero; this covers the
 * one that exits 0 having written nothing. Either way an empty snapshot must
 * never be recorded as a successful backup — the loss would only surface at
 * restore time.
 */
export class EmptyBackupError extends Data.TaggedError("EMPTY_BACKUP_ERROR")<{
  backupName: string;
}> {
  override get message() {
    return `The dump for "${this.backupName}" produced 0 byte — refusing to record an empty snapshot as a successful backup.`;
  }
}

/**
 * Raised when the GitHub release API (or a release asset) cannot be reached, or
 * answers with something other than a 2xx.
 */
export class ReleaseFetchError extends Data.TaggedError("RELEASE_FETCH_ERROR")<{
  cause: unknown;
  message: string;
}> {}

/**
 * Raised when no release asset is published for the running platform.
 * `upgrade` refuses to guess rather than install a binary for another target.
 */
export class UnsupportedPlatformError extends Data.TaggedError("UNSUPPORTED_PLATFORM_ERROR")<{
  target: string;
}> {
  override get message() {
    return `No dockup release is published for ${this.target}. Build one from source with "bun run build".`;
  }
}

/**
 * Raised when the downloaded release cannot be trusted or installed: a missing
 * asset, a checksum that does not match, a binary that could not be moved into
 * place. Upgrade overwrites a binary that usually runs as root, so every one of
 * those aborts the install instead of degrading it.
 */
export class UpgradeError extends Data.TaggedError("UPGRADE_ERROR")<{
  cause?: unknown;
  message: string;
}> {}

export class PermissionError extends Data.TaggedError("PERMISSION_ERROR")<{
  cause: unknown;
  message: string;
}> {}

/**
 * Raised when the user aborts an interactive prompt (Ctrl-C / Esc).
 * Carried through the error channel instead of calling `process.exit`, so
 * finalizers still run and the command runner can render it as a soft cancel.
 */
export class PromptCancelledError extends Data.TaggedError("PROMPT_CANCELLED_ERROR")<{
  reason?: string;
}> {
  override get message() {
    return this.reason ?? "Operation cancelled by the user.";
  }
}

/**
 * Raised by `config init` when it runs without a terminal (or with
 * `--non-interactive`) and one or more required values were supplied by
 * neither a flag, an environment variable, nor the `--json` document.
 * Exists so an unattended install (Ansible, cloud-init, …) fails loudly with
 * the exact list of what is missing instead of blocking on a prompt.
 */
export class NonInteractiveConfigError extends Data.TaggedError("NON_INTERACTIVE_CONFIG_ERROR")<{
  missing: string[];
}> {
  override get message() {
    return `Cannot assemble the configuration without prompting — no value provided for:\n${this.missing
      .map((entry) => `  • ${entry}`)
      .join("\n")}`;
  }
}

/**
 * Raised by `restore` when the selected backup has no snapshot yet.
 * Rendered as a warning (not a red error) by the command runner.
 */
export class NoSnapshotsError extends Data.TaggedError("NO_SNAPSHOTS_ERROR")<{
  backupName: string;
}> {
  override get message() {
    return `No snapshot found for "${this.backupName}". Create one first with "dockup backup".`;
  }
}

/**
 * Raised at the end of `service remove` when the uninstall ran best-effort but
 * one or more steps failed. Every step is still attempted; this only reports
 * that the cleanup was partial.
 */
export class ServiceRemovalError extends Data.TaggedError("SERVICE_REMOVAL_ERROR")<{
  failed: number;
}> {
  override get message() {
    return `${this.failed} uninstall step(s) failed — see the log above. Re-run "dockup service remove", or finish by hand.`;
  }
}
