import { Duration, Effect, Schedule } from "effect";

import { ConfigTag } from "./effect";
import { redact } from "./redact";
import type { ResticStructuredOutput } from "./restic";

const MAX_LENGTH = 2000;

/** Room for the trailing newline each line gets. */
const MAX_LINE_LENGTH = MAX_LENGTH - 1;

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
 * `notifyDiscord` swallows — so an empty report used to look like a delivered one.
 * An over-long single line is cut rather than sent whole and rejected.
 */
export const formatDiscordReport = (reportLines: ResticStructuredOutput[]): Effect.Effect<string[], never, never> => {
  const chunks: string[] = [];
  let message = "";

  const flush = () => {
    if (message.length > 0) chunks.push(message);
    message = "";
  };

  for (const line of reportLines) {
    const formatted = redact(formatReportLine(line));
    if (formatted.length === 0) continue;

    for (const part of splitLongLine(formatted)) {
      if (message.length + part.length + 1 > MAX_LENGTH) flush();
      message += `${part}\n`;
    }
  }

  flush();
  return Effect.succeed(chunks);
};

/**
 * Sends a webhook to Discord
 * @param content The webhook content
 * @returns void
 */
export const notifyDiscord = (content: string): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* _notifyDiscord() {
    // Discord answers 400 on an empty body; don't spend three retries on it.
    const safe = redact(content).trim();
    if (safe.length === 0) return;

    const config = yield* ConfigTag;

    yield* Effect.tryPromise((signal) =>
      fetch(config.DISCORD_WEBHOOK, {
        body: JSON.stringify({ content: safe }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      })
    );
  }).pipe(
    // 5s timeout
    Effect.timeout(Duration.seconds(5)),
    // 3 attempts retry
    Effect.retry(Schedule.exponential(Duration.seconds(1)).pipe(Schedule.compose(Schedule.recurs(3)))),
    Effect.catchAll(() => Effect.succeed(null))
  );
