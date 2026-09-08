import { $ } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import type { ShellCommandFailureError, ContainerBackupInfosParsingError } from "./errors";
import { ParsingError, PermissionError, UndefinedVariableError } from "./errors";
import type { ResticConf } from "./restic";
import { getShellOutput } from "./utils";

/**
 * Labels used by dockup to find out what containers to backup and how
 */
const LABELS = {
  BACKUP_ENABLED: "dockup.backup.enabled",
  BACKUP_NAME: "dockup.backup.name",
  BACKUP_TYPE: "dockup.backup.type",
};

/**
 * List the docker containers that carries the LABELS.BACKUP_ENABLED
 *
 * @returns Docker containers IDs list
 */
export const listBackupEnabledContainerIds = (): Effect.Effect<string[], ParsingError | ShellCommandFailureError> =>
  Effect.gen(function* _listBackupEnabledContainerIds() {
    const result = yield* getShellOutput(
      `docker ps --filter "label=${LABELS.BACKUP_ENABLED}=true" --format {{.ID}}`
    ).pipe(Effect.map((r) => r.split("\n").filter((line) => line.length > 0)));

    const { data, error } = z.string().array().safeParse(result);

    if (error)
      return yield* Effect.fail(
        new ParsingError({
          cause: error,
          message: `Failed to parse docker containers IDs :\n${z.prettifyError(error)}\n`,
        })
      );

    return yield* Effect.succeed(data);
  });

const BASE_SCHEMA = z.object({
  backupName: z.string(),
  id: z.string(),
});

/**
 * Validation schema of the information carried by the docker labels
 */
const CONTAINER_BACKUP_CONFIG_SCHEMA = z.discriminatedUnion("type", [
  BASE_SCHEMA.extend({ type: z.literal("mariadb") }),
  BASE_SCHEMA.extend({ type: z.literal("postgres") }),
  BASE_SCHEMA.extend({
    type: z.literal("volumes"),
  }),
]);

/**
 * Backup configuration
 */
export type ContainerBackupConfig = z.infer<typeof CONTAINER_BACKUP_CONFIG_SCHEMA>;

/**
 * Get a container backup configuration from its ID
 *
 * @param containerId The docker container ID
 * @returns The container backup configuration
 */
const getContainerBackupConfig = (
  containerId: string
): Effect.Effect<ContainerBackupConfig, ShellCommandFailureError | ParsingError, never> =>
  Effect.gen(function* _getContainerBackupInfos() {
    // Gets the backupName and type
    const output = yield* getShellOutput(`docker inspect --format '{{ json .Config.Labels }}' ${containerId}`);
    const json = yield* Effect.try({
      try: () => JSON.parse(output),
      catch: () =>
        new ParsingError({
          cause: "INVALID_JSON",
          message: "Failed to parse the docker labels JSON output",
        }),
    });

    // Validate the retrieved infos
    const { data, error } = CONTAINER_BACKUP_CONFIG_SCHEMA.safeParse({
      id: containerId,
      backupName: json["dockup.backup.name"],
      type: json["dockup.backup.type"],
    });

    if (error)
      return yield* Effect.fail(
        new ParsingError({
          cause: error,
          message: `The dockup container labels are invalid for the container #\`${containerId}\` :\n${z.prettifyError(error)}`,
        })
      );

    return yield* Effect.succeed(data);
  });

/**
 * List the docker containers backup configuration
 *
 * @returns The backup configuration list
 */
export const listBackupEnabledContainers = (): Effect.Effect<
  ContainerBackupConfig[],
  ShellCommandFailureError | ContainerBackupInfosParsingError | ParsingError,
  never
> =>
  Effect.gen(function* _listBackupEnabledContainers() {
    const containerIds = yield* listBackupEnabledContainerIds();

    const containersInfos = yield* Effect.all(
      containerIds.map((id) => getContainerBackupConfig(id)),
      { concurrency: "unbounded" }
    );

    return yield* Effect.succeed(containersInfos);
  });

export const ensureDockerPermissions = () =>
  Effect.tryPromise({
    try: () => $`docker ps`.quiet(),
    catch: (e) =>
      new PermissionError({
        cause: e,
        message: "You don't have the permission to use the docker commands",
      }),
  });

