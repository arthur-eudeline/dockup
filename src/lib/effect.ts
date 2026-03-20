import type { taskLog } from "@clack/prompts";
// oxlint-disable promise/prefer-await-to-callbacks
// oxlint-disable typescript/no-explicit-any
import type { Match } from "effect";
import { Context, Layer, ManagedRuntime, Effect } from "effect";

import { readConfig } from "./config";
import type { Config } from "./config";

export const LogTag = Context.GenericTag<Config>("LogTag");
export type LogTag = ReturnType<typeof taskLog>;

export const ConfigTag = Context.GenericTag<Config>("ConfigTag");
export type ConfigTag = Config;
export const AppConfig = Layer.effect(ConfigTag, readConfig);

export const effectRuntime = ManagedRuntime.make(AppConfig);

/** Any tagged error (for generic constraints) */
export type AnyTaggedError = Error & { readonly _tag: string };

/** Handler map for exhaustive matching */
type MatchHandlers<E extends AnyTaggedError, R> = {
  [K in E["_tag"]]: (err: Extract<E, { _tag: K }>) => R;
};

/** Partial handler map for non-exhaustive matching */
type PartialMatchHandlers<E extends AnyTaggedError, R> = Partial<MatchHandlers<E, R>>;

/** Extract handled tags from a handlers object */
type HandledTags<E extends AnyTaggedError, H> = Extract<keyof H, E["_tag"]>;

/**
 * Exhaustive pattern match on tagged error union within an Effect.
 *
 * Works with your TaggedError classes and provides type-safe error handling
 * that integrates seamlessly with Effect.pipe()
 *
 * @example
 * // Using with Effect.catchTags (built-in alternative)
 * const program = someEffect.pipe(
 *   Effect.catchTags({
 *     NotFoundError: (e) => Effect.succeed(`Missing: ${e.id}`),
 *     ValidationError: (e) => Effect.succeed(`Invalid: ${e.field}`),
 *   })
 * )
 *
 * @example
 * // Using matchErrorEffect (custom wrapper for consistency with better-result)
 * const program = someEffect.pipe(
 *   matchErrorEffect({
 *     NotFoundError: (e) => Effect.succeed(`Missing: ${e.id}`),
 *     ValidationError: (e) => Effect.succeed(`Invalid: ${e.field}`),
 *   })
 * )
 */
export const matchErrorEffect: <E extends AnyTaggedError, R, A>(
  handlers: MatchHandlers<E, Effect.Effect<any, never, R>>
) => (effect: Effect.Effect<A, E, R>) => Effect.Effect<any, never, R> = (handlers) => (effect) =>
  Effect.catchAll(effect, (error) => {
    const handler = handlers[error._tag as keyof typeof handlers];
    if (!handler) {
      // This should never happen if handlers satisfy MatchHandlers<E, R>
      return Effect.die(error);
    }
    return handler(error as any);
  });

/**
 * Pattern match on a caught error value (not inside Effect).
 *
 * Useful when you've already extracted the error and want to match on it.
 * Use this for non-Effect error handling, or use matchErrorEffect for
 * error handling within Effect operations.
 *
 * @example
 * const result = matchError(err, {
 *   NotFoundError: (e) => `Missing: ${e.id}`,
 *   ValidationError: (e) => `Invalid: ${e.field}`,
 * })
 */
export const matchError: {
  <E extends AnyTaggedError, R>(err: E, handlers: MatchHandlers<E, R>): R;
  <E extends AnyTaggedError, R>(handlers: MatchHandlers<E, R>): (err: E) => R;
} = ((errOrHandlers: any, handlersOrUndefined?: any) => {
  // Check if this is data-first or data-last call
  if (handlersOrUndefined !== undefined) {
    // Data-first: matchError(err, handlers)
    const err = errOrHandlers;
    const handlers = handlersOrUndefined;
    const handler = handlers[err._tag as keyof typeof handlers];
    return handler(err);
  }
  // Data-last: matchError(handlers)
  const handlers = errOrHandlers;
  return (err: any) => {
    const handler = handlers[err._tag as keyof typeof handlers];
    return handler(err);
  };
}) as any;

/**
 * Partial pattern match with fallback handler.
 *
 * Use when you don't want to handle all error cases exhaustively.
 *
 * @example
 * const result = matchErrorPartial(err, {
 *   NotFoundError: (e) => `Missing: ${e.id}`,
 * }, (e) => `Unknown error: ${e.message}`)
 */
export const matchErrorPartial: {
  <E extends AnyTaggedError, R, const H extends PartialMatchHandlers<E, R>>(
    err: E,
    handlers: H,
    fallback: (e: Exclude<E, { _tag: HandledTags<E, H> }>) => R
  ): R;
  <E extends AnyTaggedError, R, const H extends PartialMatchHandlers<E, R> = PartialMatchHandlers<E, R>>(
    handlers: H,
    fallback: (e: Exclude<E, { _tag: HandledTags<E, H> }>) => R
  ): (err: E) => R;
} = ((handlersOrErr: any, fallbackOrHandlers?: any, fallbackOrUndefined?: any) => {
  if (fallbackOrUndefined !== undefined) {
    // Data-first: matchErrorPartial(err, handlers, fallback)
    const err = handlersOrErr;
    const handlers = fallbackOrHandlers;
    const fallback = fallbackOrUndefined;
    const handler = handlers[err._tag];
    if (typeof handler === "function") {
      return handler(err);
    }
    return fallback(err);
  }
  // Data-last: matchErrorPartial(handlers, fallback)
  const handlers = handlersOrErr;
  const fallback = fallbackOrHandlers;
  return (err: any) => {
    const handler = handlers[err._tag];
    if (typeof handler === "function") {
      return handler(err);
    }
    return fallback(err);
  };
}) as any;

/**
 * Pattern match using Match.type for more complex discriminator logic.
 *
 * This provides access to all Match utilities for more advanced patterns,
 * but requires manual exhaustiveness checking.
 *
 * @example
 * const handleError = Match.type<NotFoundError | ValidationError>().pipe(
 *   Match.tag("NotFoundError", (e) => `Missing: ${e.id}`),
 *   Match.tag("ValidationError", (e) => `Invalid: ${e.field}`),
 *   Match.exhaustive
 * )
 *
 * const result = handleError(err)
 */
export type MatchTypeErrorBuilder<E extends AnyTaggedError> = ReturnType<typeof Match.type<E>>;
