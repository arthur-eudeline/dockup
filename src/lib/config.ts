// oxlint-disable promise/prefer-await-to-then
// oxlint-disable prefer-destructuring
import { exists } from "node:fs/promises";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Effect } from "effect";
import { z } from "zod";

import { decryptFile, encryptFile } from "./crypto";
import { ConfigurationRetrievalError, InvalidConfigurationError, ShellCommandFailureError } from "./errors";
import { getShellOutput, sh } from "./utils";

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
export const writeConfig = (config: Config): Effect.Effect<void, ShellCommandFailureError, never> =>
  Effect.gen(function* _writeConfig() {
    const user = yield* getCurrentUser();

    // Typed failure rather than `Effect<void, never>`: these are three shell
    // operations that can very much fail, and a defect would be rendered as
    // "This is a bug in dockup" instead of a permission problem.
    yield* Effect.tryPromise({
      try: async () => {
        const dir = dirname(configPath);
        if (!(await exists(dir))) await $`mkdir -p ${dir}`;
        await encryptFile(configPath, JSON.stringify(config));
      },
      catch: (e) =>
        new ShellCommandFailureError({
          cause: e,
          message: `Failed to write the configuration file at ${configPath}`,
        }),
    });

    yield* getShellOutput(sh`sudo chown ${`${user}:${user}`} ${configPath}`);

    /**
     * Permissions :
     * Current user : read write 6
     * dockup (group) : read only 4
     * others : no access 0
     */
    yield* getShellOutput(sh`sudo chmod 640 ${configPath}`);
  });

/**
 * The user invoking dockup.
 *
 * `$USER` is not reliable — it is unset under systemd and points at root under
 * `sudo` — so ask the system rather than the environment.
 */
export const getCurrentUser = (): Effect.Effect<string, ShellCommandFailureError> => getShellOutput("id -un");

export const addConfigPermission = (): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.gen(function* _addConfigPermission() {
    const user = yield* getCurrentUser();
    yield* getShellOutput(sh`sudo chown ${`${user}:${DOCKUP_SHELL_USER}`} ${configPath}`);
  });

export const removeConfigPermission = (): Effect.Effect<void, ShellCommandFailureError> =>
  Effect.gen(function* _removeConfigPermission() {
    const user = yield* getCurrentUser();
    yield* getShellOutput(sh`sudo chown ${`${user}:${user}`} ${configPath}`);
  });

export const checkIfUserExists = (): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => $`getent passwd ${DOCKUP_SHELL_USER}`.quiet().then(() => true)).pipe(
    Effect.catchAll(() => Effect.succeed(false))
  );

export const createUser = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo adduser --system --group --no-create-home --shell /bin/false ${DOCKUP_SHELL_USER}`);

export const deleteUser = (): Effect.Effect<void, ShellCommandFailureError> =>
  getShellOutput(`sudo deluser ${DOCKUP_SHELL_USER}`);

/**
 * Whether `user` belongs to `group`.
 *
 * Compares whole names: a substring test made `docker-users` answer yes for
 * `docker`, and `dockup-admins` yes for `dockup`.
 */
const isUserInGroup = (user: string, group: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => $`id -nG ${user}`.text().then((r) => r.trim().split(/\s+/).includes(group))).pipe(
    Effect.catchAll(() => Effect.succeed(false))
  );

export const checkIfUserIsInDockerGroup = (): Effect.Effect<boolean, never> =>
  isUserInGroup(DOCKUP_SHELL_USER, "docker");

export const checkIfCurrentUserIsInDockupGroup = (): Effect.Effect<boolean, never> =>
  getCurrentUser().pipe(
    Effect.flatMap((user) => isUserInGroup(user, DOCKUP_SHELL_USER)),
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
  Effect.gen(function* _addCurrentUserToDockupGroup() {
    const currentUser = yield* getCurrentUser();

    // `usermod -aG <group> <user>`, in that order. It used to read
    // `usermod -aG $USER dockup`, which added the *service account* to the
    // invoking user's group — the exact opposite, and a grant of the root group
    // to an account already in `docker` whenever init was run under sudo.
    yield* Effect.tryPromise({
      try: () => $`sudo usermod -aG ${DOCKUP_SHELL_USER} ${currentUser}`.quiet(),
      catch: (e) =>
        new ShellCommandFailureError({
          message: `Failed to add ${currentUser} to the ${DOCKUP_SHELL_USER} group`,
          cause: e,
        }),
    });

    return currentUser;
  });
