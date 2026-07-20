import type { LogEvent } from "./results.js";

/**
 * Turns a pile of log events into something small enough to reason over.
 *
 * Log lines are overwhelmingly repetitive — the same ARNs, account ids, and
 * bus names on every record. Shipping the raw events to a model burns context
 * on boilerplate and buries the few fields that actually vary. This module
 * separates what is constant (say once), what enumerates (count it), and what
 * is unique per event (name it, don't list it).
 */

export interface FieldSummary {
  field: string;
  /** Distinct value count across all events. */
  distinct: number;
  /** Present in this many events. */
  present: number;
  /** Top values with counts. Omitted for identifier-like fields. */
  values?: { value: string; count: number }[];
  /** True when `values` was cut short. */
  more?: number;
  /** One example, for identifier-like fields. */
  example?: string;
}

export interface MessagePattern {
  /** The message with variable parts replaced by placeholders. */
  template: string;
  count: number;
  example: string;
}

export interface TimelineBucket {
  start: string;
  count: number;
}

export interface EventAnalysis {
  format: "json" | "text" | "mixed";
  eventCount: number;
  /** Fields identical across every event — stated once instead of N times. */
  constantFields?: Record<string, string>;
  /** Fields that take a small number of values — the useful signal. */
  varyingFields?: FieldSummary[];
  /** Fields that are unique or near-unique per event (ids, timestamps). */
  identifierFields?: FieldSummary[];
  /** Clustered templates, for unstructured text logs. */
  patterns?: MessagePattern[];
  timeline?: { bucket: string; buckets: TimelineBucket[] };
  /** Severity tally, from a log-level field or inline level tokens. */
  levels?: Record<string, number>;
  notes?: string[];
}

const MAX_DEPTH = 4;
const MAX_VALUES_PER_FIELD = 8;
const MAX_VARYING_FIELDS = 25;
const MAX_PATTERNS = 15;
const MAX_TIMELINE_BUCKETS = 24;
const MAX_VALUE_CHARS = 120;

