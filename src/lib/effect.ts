import { Context, Layer } from "effect";

import { readConfig } from "./config";
import type { Config } from "./config";

export const ConfigTag = Context.GenericTag<Config>("ConfigTag");
export type ConfigTag = Config;

/**
 * Layer that reads and decrypts the dockup config into `ConfigTag`.
 * Provided by `runCommand` (src/lib/cli.ts) so a missing/invalid config file
 * surfaces as a typed, rendered error like any other command failure.
 */
export const AppConfig = Layer.effect(ConfigTag, readConfig);

/** Any tagged error (for generic constraints) */
export type AnyTaggedError = Error & { readonly _tag: string };
