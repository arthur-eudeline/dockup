/**
 * Secret scrubbing for anything that leaves the process — a rendered error, a
 * streamed command log, a Discord webhook.
 *
 * Redaction is done by *exact value* rather than by pattern: every secret dockup
 * handles (S3 keys, the restic password, a container's DB password) is registered
 * here as soon as it is resolved, and {@link redact} replaces those literal
 * substrings wherever they appear. That catches a leak whatever its shape — a
 * command line, a URI, a restic stderr dump — without guessing.
 */

const secrets = new Set<string>();

/** Values short enough to collide with ordinary text are not worth redacting. */
const MIN_SECRET_LENGTH = 6;

const REDACTED = "***";

/**
 * Registers a value to be scrubbed from every message rendered from now on.
 * Safe to call repeatedly with the same value.
 */
export const registerSecret = (value: string | null | undefined): void => {
  if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
};

/**
 * Replaces every registered secret in `text` with `***`.
 * Longest values first, so a secret containing another one is fully masked.
 */
export const redact = (text: string): string => {
  if (secrets.size === 0) return text;

  let output = text;
  for (const secret of [...secrets].toSorted((a, b) => b.length - a.length)) {
    output = output.replaceAll(secret, REDACTED);
  }
  return output;
};