function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}…(+${value.length - max})`;
}

function tryParseJson(message: string): unknown {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Flatten nested objects to dot paths so each field can be counted independently. */
function flatten(
  value: unknown,
  prefix: string,
  depth: number,
  out: Map<string, string>,
): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) {
    if (prefix) out.set(prefix, String(value));
    return;
  }

  if (Array.isArray(value)) {
    // Arrays are summarized by length, not enumerated — element-wise paths
    // explode cardinality without adding signal.
    out.set(prefix, `[array:${value.length}]`);
    return;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    }
    return;
  }

  out.set(prefix, truncate(String(value), MAX_VALUE_CHARS));
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const NUM_RE = /\b\d+(?:\.\d+)?\b/g;

/** Collapse the variable parts of a log line so identical shapes group together. */
export function templatize(message: string): string {
  return message
    .replace(UUID_RE, "<uuid>")
    .replace(ISO_RE, "<ts>")
    .replace(HEX_RE, "<hex>")
    .replace(IP_RE, "<ip>")
    .replace(NUM_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

const LEVEL_RE =
  /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/;

function pickBucketMs(spanMs: number): { ms: number; label: string } {
  const candidates: [number, string][] = [
    [60_000, "1m"],
    [300_000, "5m"],
    [900_000, "15m"],
    [3_600_000, "1h"],
    [21_600_000, "6h"],
    [86_400_000, "1d"],
    [604_800_000, "7d"],
  ];
  for (const [ms, label] of candidates) {
    if (spanMs / ms <= MAX_TIMELINE_BUCKETS) return { ms, label };
  }
  return { ms: 604_800_000, label: "7d" };
}

function buildTimeline(
  events: readonly LogEvent[],
): EventAnalysis["timeline"] | undefined {
  const stamps = events.map((e) => e.timestamp).filter((t) => t > 0);
  if (stamps.length < 2) return undefined;

  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const span = max - min;
  if (span <= 0) return undefined;

  const { ms, label } = pickBucketMs(span);
  const counts = new Map<number, number>();
  for (const t of stamps) {
    const bucket = Math.floor(t / ms) * ms;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return {
    bucket: label,
    buckets: [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([start, count]) => ({
        start: new Date(start).toISOString(),
        count,
      })),
  };
}

function summarizeFields(
  rows: Map<string, string>[],
  total: number,
): {
  constant: Record<string, string>;
  varying: FieldSummary[];
  identifiers: FieldSummary[];
} {
  const byField = new Map<string, Map<string, number>>();
  for (const row of rows) {
    for (const [field, value] of row) {
      let counts = byField.get(field);
      if (!counts) {
        counts = new Map();
        byField.set(field, counts);
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const constant: Record<string, string> = {};
  const varying: FieldSummary[] = [];
  const identifiers: FieldSummary[] = [];

  for (const [field, counts] of byField) {
    const present = [...counts.values()].reduce((a, b) => a + b, 0);
    const distinct = counts.size;

    // One distinct value means constant, whether or not every event carries the
    // field. Events from different log groups have different schemas, so a
    // field present in 22 of 33 records is still a constant — emitting it as a
    // "varying" field with a one-element list is pure overhead.
    if (distinct === 1) {
      const value = [...counts.keys()][0];
      constant[field] =
        present === total ? value : `${value}   [in ${present}/${total}]`;
      continue;
    }

    // Enumerating values only helps when a field partitions the events into a
    // few buckets. Two cases get a count + example instead of a value list:
    //   1. Near-unique per occurrence (uuids, per-record timestamps/paths) —
    //      measured against `present`, not `total`, so a field living in one of
    //      several mixed schemas is still caught within its own subset.
    //   2. High cardinality generally (more distinct values than we would ever
    //      show) — e.g. a duration in ms. Listing the top 8 of 40 is noise.
    // Either way the raw values are in the results file if they are needed.
    const nearUnique = distinct >= 3 && distinct >= present * 0.9;
    const highCardinality = distinct > MAX_VALUES_PER_FIELD;
    if (nearUnique || highCardinality) {
      identifiers.push({
        field,
        distinct,
        present,
        example: truncate([...counts.keys()][0], MAX_VALUE_CHARS),
      });
      continue;
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, MAX_VALUES_PER_FIELD);
    varying.push({
      field,
      distinct,
      present,
      values: shown.map(([value, count]) => ({ value, count })),
      more:
        sorted.length > shown.length ? sorted.length - shown.length : undefined,
    });
  }

  // Most-informative first: fewest distinct values reads as the cleanest signal.
  varying.sort((a, b) => a.distinct - b.distinct || b.present - a.present);
  identifiers.sort((a, b) => a.field.localeCompare(b.field));

  return {
    constant,
    varying: varying.slice(0, MAX_VARYING_FIELDS),
    identifiers,
  };
}

function summarizePatterns(messages: string[]): MessagePattern[] {
  const groups = new Map<string, { count: number; example: string }>();
  for (const message of messages) {
    const template = templatize(message);
    const existing = groups.get(template);
    if (existing) {
      existing.count++;
    } else {
      groups.set(template, { count: 1, example: message });
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, MAX_PATTERNS)
    .map(([template, { count, example }]) => ({
      template: truncate(template, 300),
      count,
      example: truncate(example, 300),
    }));
}

export function analyzeEvents(events: readonly LogEvent[]): EventAnalysis {
  const notes: string[] = [];
  if (events.length === 0) {
    return { format: "text", eventCount: 0 };
  }

  const jsonRows: Map<string, string>[] = [];
  const textMessages: string[] = [];

  for (const event of events) {
    const parsed = tryParseJson(event.message);
    if (parsed && typeof parsed === "object") {
      const row = new Map<string, string>();
      flatten(parsed, "", 0, row);
      jsonRows.push(row);
    } else {
      textMessages.push(event.message);
    }
  }

  const format: EventAnalysis["format"] =
    jsonRows.length > 0 && textMessages.length > 0
      ? "mixed"
      : jsonRows.length > 0
        ? "json"
        : "text";

  const analysis: EventAnalysis = {
    format,
    eventCount: events.length,
    timeline: buildTimeline(events),
  };

  if (jsonRows.length > 0) {
    const { constant, varying, identifiers } = summarizeFields(
      jsonRows,
      jsonRows.length,
    );
    if (Object.keys(constant).length > 0) analysis.constantFields = constant;
    if (varying.length > 0) analysis.varyingFields = varying;
    if (identifiers.length > 0) analysis.identifierFields = identifiers;
  }

  if (textMessages.length > 0) {
    analysis.patterns = summarizePatterns(textMessages);
  }

  // Severity: prefer an explicit level field, fall back to inline tokens.
  const levels = new Map<string, number>();
  for (const event of events) {
    const parsed = tryParseJson(event.message);
    let level: string | undefined;
    if (parsed && typeof parsed === "object") {
      const row = parsed as Record<string, unknown>;
      const raw = row.log_level ?? row.level ?? row.severity ?? row.loglevel;
      if (typeof raw === "string") level = raw.toUpperCase();
    }
    if (!level) level = LEVEL_RE.exec(event.message)?.[1]?.toUpperCase();
    if (level) levels.set(level, (levels.get(level) ?? 0) + 1);
  }
  if (levels.size > 0) {
    analysis.levels = Object.fromEntries(
      [...levels.entries()].sort((a, b) => b[1] - a[1]),
    );
  }

  if (format === "mixed") {
    notes.push(
      `${jsonRows.length} JSON event(s) and ${textMessages.length} plain-text event(s); ` +
        `field analysis covers the JSON ones, patterns cover the rest.`,
    );
  }
  if (notes.length > 0) analysis.notes = notes;

  return analysis;
}
