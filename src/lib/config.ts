import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { z } from "zod";

import { decryptFile, encryptFile } from "./crypto";
import { ConfigurationRetrievalError, InvalidConfigurationError } from "./errors";

/**
 * The dockup configuration path
 */
export const configPath = join(homedir(), ".dockup-config");
const configFile = Bun.file(configPath);

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
    const exists = yield* Effect.promise(() => configFile.exists());

    // Error if not exists
    if (!exists) return yield* Effect.fail(new ConfigurationRetrievalError({ configPath, cause: "FILE_NOT_FOUND" }));

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
  Effect.promise(() => encryptFile(configPath, JSON.stringify(config)));
