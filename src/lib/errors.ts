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
    return `You don't have the write permission to create the config file at ${this.path}`;
  }
}

export class ResticRepoNotInitializedError extends Data.TaggedError("RESTIC_REPO_NOT_INITIALIZED_ERROR")<{
  cause: unknown;
  message: string;
}> {}

export class PermissionError extends Data.TaggedError("PERMISSION_ERROR")<{
  cause: unknown;
  message: string;
}> {}
