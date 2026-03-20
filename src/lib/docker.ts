import { $ } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import type { ShellCommandFailureError } from "./errors";
import { ContainerBackupInfosParsingError, ParsingError } from "./errors";
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
    ).pipe(Effect.map((r) => r.split("\n")));

    // docker inspect --format='{"Id":"{{.Id}}", "Name":"{{.Name}}", "Image":"{{.Config.Image}}"}'
    // `docker inspect --format '{{ index .Config.Labels "${LABELS.BACKUP_NAME}" }}' ${containerId}`
    // yield* Effect.promise(
    //   () =>
    //     // $`docker inspect --format='{"id":"{{.Id}}", "name":"{{.Name}}", "volumes": "{{json .Mounts}}", "backupType" : "{{index .Config.Labels \"${LABELS.BACKUP_ENABLED}\" }}" }' 4c58b0c3045adc19c2e65879dd3ed344317260b488cf6a0a70e9a6318450f8bc`
    //     $`docker inspect --format='{{json .}}' 4c58b0c3045adc19c2e65879dd3ed344317260b488cf6a0a70e9a6318450f8bc`
    // );
    // {{ index .Config.Labels "${LABELS.BACKUP_NAME}"
    // {{ index .Config.Labels "${LABELS.BACKUP_TYPE}"

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
): Effect.Effect<ContainerBackupConfig, ShellCommandFailureError | ContainerBackupInfosParsingError, never> =>
  Effect.gen(function* _getContainerBackupInfos() {
    // Gets the backupName and type
    const [backupName, type] = yield* Effect.all(
      [
        getShellOutput(`docker inspect --format '{{ index .Config.Labels "${LABELS.BACKUP_NAME}" }}' ${containerId}`),
        getShellOutput(`docker inspect --format '{{ index .Config.Labels "${LABELS.BACKUP_TYPE}" }}' ${containerId}`),
      ],
      { concurrency: "unbounded" }
    );

    // Validate the retrieved infos
    const { data, error } = CONTAINER_BACKUP_CONFIG_SCHEMA.safeParse({
      id: containerId,
      backupName,
      type,
    });

    if (error)
      return yield* Effect.fail(
        new ContainerBackupInfosParsingError({
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
