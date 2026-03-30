// oxlint-disable promise/prefer-await-to-then
// oxlint-disable prefer-destructuring
import { exists } from "node:fs/promises";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import { decryptFile, encryptFile } from "./crypto";
import { ConfigurationRetrievalError, InvalidConfigurationError, ShellCommandFailureError } from "./errors";
import { getShellOutput } from "./utils";

/**
 * The dockup configuration path
 */
export const configPath = join("/etc/dockup.conf");
const configFile = Bun.file(configPath);

export const DOCKUP_SHELL_USER = "dockup";

/**
 * The dockup configuration object validation schema
 */
export const CONFIG_SCHEMA = z.object({
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  DISCORD_WEBHOOK: z.url({ hostname: /^discord\.com$/ }),
  RESTIC_PASSWORD: z.string().min(24),
  RESTIC_REPOSITORY: z.url({ protocol: /^s3$/ }),
});

/**
 * The dockup configuration object
 */
export type Config = z.infer<typeof CONFIG_SCHEMA>;

/**
 * Validate the dockup configuration content
 *
 * @param payload The configuration data
 * @returns The validated configuration object.
 */
export const validateConfig = (payload: unknown): Effect.Effect<Config, InvalidConfigurationError, never> => {
  const { data, error } = CONFIG_SCHEMA.safeParse(payload);

  if (error) return Effect.fail(new InvalidConfigurationError({ zodError: error }));

  return Effect.succeed(data);
};

/**
 * Reads the configuration file from disk
 */
export const readConfig: Effect.Effect<Config, ConfigurationRetrievalError | InvalidConfigurationError, never> =
  Effect.gen(function* readConfig() {
    const _exists = yield* Effect.promise(() => configFile.exists());

    // Error if not exists
    if (!_exists) return yield* Effect.fail(new ConfigurationRetrievalError({ configPath, cause: "FILE_NOT_FOUND" }));

    // Attempt to decrypt it
    const data = yield* Effect.tryPromise({
      try: () => decryptFile(configPath).then(JSON.parse),
      catch: () => new ConfigurationRetrievalError({ configPath, cause: "DECRYPTION_FAILED" }),
    });

    return yield* validateConfig(data);
  });

/**
 * Persist the configuration on disk
 *
 * @param config The configuration payload
 */
export const writeConfig = (config: Config): Effect.Effect<void, never, never> =>
  Effect.promise(async () => {
    const dir = dirname(configPath);
    if (!(await exists(dir))) await $`mkdir -p ${dir}`;
    await encryptFile(configPath, JSON.stringify(config));

    await $`sudo chown $USER:$USER ${configPath}`;

    /**
     * Permissions :
     * Current user : read write 6
     * dockup (group) : read only 4
     * others : no access 0
     */
    await $`sudo chmod 640 ${configPath}`;
  });

export const addConfigPermission = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo chown $USER:${DOCKUP_SHELL_USER} ${configPath}`);

export const removeConfigPermission = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo chown $USER:$USER ${configPath}`);

export const checkIfUserExists = (): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => $`getent passwd ${DOCKUP_SHELL_USER}`.quiet().then(() => true)).pipe(
    Effect.catchAll(() => Effect.succeed(false))
  );

export const createUser = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo adduser --system --group --no-create-home --shell /bin/false ${DOCKUP_SHELL_USER}`);

export const deleteUser = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo deluser ${DOCKUP_SHELL_USER}`);

export const checkIfUserIsInDockerGroup = (): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => $`groups ${DOCKUP_SHELL_USER}`.text().then((r) => r.includes("docker"))).pipe(
    Effect.catchAll(() => Effect.succeed(false))
  );

export const checkIfCurrentUserIsInDockupGroup = (): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => $`groups $USER`.text().then((r) => r.includes(DOCKUP_SHELL_USER))).pipe(
    Effect.catchAll(() => Effect.succeed(false))
  );

export const addUserToDockerGroup = (): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.tryPromise({
    try: () => $`sudo usermod -aG docker ${DOCKUP_SHELL_USER}`,
    catch: (e) =>
      new ShellCommandFailureError({
        cause: e,
        message: `Failed to add ${DOCKUP_SHELL_USER} user to docker group`,
      }),
  });

export const addCurrentUserToDockupGroup = (): Effect.Effect<string, ShellCommandFailureError> =>
  Effect.tryPromise({
    try: async () => {
      const currentUser = await $`whoami`.text();

      await $`sudo usermod -aG $USER ${DOCKUP_SHELL_USER}`;

      return currentUser;
    },
    catch: (e) =>
      new ShellCommandFailureError({
        message: `Failed to add current user to ${DOCKUP_SHELL_USER} group`,
        cause: e,
      }),
  });
