import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type CloudWatchLogsClient,
  type QueryStatus,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import { classifyAwsError } from "./aws-errors.js";
import { retryWithBackoff, sleep, mapSettled } from "./concurrency.js";
import type { LogEvent } from "./results.js";
import { toEpochSeconds } from "./time.js";

/** Logs Insights accepts at most 50 log groups per query. */
export const MAX_LOG_GROUPS_PER_QUERY = 50;
/** Logs Insights caps a single query's returned rows. */
export const MAX_INSIGHTS_LIMIT = 10_000;

export interface LogGroupInfo {
  name: string;
  arn?: string;
  createdMs?: number;
  retentionDays?: number;
  storedBytes?: number;
  logGroupClass?: string;
}

export interface OpContext {
  env: string;
  profile: string;
  region: string;
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/** Escape a literal for use inside an Insights double-quoted string. */
function escapeInsightsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a literal for use inside an Insights /regex/ literal. */
function escapeInsightsRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export interface QuerySpec {
  /** Literal substring or regex source to match against @message. */
  pattern?: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  /** A complete Insights query, bypassing all of the above. */
  queryOverride?: string;
  extraFields?: string[];
  limit: number;
}

export function buildInsightsQuery(spec: QuerySpec): string {
  if (spec.queryOverride) return spec.queryOverride;

  const fields = [
    "@timestamp",
    "@message",
    "@logStream",
    "@log",
    "@ptr",
    ...(spec.extraFields ?? []),
  ];
  const parts = [`fields ${fields.join(", ")}`];

  if (spec.pattern && spec.pattern.length > 0) {
    if (spec.regex || spec.caseInsensitive) {
      // Insights regex literals support inline flags; (?i) is the only way to
      // get a case-insensitive match out of `like`.
      const body = spec.regex
        ? spec.pattern
        : escapeInsightsRegex(spec.pattern);
      const prefix = spec.caseInsensitive ? "(?i)" : "";
      parts.push(`filter @message like /${prefix}${body}/`);
    } else {
      // A quoted string is a plain case-sensitive substring test — no regex
      // metacharacter escaping needed, which is the safest default for IDs.
      parts.push(
        `filter @message like "${escapeInsightsString(spec.pattern)}"`,
      );
    }
  }

  parts.push("sort @timestamp desc");
  parts.push(`limit ${Math.min(spec.limit, MAX_INSIGHTS_LIMIT)}`);

  return parts.join("\n| ");
}

export interface AggregateSpec {
  /** Group-by dimensions, e.g. ["detail.globalClientId"]. */
  by: string[];
  /**
   * Aggregate expressions, e.g. ["count(*) as events", "latest(@timestamp) as last"].
   * Defaults to a single count.
   */
  metrics?: string[];
  /** A filter expression WITHOUT the leading `filter`, e.g. `detail-type = "x"`. */
  filter?: string;
  /** A literal substring to match against @message, combined with `filter`. */
  pattern?: string;
  /** Sort clause without `sort`, e.g. "events desc". Defaults to first metric desc. */
  sort?: string;
  limit?: number;
}

/** Field references with dots/hyphens must be backtick-quoted in Insights. */
function quoteFieldRef(ref: string): string {
  const trimmed = ref.trim();
  // Leave @-fields, backtick-quoted, and function-call expressions untouched.
  if (
    trimmed.startsWith("@") ||
    trimmed.startsWith("`") ||
    /[()]/.test(trimmed)
  ) {
    return trimmed;
  }
  if (/[.-]/.test(trimmed)) return `\`${trimmed}\``;
  return trimmed;
}

/**
 * Build a Logs Insights aggregation query. This is the token-efficient answer
 * to any "group by / count by" question: AWS computes the aggregation
 * server-side and returns one row per group instead of the underlying events.
 */
export function buildAggregateQuery(spec: AggregateSpec): string {
  const metrics = spec.metrics?.length ? spec.metrics : ["count(*) as count"];
  const by = spec.by.map(quoteFieldRef);

  const filters: string[] = [];
  if (spec.pattern) {
    filters.push(
      `@message like "${spec.pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    );
  }
  if (spec.filter) filters.push(`(${spec.filter})`);

  const parts: string[] = [];
  if (filters.length > 0) parts.push(`filter ${filters.join(" and ")}`);
  parts.push(`stats ${metrics.join(", ")} by ${by.join(", ")}`);

  // Default sort: the first metric's alias descending, so the biggest groups
  // come first. Fall back to no sort if we cannot infer an alias.
  const sort = spec.sort ?? inferSortAlias(metrics[0]);
  if (sort) parts.push(`sort ${sort}`);
  parts.push(`limit ${Math.min(spec.limit ?? 1000, MAX_INSIGHTS_LIMIT)}`);

  return parts.join("\n| ");
}

function inferSortAlias(metric: string): string | undefined {
  const m = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(metric.trim());
  return m ? `${m[1]} desc` : undefined;
}

/** FilterLogEvents uses metric-filter syntax, not regex. Quote for a literal term. */
export function buildFilterPattern(pattern?: string): string | undefined {
  if (!pattern) return undefined;
  return `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

/** Insights returns "2026-07-20 14:03:22.123" in UTC with no zone marker. */
function parseInsightsTimestamp(value: string): number {
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? 0 : ms;
}

function rowToEvent(row: ResultField[], fallbackGroup: string): LogEvent {
  const map = new Map<string, string>();
  for (const f of row) {
    if (f.field) map.set(f.field, f.value ?? "");
  }

  const rawTs = map.get("@timestamp") ?? "";
  const timestamp = rawTs ? parseInsightsTimestamp(rawTs) : 0;
  // @log is "<accountId>:<logGroupName>".
  const logRef = map.get("@log") ?? "";
  const logGroup = logRef.includes(":")
    ? logRef.slice(logRef.indexOf(":") + 1)
    : logRef || fallbackGroup;

  const event: LogEvent = {
    timestamp,
    time: timestamp ? new Date(timestamp).toISOString() : rawTs,
    message: map.get("@message") ?? "",
    logGroup,
    logStream: map.get("@logStream"),
    ptr: map.get("@ptr"),
  };

  // Carry through any fields a queryOverride projected.
  for (const [k, v] of map) {
    if (k.startsWith("@")) continue;
    event[k] = v;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function describeLogGroups(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  opts: { prefix?: string; limit?: number } = {},
): Promise<LogGroupInfo[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const groups: LogGroupInfo[] = [];
  let nextToken: string | undefined;

  do {
    const page = await client.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: opts.prefix,
        limit: Math.min(50, limit - groups.length),
        nextToken,
      }),
    );
    for (const g of page.logGroups ?? []) {
      if (!g.logGroupName) continue;
      groups.push({
        name: g.logGroupName,
        arn: g.arn,
        createdMs: g.creationTime,
        retentionDays: g.retentionInDays,
        storedBytes: g.storedBytes,
        logGroupClass: g.logGroupClass,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken && groups.length < limit);

  void ctx;
  return groups;
}

/**
 * Resolve which of the requested log groups actually exist. Returning the
 * missing ones instead of throwing means a search across ten groups still
 * succeeds when one was renamed.
 */
export async function verifyLogGroups(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  names: readonly string[],
): Promise<{
  found: LogGroupInfo[];
  missing: string[];
  /** Groups we could not check at all — the lookup itself failed. */
  errors: { logGroup: string; error: unknown }[];
}> {
  const settled = await mapSettled(names, 6, async (name) => {
    const page = await client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: name, limit: 50 }),
    );
    const exact = (page.logGroups ?? []).find((g) => g.logGroupName === name);
    if (!exact?.logGroupName) return null;
    return {
      name: exact.logGroupName,
      arn: exact.arn,
      createdMs: exact.creationTime,
      retentionDays: exact.retentionInDays,
      storedBytes: exact.storedBytes,
      logGroupClass: exact.logGroupClass,
    } satisfies LogGroupInfo;
  });

  const found: LogGroupInfo[] = [];
  const missing: string[] = [];
  const errors: { logGroup: string; error: unknown }[] = [];

  settled.forEach((r, i) => {
    if (r.ok && r.value) {
      found.push(r.value);
    } else if (r.ok) {
      missing.push(names[i]);
    } else {
      // Critical distinction: "the API said this group is not there" is not the
      // same as "we could not ask". Expired credentials and AccessDenied must
      // never be reported to the user as a misspelled log group name.
      errors.push({ logGroup: names[i], error: r.error });
    }
  });

  void ctx;
  return { found, missing, errors };
}

export interface LogStreamInfo {
  name: string;
  firstEventMs?: number;
  lastEventMs?: number;
  storedBytes?: number;
}

export async function describeLogStreams(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  opts: {
    logGroup: string;
    prefix?: string;
    limit?: number;
    orderByLastEvent?: boolean;
  },
): Promise<LogStreamInfo[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const streams: LogStreamInfo[] = [];
  let nextToken: string | undefined;

  // orderBy=LastEventTime is mutually exclusive with a name prefix in the API.
  const orderByLastEvent = opts.orderByLastEvent !== false && !opts.prefix;

  do {
    const page = await client.send(
      new DescribeLogStreamsCommand({
        logGroupName: opts.logGroup,
        logStreamNamePrefix: opts.prefix,
        orderBy: orderByLastEvent ? "LastEventTime" : "LogStreamName",
        descending: orderByLastEvent ? true : undefined,
        limit: Math.min(50, limit - streams.length),
        nextToken,
      }),
    );
    for (const s of page.logStreams ?? []) {
      if (!s.logStreamName) continue;
      streams.push({
        name: s.logStreamName,
        firstEventMs: s.firstEventTimestamp,
        lastEventMs: s.lastEventTimestamp,
        storedBytes: s.storedBytes,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken && streams.length < limit);

  void ctx;
  return streams;
}

// ---------------------------------------------------------------------------
// Logs Insights
// ---------------------------------------------------------------------------

export interface InsightsStats {
  recordsMatched: number;
  recordsScanned: number;
  bytesScanned: number;
}

export interface InsightsOutcome {
  events: LogEvent[];
  /**
   * The result rows as raw field maps, before any log-event interpretation.
   * A `stats` query returns aggregation columns here (e.g. the group-by
   * dimensions and their counts), which have nothing to do with @timestamp /
   * @message — the aggregation path consumes these directly.
   */
  rawRows: Record<string, string>[];
  stats: InsightsStats;
  status: QueryStatus | "Unknown";
  queryId?: string;
  /** True when the query hit our deadline and was stopped with partial data. */
  timedOut: boolean;
  logGroups: string[];
}

function rowToRecord(row: ResultField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of row) {
    if (f.field) out[f.field] = f.value ?? "";
  }
  return out;
}

const TERMINAL_STATUSES = new Set<string>([
  "Complete",
  "Failed",
  "Cancelled",
  "Timeout",
  "Unknown",
]);

/**
 * Run one Insights query over up to 50 log groups and poll it to completion.
 *
 * Polling is backed off (Insights bills nothing for GetQueryResults but the
 * API is throttled per account), and we always StopQuery on abandonment —
 * otherwise the abandoned query keeps occupying one of the account's 30
 * concurrent query slots until it finishes on its own.
 */
export async function runInsightsQuery(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  opts: {
    logGroups: string[];
    query: string;
    startMs: number;
    endMs: number;
    limit: number;
    deadlineMs: number;
  },
): Promise<InsightsOutcome> {
  if (opts.logGroups.length === 0) {
    return {
      events: [],
      rawRows: [],
      stats: { recordsMatched: 0, recordsScanned: 0, bytesScanned: 0 },
      status: "Complete",
      timedOut: false,
      logGroups: [],
    };
  }

  const startCtx = {
    ...ctx,
    operation: "StartQuery",
    resource: opts.logGroups.join(", "),
  };

  // StartQuery is where the concurrent-query quota bites; the SDK treats
  // LimitExceededException as terminal, so retry it ourselves.
  const started = await retryWithBackoff(
    () =>
      client.send(
        new StartQueryCommand({
          logGroupNames: opts.logGroups,
          queryString: opts.query,
          // Insights takes epoch SECONDS here (FilterLogEvents takes millis).
          startTime: toEpochSeconds(opts.startMs),
          endTime: toEpochSeconds(opts.endMs),
          limit: Math.min(opts.limit, MAX_INSIGHTS_LIMIT),
        }),
      ),
    {
      maxAttempts: 6,
      baseMs: 1_000,
      capMs: 15_000,
      deadlineMs: opts.deadlineMs,
      isRetryable: (err) => {
        const f = classifyAwsError(err, startCtx);
        return (
          f.kind === "quota-exceeded" ||
          f.kind === "throttled" ||
          f.kind === "service"
        );
      },
    },
  );

  const queryId = started.queryId;
  if (!queryId) {
    throw new Error("StartQuery returned no queryId");
  }

  let delay = 400;
  let lastStatus: QueryStatus | "Unknown" = "Scheduled";
  let stats: InsightsStats = {
    recordsMatched: 0,
    recordsScanned: 0,
    bytesScanned: 0,
  };
  let rows: ResultField[][] = [];

  try {
    for (;;) {
      if (Date.now() >= opts.deadlineMs) {
        // Free the concurrency slot before giving up.
        await stopQuerySafely(client, queryId);
        return {
          events: rows.map((r) => rowToEvent(r, opts.logGroups[0])),
          rawRows: rows.map(rowToRecord),
          stats,
          status: lastStatus,
          queryId,
          timedOut: true,
          logGroups: opts.logGroups,
        };
      }

      await sleep(delay);
      // Ramp polling: fast enough to feel instant on small queries, slow
      // enough not to hammer the API on multi-minute scans.
      delay = Math.min(Math.floor(delay * 1.6), 5_000);

      const res = await retryWithBackoff(
        () => client.send(new GetQueryResultsCommand({ queryId })),
        {
          maxAttempts: 5,
          baseMs: 500,
          capMs: 8_000,
          deadlineMs: opts.deadlineMs,
          isRetryable: (err) =>
            classifyAwsError(err, { ...ctx, operation: "GetQueryResults" })
              .retryable,
        },
      );

      lastStatus = (res.status as QueryStatus | undefined) ?? "Unknown";
      rows = res.results ?? rows;
      if (res.statistics) {
        stats = {
          recordsMatched: res.statistics.recordsMatched ?? 0,
          recordsScanned: res.statistics.recordsScanned ?? 0,
          bytesScanned: res.statistics.bytesScanned ?? 0,
        };
      }

      if (TERMINAL_STATUSES.has(lastStatus)) break;
    }
  } catch (err) {
    await stopQuerySafely(client, queryId);
    throw err;
  }

  if (
    lastStatus === "Failed" ||
    lastStatus === "Cancelled" ||
    lastStatus === "Timeout"
  ) {
    throw Object.assign(
      new Error(
        `Logs Insights query ended with status '${lastStatus}' over ${opts.logGroups.length} log group(s). ` +
          (lastStatus === "Timeout"
            ? "The query exceeded the CloudWatch service limit (15 minutes) — narrow the time range."
            : "Check the query syntax and that every log group is readable."),
      ),
      { name: "InsightsQueryFailed" },
    );
  }

  return {
    events: rows.map((r) => rowToEvent(r, opts.logGroups[0])),
    rawRows: rows.map(rowToRecord),
    stats,
    status: lastStatus,
    queryId,
    timedOut: false,
    logGroups: opts.logGroups,
  };
}

async function stopQuerySafely(
  client: CloudWatchLogsClient,
  queryId: string,
): Promise<void> {
  try {
    await client.send(new StopQueryCommand({ queryId }));
  } catch {
    // StopQuery fails if the query already finished — that is the good case.
  }
}

// ---------------------------------------------------------------------------
// FilterLogEvents fallback
// ---------------------------------------------------------------------------

export interface FilterOutcome {
  events: LogEvent[];
  scannedGroups: number;
  truncated: boolean;
  /** Groups whose scan failed. Never mixed into `events`. */
  failures: { logGroup: string; error: unknown }[];
}

/**
 * Fallback path: one paginated FilterLogEvents scan per log group, fanned out
 * with bounded concurrency. Slower and chattier than Insights, but it carries
 * no per-GB scan charge and is unaffected by the Insights concurrency quota.
 */
export async function runFilterSearch(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  opts: {
    logGroups: string[];
    pattern?: string;
    startMs: number;
    endMs: number;
    limit: number;
    deadlineMs: number;
  },
): Promise<FilterOutcome> {
  const filterPattern = buildFilterPattern(opts.pattern);
  const perGroupLimit = Math.max(
    1,
    Math.ceil(opts.limit / Math.max(1, opts.logGroups.length)),
  );
  let truncated = false;

  const settled = await mapSettled(opts.logGroups, 4, async (logGroup) => {
    const collected: LogEvent[] = [];
    let nextToken: string | undefined;

    do {
      if (Date.now() >= opts.deadlineMs) {
        truncated = true;
        break;
      }

      const page = await retryWithBackoff(
        () =>
          client.send(
            new FilterLogEventsCommand({
              logGroupName: logGroup,
              filterPattern,
              // FilterLogEvents takes epoch MILLIS (unlike StartQuery).
              startTime: opts.startMs,
              endTime: opts.endMs,
              limit: Math.min(10_000, perGroupLimit - collected.length),
              nextToken,
            }),
          ),
        {
          maxAttempts: 5,
          baseMs: 500,
          capMs: 10_000,
          deadlineMs: opts.deadlineMs,
          isRetryable: (err) =>
            classifyAwsError(err, {
              ...ctx,
              operation: "FilterLogEvents",
              resource: logGroup,
            }).retryable,
        },
      );

      for (const e of page.events ?? []) {
        const ts = e.timestamp ?? 0;
        collected.push({
          timestamp: ts,
          time: ts ? new Date(ts).toISOString() : "",
          message: e.message ?? "",
          logGroup,
          logStream: e.logStreamName,
          ptr: e.eventId,
        });
      }

      nextToken = page.nextToken;
      if (collected.length >= perGroupLimit) {
        if (nextToken) truncated = true;
        break;
      }
    } while (nextToken);

    return collected;
  });

  const events: LogEvent[] = [];
  const failures: { logGroup: string; error: unknown }[] = [];

  for (const r of settled) {
    if (r.ok) {
      events.push(...r.value);
    } else {
      // A failed group is reported separately, never as a synthetic event.
      // Injecting it into `events` would inflate the hit count and make a
      // zero-result search look like it found something.
      failures.push({ logGroup: opts.logGroups[r.index], error: r.error });
    }
  }

  events.sort((a, b) => b.timestamp - a.timestamp);
  return {
    events: events.slice(0, opts.limit),
    scannedGroups: opts.logGroups.length - failures.length,
    truncated: truncated || events.length > opts.limit,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Context fetch around a single hit
// ---------------------------------------------------------------------------

export async function getStreamEvents(
  client: CloudWatchLogsClient,
  ctx: OpContext,
  opts: {
    logGroup: string;
    logStream: string;
    startMs: number;
    endMs: number;
    limit: number;
  },
): Promise<LogEvent[]> {
  const page = await retryWithBackoff(
    () =>
      client.send(
        new GetLogEventsCommand({
          logGroupName: opts.logGroup,
          logStreamName: opts.logStream,
          startTime: opts.startMs,
          endTime: opts.endMs,
          limit: Math.min(opts.limit, 10_000),
          startFromHead: true,
        }),
      ),
    {
      maxAttempts: 5,
      baseMs: 400,
      capMs: 8_000,
      isRetryable: (err) =>
        classifyAwsError(err, {
          ...ctx,
          operation: "GetLogEvents",
          resource: `${opts.logGroup}/${opts.logStream}`,
        }).retryable,
    },
  );

  return (page.events ?? []).map((e) => {
    const ts = e.timestamp ?? 0;
    return {
      timestamp: ts,
      time: ts ? new Date(ts).toISOString() : "",
      message: e.message ?? "",
      logGroup: opts.logGroup,
      logStream: opts.logStream,
    };
  });
}
