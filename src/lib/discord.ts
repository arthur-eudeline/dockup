import { Duration, Effect, Either } from "effect";

import { ConfigTag } from "./effect";
import { DiscordNotificationError } from "./errors";
import { redact } from "./redact";
import type { ResticStructuredOutput } from "./restic";

const MAX_LENGTH = 2000;

/** Room for the trailing newline each line gets. */
const MAX_LINE_LENGTH = MAX_LENGTH - 1;

/** Marks a message that had to be cut to fit Discord's limit. */
const TRUNCATION_MARKER = "\n… (truncated)";

const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT = Duration.seconds(10);
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** Cap on the delay Discord asks for, so a bogus header cannot stall a run. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Cuts a line that would be rejected on its own for exceeding Discord's limit. */
const splitLongLine = (line: string): string[] => {
  if (line.length <= MAX_LINE_LENGTH) return [line];

  const parts: string[] = [];
  for (let i = 0; i < line.length; i += MAX_LINE_LENGTH) {
    parts.push(line.slice(i, i + MAX_LINE_LENGTH));
  }
  return parts;
};

const formatReportLine = (l: ResticStructuredOutput): string => {
  if (l.type === "clean-up") {
    return `🟢 cleaned up ${l.snapshotsRemoved} snapshots. ${l.formattedFreed} space saved`;
  }

  if (!l.success) {
    return `🔴 failed to backup \`${l.backupName}\` : (\`${l.code}\`) ${l.message} (@everyone)`;
  }

  return `🟢 backuped \`${l.backupName}\` : ${l.dataAdded} in ${l.totalDuration}`;
};

/**
 * Splits a report into Discord-sized messages.
 *
 * Never yields an empty chunk: Discord rejects `content: ""` with a 400, which
 * would be counted as a permanently refused message — so an empty report used
 * to look like a delivered one. An over-long single line is cut rather than sent
 * whole and rejected.
 *
 * @param header Prepended to the first chunk. A report can now reach Discord a
 *   day late (see {@link deliverDiscordMessages}), so it must say what it is
 *   about rather than be read as tonight's.
 */
export const formatDiscordReport = (
  reportLines: ResticStructuredOutput[],
  header?: string
): Effect.Effect<string[], never, never> => {
  const formattedLines = reportLines.map((line) => redact(formatReportLine(line))).filter((line) => line.length > 0);

  if (formattedLines.length === 0) return Effect.succeed([]);
  if (header) formattedLines.unshift(redact(header));

  const chunks: string[] = [];
  let message = "";

  const flush = () => {
    if (message.length > 0) chunks.push(message);
    message = "";
  };

  for (const line of formattedLines) {
    for (const part of splitLongLine(line)) {
      if (message.length + part.length + 1 > MAX_LENGTH) flush();
      message += `${part}\n`;
    }
  }

  flush();
  return Effect.succeed(chunks);
};