const VOLUME_SCHEMA = z.discriminatedUnion("Type", [
  z.object({
    Type: z.literal("bind"),
    Source: z.string(),
    Destination: z.string(),
    RW: z.boolean(),
  }),
  z.object({
    Type: z.literal("volume"),
    Name: z.string(),
    Source: z.string(),
    Destination: z.string(),
    RW: z.boolean(),
  }),
]);

export type VolumeData = z.infer<typeof VOLUME_SCHEMA>;

export const getContainerVolumes = (
  containerId: string
): Effect.Effect<VolumeData[], ShellCommandFailureError | ParsingError, never> =>
  Effect.gen(function* _getContainerVolumes() {
    const output = yield* getShellOutput(`docker inspect --format='{{json .Mounts}}' ${containerId}`);

    const json = yield* Effect.try({
      try: () => JSON.parse(output),
      catch: (e) =>
        new ParsingError({
          cause: e,
          message: "The docker inspect command did not returned a valid JSON",
        }),
    });

    const { data, error } = z.array(VOLUME_SCHEMA).safeParse(json);
    if (error) {
      return yield* Effect.fail(
        new ParsingError({
          cause: error,
          message: `The docker volume data are invalid :\n${z.prettifyError(error)}`,
        })
      );
    }

    return data;
  });

export const formatVolumeToArgs = (volumes: VolumeData[]): Effect.Effect<string> =>
  Effect.succeed(
    volumes
      .map((v) => {
        if (v.Type === "volume") {
          return `-v ${v.Name}:${v.Destination}:rw`;
        }

        return `-v ${v.Source}:${v.Destination}:rw`;
      })
      .join(" ")
  );

export const formatResticConfigToEnvArgs = (conf: ResticConf): Effect.Effect<string> =>
  Effect.succeed(
    [
      `-e AWS_ACCESS_KEY_ID=${conf.AWS_ACCESS_KEY_ID}`,
      `-e AWS_SECRET_ACCESS_KEY=${conf.AWS_SECRET_ACCESS_KEY}`,
      `-e RESTIC_PASSWORD=${conf.RESTIC_PASSWORD}`,
      `-e RESTIC_REPOSITORY=${conf.RESTIC_REPOSITORY.replace("localhost", "host.docker.internal")}`,
    ].join(" ")
  );

/**
 * Gets an environment variable from a Docker container
 *
 * @param containerId The container ID to retrieve the variable from
 * @param variable The variable name to extract
 * @param file If the value is stored inside a file (e.g. when using docker secrets)
 *
 * @returns The variable value
 */
export const getContainerEnvVariables = (
  containerId: string
): Effect.Effect<Record<string, string>, ShellCommandFailureError | UndefinedVariableError | ParsingError> =>
  Effect.gen(function* _getContainerEnvVariable() {
    const result = yield* getShellOutput(`docker exec ${containerId} env`);
    return yield* Effect.try({
      try: () =>
        Object.fromEntries(
          result.split("\n").map((line) => {
            const [key, ...value] = line.split("=");
            return [key, value.join("=")];
          })
        ),
      catch: (e) =>
        new ParsingError({
          cause: e,
          message: "Failed to parse env from shell output",
        }),
    });
  });

/**
 * Gets an environment variable from a Docker container
 *
 * @param containerId The container ID to retrieve the variable from
 * @param variable The variable name to extract
 * @param file If the value is stored inside a file (e.g. when using docker secrets)
 *
 * @returns The variable value
 */
export const getContainerEnvVariable = (
  containerId: string,
  source: Record<string, string>,
  variable: string,
  file = false
): Effect.Effect<string, ShellCommandFailureError | UndefinedVariableError> =>
  Effect.gen(function* _getContainerEnvVariable() {
    let result = source[variable];
    if (!result) return yield* Effect.fail(new UndefinedVariableError({ variable: variable }));

    // If the variable is stored in a file (e.g. with docker secrets) reads the file
    if (result && file) {
      result = yield* getShellOutput(`docker exec ${containerId} cat ${result}`);
    }

    return result;
  });
