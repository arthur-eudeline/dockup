import { Duration, Effect, Schedule } from "effect";

import { ConfigTag } from "./effect";
import type { ResticStructuredOutput } from "./restic";

const MAX_LENGTH = 2000;

export const formatDiscordReport = (reportLines: ResticStructuredOutput[]): Effect.Effect<string[], never, never> => {
  const output: string[] = [];
  let message = "";
  for (const l of reportLines) {
    let formatted = "";

    if (l.type === "backup") {
      if (l.success) {
        const parts = [`🟢 backuped \`${l.backupName}\``];
        if ("volumeName" in l) parts.push(l.volumeName);
        parts.push(`: ${l.dataAdded} in ${l.totalDuration}`);
        formatted = parts.join(" ");
      } else {
        formatted = `🔴 failed to backup \`${l.backupName}\` : (\`${l.code}\`) ${l.message} (@everyone)`;
      }
    } else if (l.type === "clean-up") {
      formatted = `🟢 cleaned up ${l.snapshotsRemoved} snapshots. ${l.formattedFreed} space saved`;
    }

    if (message.length + formatted.length > MAX_LENGTH) {
      output.push(message);
      message = "";
    }

    message += `${formatted}\n`;
  }

  output.push(message);
  return Effect.succeed(output);
};

/**
 * Sends a webhook to Discord
 * @param content The webhook content
 * @returns void
 */
export const notifyDiscord = (content: string): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* _notifyDiscord() {
    const config = yield* ConfigTag;

    yield* Effect.tryPromise((signal) =>
      fetch(config.DISCORD_WEBHOOK, {
        body: JSON.stringify({ content }),
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
