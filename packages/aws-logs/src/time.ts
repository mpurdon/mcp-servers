/**
 * Time-range handling. Two units are in play and mixing them is the classic
 * CloudWatch bug: Logs Insights StartQuery takes epoch **seconds**, while
 * FilterLogEvents/GetLogEvents take epoch **milliseconds**. Everything in this
 * module is milliseconds; conversion happens at the API boundary only.
 */

export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeRangeError";
  }
}

const RELATIVE = /^-?(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration like "15m", "2h", "7d" into milliseconds. */
export function parseDuration(input: string): number {
  const m = RELATIVE.exec(input.trim());
  if (!m) {
    throw new TimeRangeError(
      `Cannot parse duration '${input}'. Use forms like '15m', '2h', '7d'.`,
    );
  }
  return Math.round(Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
}

/**
 * Parse a point in time. Accepts:
 *   "now", "-15m" / "15m" (relative to now), ISO-8601, epoch seconds, epoch millis.
 */
export function parseInstant(input: string, now: number): number {
  const raw = input.trim();
  if (raw === "" || raw.toLowerCase() === "now") return now;

  if (RELATIVE.test(raw)) {
    // Both "-15m" and "15m" mean 15 minutes ago; a bare positive duration as an
    // *instant* is never meaningfully in the future for log search.
    return now - parseDuration(raw.replace(/^-/, ""));
  }

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // 10-digit values are epoch seconds, 13-digit are millis. Anything smaller
    // than ~2001 in millis is almost certainly seconds passed by mistake.
    return raw.length <= 10 ? n * 1000 : n;
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new TimeRangeError(
      `Cannot parse time '${input}'. Use 'now', a relative offset like '-2h', ` +
        `an ISO-8601 timestamp like '2026-07-20T14:00:00Z', or an epoch timestamp.`,
    );
  }
  return parsed;
}

export interface ResolvedRange {
  startMs: number;
  endMs: number;
  /** True when the caller gave no explicit range, so auto-widening is allowed. */
  inferred: boolean;
  label: string;
}

/** Clock skew tolerance — events can carry timestamps slightly ahead of local time. */
const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_RANGE_MS = 90 * 86_400_000;

export function resolveRange(
  opts: { from?: string; to?: string; lookback?: string },
  now: number,
  defaultLookback: string,
): ResolvedRange {
  const hasExplicit = Boolean(opts.from ?? opts.to ?? opts.lookback);

  const endMs = opts.to ? parseInstant(opts.to, now) : now;

  let startMs: number;
  if (opts.from) {
    startMs = parseInstant(opts.from, now);
  } else {
    const lookback = opts.lookback ?? defaultLookback;
    startMs = endMs - parseDuration(lookback);
  }

  if (startMs >= endMs) {
    throw new TimeRangeError(
      `Start time (${new Date(startMs).toISOString()}) must be before end time ` +
        `(${new Date(endMs).toISOString()}).`,
    );
  }
  if (startMs > now + FUTURE_SKEW_MS) {
    throw new TimeRangeError(
      `Start time ${new Date(startMs).toISOString()} is in the future — no logs can exist there.`,
    );
  }
  if (endMs - startMs > MAX_RANGE_MS) {
    throw new TimeRangeError(
      `Time range spans ${Math.round((endMs - startMs) / 86_400_000)} days, over the 90-day ceiling. ` +
        `Narrow the range — CloudWatch scans are billed per GB.`,
    );
  }

  return {
    startMs,
    endMs,
    inferred: !hasExplicit,
    label: `${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
  };
}

/**
 * The widening ladder used when an inferred range returns nothing. Searching a
 * narrow window first is what keeps the common case fast and cheap; widening
 * only on a miss avoids scanning days of logs to find something from 5 minutes
 * ago.
 */
export const WIDENING_LADDER_MS: number[] = [
  15 * 60_000,
  60 * 60_000,
  6 * 3_600_000,
  24 * 3_600_000,
  3 * 86_400_000,
  7 * 86_400_000,
];

export function nextWiderRange(
  current: ResolvedRange,
  floorMs?: number,
): ResolvedRange | null {
  const span = current.endMs - current.startMs;
  const next = WIDENING_LADDER_MS.find((c) => c > span * 1.5);
  if (next === undefined) return null;

  let startMs = current.endMs - next;
  // Never search before the log group can possibly have data (creation time or
  // retention cutoff) — that is pure wasted scan cost.
  if (floorMs !== undefined && startMs < floorMs) {
    if (current.startMs <= floorMs) return null;
    startMs = floorMs;
  }

  return {
    startMs,
    endMs: current.endMs,
    inferred: true,
    label: `${new Date(startMs).toISOString()} → ${new Date(current.endMs).toISOString()}`,
  };
}

export function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);