/** Last-resort cut: Discord answers 400 on anything past its limit. */
const truncate = (content: string): string =>
  content.length <= MAX_LENGTH
    ? content
    : `${content.slice(0, MAX_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;

/** Discord sends `Retry-After` in seconds on a 429. */
const parseRetryAfter = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
};

/**
 * Turns a response into an outcome.
 *
 * `fetch` resolving is *not* success: a webhook deleted from the channel (404),
 * a payload Discord dislikes (400) and an outage (5xx) all came back as a
 * fulfilled promise, so the previous version reported every one of them as a
 * delivered notification.
 */
const classify = (response: Response): Effect.Effect<void, DiscordNotificationError, never> => {
  if (response.ok) return Effect.void;

  if (response.status === 429) {
    return Effect.fail(
      new DiscordNotificationError({
        message: "Discord is rate-limiting us (429)",
        retryable: true,
        retryAfterMs: parseRetryAfter(response),
      })
    );
  }

  // 5xx and 408 are Discord's problem and typically transient; every other 4xx
  // (a revoked webhook, a malformed payload) would be refused just as firmly on
  // the tenth attempt as on the first.
  const retryable = response.status >= 500 || response.status === 408;

  return Effect.fail(
    new DiscordNotificationError({
      message: `Discord answered ${response.status} ${response.statusText}`.trim(),
      retryable,
    })
  );
};

const postOnce = (webhook: string, content: string): Effect.Effect<void, DiscordNotificationError, never> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(webhook, {
        body: JSON.stringify({ content }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      }),
    catch: (e) =>
      new DiscordNotificationError({
        message: `Discord is unreachable : ${redact(e instanceof Error ? e.message : String(e))}`,
        retryable: true,
      }),
  }).pipe(
    Effect.flatMap(classify),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(
        new DiscordNotificationError({
          message: `Discord did not answer within ${Duration.toSeconds(REQUEST_TIMEOUT)}s`,
          retryable: true,
        })
      )
    )
  );

/**
 * Backoff before the next attempt: exponential, capped, and never shorter than
 * what Discord asked for. Jittered because a fleet of dockup hosts all firing at
 * 02:00 must not retry in lockstep.
 */
const backoffMs = (attempt: number, retryAfterMs?: number): number => {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  // oxlint-disable-next-line sonarjs/pseudo-random -- jitter, not a secret
  const jittered = exponential * (0.5 + Math.random() / 2);
  return Math.max(retryAfterMs ?? 0, jittered);
};

/** Posts one message, retrying only what is worth retrying. */
const post = (webhook: string, content: string): Effect.Effect<void, DiscordNotificationError, never> =>
  Effect.gen(function* _post() {
    let failure = new DiscordNotificationError({ message: "Discord delivery never ran", retryable: true });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = yield* Effect.either(postOnce(webhook, content));

      if (Either.isRight(result)) return;

      failure = result.left;
      if (!failure.retryable || attempt === MAX_ATTEMPTS) break;

      yield* Effect.sleep(Duration.millis(backoffMs(attempt, failure.retryAfterMs)));
    }

    return yield* Effect.fail(failure);
  });

/** A message on its way to Discord, with the run it belongs to. */
export interface DiscordMessage {
  /** ISO date of the run that produced it — a message may be sent a day later. */
  at: string;
  content: string;
}

export interface DiscordDeliveryFailure {
  message: DiscordMessage;
  reason: string;
}

export interface DiscordDeliveryReport {
  delivered: number;
  /** Discord was down or rate-limiting: keep these and send them next run. */
  retryable: DiscordDeliveryFailure[];
  /** Discord refused these for good: retrying would only repeat the rejection. */
  dropped: DiscordDeliveryFailure[];
}

/**
 * Delivers messages in order and reports precisely what happened to each.
 *
 * Nothing is swallowed here — that is the caller's decision to make, and the
 * only interesting one: a report that never reached Discord is exactly the
 * situation Discord was supposed to warn about, so the caller both says so
 * locally and keeps `retryable` messages for the next run.
 *
 * Delivery is UI-free and never fails: a failed notification must not fail a
 * backup that otherwise worked.
 */
export const deliverDiscordMessages = (
  messages: DiscordMessage[]
): Effect.Effect<DiscordDeliveryReport, never, ConfigTag> =>
  Effect.gen(function* _deliver() {
    const config = yield* ConfigTag;
    const report: DiscordDeliveryReport = { delivered: 0, dropped: [], retryable: [] };

    /** Set once Discord proves unreachable, to stop hammering it. */
    let outage: string | null = null;

    for (const message of messages) {
      const content = truncate(redact(message.content).trim());
      // Discord answers 400 on an empty body; there is nothing to deliver.
      if (content.length === 0) continue;

      if (outage !== null) {
        report.retryable.push({ message, reason: outage });
        continue;
      }

      const result = yield* Effect.either(post(config.DISCORD_WEBHOOK, content));

      if (Either.isRight(result)) {
        report.delivered += 1;
        continue;
      }

      if (result.left.retryable) {
        // Every remaining message would spend MAX_ATTEMPTS × timeout proving
        // the same point — a backup run must not hang for minutes on a webhook.
        outage = result.left.message;
        report.retryable.push({ message, reason: outage });
      } else {
        report.dropped.push({ message, reason: result.left.message });
      }
    }

    return report;
  });
