/**
 * Failure-streak detection.
 *
 * A per-run report answers "did tonight work ?". It cannot answer "has anything
 * been backed up lately ?", which is the question that actually matters: a red
 * line in a nightly report is easy to scroll past three nights in a row, and a
 * container that quietly disappeared produces no line at all. So every run
 * folds its outcomes into the persisted health state (`state.ts`) and escalates
 * any backup that has had **no successful run for {@link ALERT_AFTER_DAYS} days**,
 * whatever the reason — it failed, it aborted before it started, or it is simply
 * not there anymore.
 *
 * This module is pure: it takes a state and returns the next one plus the
 * messages to send.
 */

import type { ResticStructuredOutput } from "./restic";
import type { BackupHealth, DockupState } from "./state";
import { daysBetween, formatHumanDate, parseDate } from "./utils";

/** How long a backup may go without a successful run before dockup escalates. */
export const ALERT_AFTER_DAYS = 3;

/**
 * Minimum delay between two escalations for the same backup. The timer fires
 * once a day, so this only keeps a manual re-run (or `dockup service test`)
 * from pinging everyone again minutes after the nightly one did.
 */
const ALERT_COOLDOWN_HOURS = 12;

const HOUR_MS = 3_600_000;

/** Errors are kept only to be quoted in an alert — a stack of them is useless. */
const MAX_STORED_ERROR_LENGTH = 300;

export interface BackupOutcome {
  backupName: string;
  success: boolean;
  /** Preformatted `` (`TAG`) message `` — only on a failure. */
  error?: string;
}

export interface RunEvaluation {
  /** The state to persist. */
  state: DockupState;
  /** Discord-ready escalation and recovery messages, if any. */
  alerts: string[];
}

/** Reads the outcome of each backup out of the lines a run reported. */
export const outcomesFromReport = (lines: ResticStructuredOutput[]): BackupOutcome[] =>
  lines.flatMap((line) => {
    if (line.type !== "backup") return [];

    return [
      {
        backupName: line.backupName,
        success: line.success,
        error: line.success ? undefined : `(\`${line.code}\`) ${line.message}`,
      },
    ];
  });

/**
 * Marks every backup dockup knows about as failed.
 *
 * Used when a run aborts before it can even list the containers: without this
 * the streak would stall at whatever it was, and a broken docker socket could
 * keep every backup stale indefinitely while only ever producing "aborted"
 * messages nobody escalates.
 */
export const preflightOutcomes = (knownNames: string[], error: string): BackupOutcome[] =>
  knownNames.map((backupName) => ({ backupName, error, success: false }));

const freshHealth = (at: string): BackupHealth => ({
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastAlertAt: null,
  lastError: null,
  lastFailureAt: null,
  lastSeenAt: at,
  lastSuccessAt: null,
});

/** Days since the last *successful* backup, or since we started failing/watching. */
const staleDays = (health: BackupHealth, now: Date): number | null => {
  const reference = parseDate(health.lastSuccessAt ?? health.firstFailureAt ?? health.lastSeenAt);
  return reference === null ? null : daysBetween(reference, now);
};

const isThrottled = (health: BackupHealth, now: Date): boolean => {
  const lastAlert = parseDate(health.lastAlertAt);
  if (lastAlert === null) return false;
  return now.getTime() - lastAlert.getTime() < ALERT_COOLDOWN_HOURS * HOUR_MS;
};

const formatAlert = (name: string, health: BackupHealth, days: number, seenThisRun: boolean): string => {
  const lastSuccess = parseDate(health.lastSuccessAt);

  const parts = [
    `🚨 \`${name}\` : no successful backup for ${days} days`,
    lastSuccess === null ? "it has never completed once" : `last success ${formatHumanDate(lastSuccess)}`,
  ];

  if (seenThisRun) {
    if (health.lastError) parts.push(`last error : ${health.lastError}`);
  } else {
    parts.push("no container carrying this backup was found during this run — is it still running ?");
  }

  return `${parts.join("\n")}\n\n(@everyone)`;
};

const formatRecovery = (name: string, failures: number): string =>
  `✅ \`${name}\` is backing up again after ${failures} failed run(s) — alert cleared.`;

/**
 * Folds a run's outcomes into the health state and returns what must be shouted
 * about: backups that crossed the staleness threshold, and backups that just
 * recovered from an alert (an escalation nobody ever sees closed is an
 * escalation people learn to ignore).
 */
export const applyRun = (state: DockupState, outcomes: BackupOutcome[], now: Date): RunEvaluation => {
  const at = now.toISOString();
  const backups: Record<string, BackupHealth> = { ...state.backups };
  const alerts: string[] = [];

  for (const outcome of outcomes) {
    const previous = backups[outcome.backupName] ?? freshHealth(at);

    if (outcome.success) {
      if (previous.lastAlertAt !== null) alerts.push(formatRecovery(outcome.backupName, previous.consecutiveFailures));
      backups[outcome.backupName] = { ...freshHealth(at), lastSuccessAt: at };
      continue;
    }

    backups[outcome.backupName] = {
      ...previous,
      consecutiveFailures: previous.consecutiveFailures + 1,
      firstFailureAt: previous.firstFailureAt ?? at,
      lastError: outcome.error?.slice(0, MAX_STORED_ERROR_LENGTH) ?? null,
      lastFailureAt: at,
      lastSeenAt: at,
    };
  }

  // Every known backup is judged on the same rule, including the ones this run
  // never saw: "vanished" is a failure mode too, and the quietest one.
  const seen = new Set(outcomes.map((outcome) => outcome.backupName));

  for (const [name, health] of Object.entries(backups)) {
    const days = staleDays(health, now);
    if (days === null || days < ALERT_AFTER_DAYS) continue;
    if (isThrottled(health, now)) continue;

    alerts.push(formatAlert(name, health, days, seen.has(name)));
    backups[name] = { ...health, lastAlertAt: at };
  }

  return { alerts, state: { ...state, backups, lastRunAt: at } };
};
