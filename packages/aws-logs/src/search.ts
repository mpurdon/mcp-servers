import type { ClientManager } from "./connection.js";
import { resolveOutputDir } from "./config.js";
import { classifyAwsError, type AwsFailure } from "./aws-errors.js";
import { chunk, mapSettled } from "./concurrency.js";
import {
  MAX_LOG_GROUPS_PER_QUERY,
  buildAggregateQuery,
  buildInsightsQuery,
  describeLogGroups,
  runFilterSearch,
  runInsightsQuery,
  verifyLogGroups,
  type LogGroupInfo,
  type OpContext,
} from "./logs.js";
import { writeResults, type LogEvent } from "./results.js";
import { analyzeEvents, type EventAnalysis } from "./analyze.js";
import {
  formatSpan,
  nextWiderRange,
  resolveRange,
  type ResolvedRange,
} from "./time.js";

export interface SearchArgs {
  env: string;
  target?: string;
  logGroups?: string[];
  logGroupPrefix?: string;
  pattern?: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  queryOverride?: string;
  from?: string;
  to?: string;
  lookback?: string;
  limit?: number;
  mode?: "auto" | "insights" | "filter";
  autoWiden?: boolean;
  /** "summary" (default) digests the events; "full" echoes more raw detail. */
  verbosity?: "summary" | "full";
}

export interface AggregateArgs {
  env: string;
  target?: string;
  logGroups?: string[];
  logGroupPrefix?: string;
  /** Group-by dimensions, e.g. ["detail.globalClientId"]. */
  by: string[];
  /** Aggregate expressions; defaults to count(*). */
  metrics?: string[];
  /** Raw Insights filter expression (without `filter`). */
  filter?: string;
  /** Literal substring match on @message, combined with `filter`. */
  pattern?: string;
  sort?: string;
  from?: string;
  to?: string;
  lookback?: string;
  limit?: number;
}

export interface SearchSummary {
  env: string;
  profile: string;
  region: string;
  engine: "insights" | "filter";
  query?: string;
  pattern?: string;
  timeRange: { from: string; to: string; span: string; widened: boolean };
  /**
   * Names are only listed when the set is small or verbosity is "full" — a
   * prefix search can span dozens of groups, and echoing them all costs more
   * context than it returns.
   */
  logGroups: {
    searched: number;
    withHits: { logGroup: string; events: number }[];
    names?: string[];
  };
  logGroupsMissing: string[];
  totals: {
    events: number;
    truncated: boolean;
    recordsScanned?: number;
    bytesScanned?: number;
    gbScanned?: number;
  };
  breakdown: {
    topStreams: { logStream: string; logGroup: string; events: number }[];
    firstEvent?: string;
    lastEvent?: string;
  };
  /** The point of this response: the events digested rather than dumped. */
  analysis: EventAnalysis;
  resultsFile?: string;
  fileWriteError?: string;
  preview: LogEvent[];
  warnings: string[];
  wideningAttempts?: string[];
}

const DEFAULT_LOOKBACK = "1h";
const PREVIEW_COUNT = 2;
/** Messages are frequently >1KB of JSON; a preview is a shape check, not the data. */
const PREVIEW_MESSAGE_CHARS = 250;
/** Above this, list only the log groups that actually matched. */
const MAX_LISTED_LOG_GROUPS = 10;

function opContext(mgr: ClientManager, env: string): OpContext {
  const e = mgr.getEffective(env);
  return { env, profile: e.profile, region: e.region };
}

/**
 * Work out which log groups to search. Precedence is explicit names, then a
 * configured target alias, then a prefix scan, then the environment's default
 * prefix — most specific wins.
 */
export async function resolveLogGroups(
  mgr: ClientManager,
  args: Pick<SearchArgs, "env" | "target" | "logGroups" | "logGroupPrefix">,
): Promise<{ names: string[]; source: string; warnings: string[] }> {
  const envCfg = mgr.getEnvironment(args.env);
  const warnings: string[] = [];

  if (args.logGroups && args.logGroups.length > 0) {
    return {
      names: [...new Set(args.logGroups)],
      source: "explicit",
      warnings,
    };
  }

  if (args.target) {
    const target = envCfg.targets[args.target];
    if (!target) {
      const available = Object.keys(envCfg.targets);
      throw new Error(
        `Target '${args.target}' is not configured for environment '${args.env}'. ` +
          (available.length > 0
            ? `Configured targets: ${available.join(", ")}. `
            : `No targets are configured for this environment. `) +
          `Either add it to ~/.aws-logs-mcp/config.json or pass logGroups/logGroupPrefix explicitly ` +
          `(use discover_log_groups to find the real names).`,
      );
    }
    return {
      names: [...new Set(target.logGroups)],
      source: `target:${args.target}`,
      warnings,
    };
  }

  const prefix = args.logGroupPrefix ?? envCfg.logGroupPrefix;
  if (!prefix) {
    throw new Error(
      `No log groups specified. Pass one of: target (a configured alias), logGroups (explicit names), ` +
        `or logGroupPrefix. Configured targets for '${args.env}': ` +
        `${Object.keys(envCfg.targets).join(", ") || "(none)"}.`,
    );
  }

  const client = mgr.getLogsClient(args.env);
  const discovered = await describeLogGroups(client, opContext(mgr, args.env), {
    prefix,
    limit: 200,
  });

  if (discovered.length === 0) {
    throw new Error(
      `No log groups match prefix '${prefix}' in ${envCfg.region} for environment '${args.env}'. ` +
        `Use discover_log_groups with a shorter prefix to see what exists.`,
    );
  }

  if (discovered.length > MAX_LOG_GROUPS_PER_QUERY) {
    warnings.push(
      `Prefix '${prefix}' matched ${discovered.length} log groups; they will be searched in ` +
        `${Math.ceil(discovered.length / MAX_LOG_GROUPS_PER_QUERY)} batches. ` +
        `Narrow the prefix to reduce scan cost.`,
    );
  }

  return {
    names: discovered.map((g) => g.name),
    source: `prefix:${prefix}`,
    warnings,
  };
}

/**
 * The earliest instant worth searching: no log group can hold data before it
 * was created, or before its retention window. Used to stop auto-widening from
 * scanning empty time.
 */
function dataFloorMs(groups: LogGroupInfo[], now: number): number | undefined {
  if (groups.length === 0) return undefined;

  const created = groups
    .map((g) => g.createdMs)
    .filter((v): v is number => typeof v === "number");
  const earliestCreated = created.length > 0 ? Math.min(...created) : undefined;

  // Use the most generous retention across the set, so we do not clip a group
  // that keeps logs longer than its neighbours.
  const retentions = groups.map((g) => g.retentionDays);
  const neverExpires = retentions.some((r) => r === undefined);
  const retentionFloor = neverExpires
    ? undefined
    : now -
      Math.max(...retentions.filter((r): r is number => r !== undefined)) *
        86_400_000;

  const candidates = [earliestCreated, retentionFloor].filter(
    (v): v is number => typeof v === "number",
  );
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function dedupe(events: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  for (const e of events) {
    // @ptr is unique per record; without it, the tuple is unique in practice.
    const key =
      e.ptr ?? `${e.logGroup}|${e.logStream ?? ""}|${e.timestamp}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function summarizeBreakdown(events: LogEvent[]): SearchSummary["breakdown"] & {
  byLogGroup: { logGroup: string; events: number }[];
} {
  const byGroup = new Map<string, number>();
  // Keyed by object identity per (group, stream) pair rather than a joined
  // string — stream names can contain any delimiter you might pick.
  const byStream = new Map<
    string,
    { logGroup: string; logStream: string; count: number }
  >();
  let first: number | undefined;
  let last: number | undefined;

  for (const e of events) {
    byGroup.set(e.logGroup, (byGroup.get(e.logGroup) ?? 0) + 1);
    if (e.logStream) {
      const key = JSON.stringify([e.logGroup, e.logStream]);
      const cur = byStream.get(key);
      if (cur) {
        cur.count++;
      } else {
        byStream.set(key, {
          logGroup: e.logGroup,
          logStream: e.logStream,
          count: 1,
        });
      }
    }
    if (e.timestamp > 0) {
      if (first === undefined || e.timestamp < first) first = e.timestamp;
      if (last === undefined || e.timestamp > last) last = e.timestamp;
    }
  }

  const streams = [...byStream.values()]
    .map((v) => ({
      logStream: v.logStream,
      logGroup: v.logGroup,
      events: v.count,
    }))
    .sort((a, b) => b.events - a.events);
  // Streams holding a single event are usually named per invocation (a UUID
  // each); listing them is identifier noise. Prefer the ones that concentrate
  // events, and fall back to the raw list only when none do.
  const concentrated = streams.filter((s) => s.events > 1);

  return {
    byLogGroup: [...byGroup.entries()]
      .map(([logGroup, count]) => ({ logGroup, events: count }))
      .sort((a, b) => b.events - a.events),
    topStreams: (concentrated.length > 0 ? concentrated : streams).slice(0, 5),
    firstEvent: first !== undefined ? new Date(first).toISOString() : undefined,
    lastEvent: last !== undefined ? new Date(last).toISOString() : undefined,
  };
}

interface EngineRun {
  events: LogEvent[];
  truncated: boolean;
  recordsScanned?: number;
  bytesScanned?: number;
  engine: "insights" | "filter";
  warnings: string[];
}

async function runInsightsAcrossBatches(
  mgr: ClientManager,
  env: string,
  groups: string[],
  query: string,
  range: ResolvedRange,
  limit: number,
  deadlineMs: number,
): Promise<EngineRun> {
  const client = mgr.getLogsClient(env);
  const ctx = opContext(mgr, env);
  const batches = chunk(groups, MAX_LOG_GROUPS_PER_QUERY);
  const warnings: string[] = [];

  // Batches run concurrently but capped at 3: the account-wide Insights
  // concurrency quota is shared with everything else using the account.
  const settled = await mapSettled(batches, 3, (batch) =>
    runInsightsQuery(client, ctx, {
      logGroups: batch,
      query,
      startMs: range.startMs,
      endMs: range.endMs,
      limit,
      deadlineMs,
    }),
  );

  const events: LogEvent[] = [];
  let truncated = false;
  let recordsScanned = 0;
  let bytesScanned = 0;
  let anySucceeded = false;
  let lastError: unknown;

  settled.forEach((r, i) => {
    if (!r.ok) {
      lastError = r.error;
      const failure = classifyAwsError(r.error, {
        ...ctx,
        operation: "Logs Insights query",
        resource: batches[i].join(", "),
      });
      warnings.push(
        `Batch ${i + 1}/${batches.length} failed (${failure.code}): ${failure.remediation}`,
      );
      return;
    }
    anySucceeded = true;
    events.push(...r.value.events);
    recordsScanned += r.value.stats.recordsScanned;
    bytesScanned += r.value.stats.bytesScanned;
    if (r.value.timedOut) {
      truncated = true;
      warnings.push(
        `Batch ${i + 1}/${batches.length} hit the query timeout and returned partial results.`,
      );
    }
  });

  if (!anySucceeded) throw lastError;

  return {
    events,
    truncated,
    recordsScanned,
    bytesScanned,
    engine: "insights",
    warnings,
  };
}

/**
 * The shared preamble for any operation over resolved log groups: verify the
 * account, resolve group names, and check they exist. Returns the surviving
 * groups plus warnings, or throws with an actionable message.
 */
async function prepareGroups(
  mgr: ClientManager,
  args: Pick<SearchArgs, "env" | "target" | "logGroups" | "logGroupPrefix">,
): Promise<{ found: LogGroupInfo[]; missing: string[]; warnings: string[] }> {
  const envCfg = mgr.getEffective(args.env);
  const ctx = opContext(mgr, args.env);
  const warnings: string[] = [];

  await mgr.assertExpectedAccount(args.env);

  const resolved = await resolveLogGroups(mgr, args);
  warnings.push(...resolved.warnings);

  const { found, missing, errors } = await verifyLogGroups(
    mgr.getLogsClient(args.env),
    ctx,
    resolved.names,
  );

  if (found.length === 0) {
    if (errors.length > 0) throw errors[0].error;
    throw new Error(
      `None of the requested log groups exist in ${envCfg.region} ` +
        `for environment '${args.env}': ${resolved.names.join(", ")}. ` +
        `Use discover_log_groups to list the real names (they are case-sensitive).`,
    );
  }
  if (missing.length > 0) {
    warnings.push(
      `Skipped ${missing.length} log group(s) that do not exist: ${missing.join(", ")}`,
    );
  }
  for (const { logGroup, error } of errors) {
    const failure = classifyAwsError(error, {
      ...ctx,
      operation: "DescribeLogGroups",
      resource: logGroup,
    });
    warnings.push(
      `Could not check ${logGroup} (${failure.code}) — it was excluded. ${failure.remediation}`,
    );
  }

  return { found, missing, warnings };
}

export interface AggregateSummary {
  env: string;
  region: string;
  engine: "insights";
  timeRange: { from: string; to: string; span: string };
  logGroupsSearched: number;
  query: string;
  aggregation: {
    by: string[];
    metrics: string[];
    rowCount: number;
    truncated: boolean;
    /** One object per group — the whole point: the answer, already reduced. */
    rows: Record<string, string>[];
  };
  totals: {
    recordsScanned?: number;
    bytesScanned?: number;
    gbScanned?: number;
  };
  warnings: string[];
}

/**
 * Answer a "group by / count by" question by pushing the aggregation into
 * CloudWatch Logs Insights. AWS returns one row per group, so the tool response
 * is the reduced answer (a handful of rows) rather than the underlying events —
 * the most token-efficient shape this server can produce.
 */
export async function aggregateLogs(
  mgr: ClientManager,
  args: AggregateArgs,
): Promise<AggregateSummary> {
  const config = mgr.getConfig();
  const envCfg = mgr.getEffective(args.env);
  const ctx = opContext(mgr, args.env);
  const now = Date.now();

  const { found, warnings } = await prepareGroups(mgr, args);
  const groupNames = found.map((g) => g.name);

  // Aggregation across >50 groups would require merging partial stats across
  // batches — trivial for count/sum but wrong for latest/avg/percentile. Rather
  // than silently mis-aggregate, cap at one batch and say so.
  if (groupNames.length > MAX_LOG_GROUPS_PER_QUERY) {
    throw new Error(
      `Aggregation spans ${groupNames.length} log groups, over the ${MAX_LOG_GROUPS_PER_QUERY}-group ` +
        `limit for a single Insights query. Cross-batch merging of aggregates is not supported ` +
        `(it would corrupt latest/avg/percentile). Narrow the target or logGroups.`,
    );
  }

  const target = args.target ? envCfg.targets[args.target] : undefined;
  const range = resolveRange(
    { from: args.from, to: args.to, lookback: args.lookback },
    now,
    target?.defaultLookback ?? DEFAULT_LOOKBACK,
  );

  const metrics = args.metrics?.length ? args.metrics : ["count(*) as count"];
  const query = buildAggregateQuery({
    by: args.by,
    metrics,
    filter: args.filter,
    pattern: args.pattern,
    sort: args.sort,
    limit: args.limit ?? 1000,
  });

  const outcome = await runInsightsQuery(mgr.getLogsClient(args.env), ctx, {
    logGroups: groupNames,
    query,
    startMs: range.startMs,
    endMs: range.endMs,
    limit: args.limit ?? 1000,
    deadlineMs: Date.now() + config.queryTimeoutSeconds * 1000,
  });

  if (outcome.timedOut) {
    warnings.push(
      "The aggregation hit the query timeout and may be incomplete — narrow the time range.",
    );
  }

  const bytes = outcome.stats.bytesScanned;
  return {
    env: args.env,
    region: envCfg.region,
    engine: "insights",
    timeRange: {
      from: new Date(range.startMs).toISOString(),
      to: new Date(range.endMs).toISOString(),
      span: formatSpan(range.endMs - range.startMs),
    },
    logGroupsSearched: groupNames.length,
    query,
    aggregation: {
      by: args.by,
      metrics,
      rowCount: outcome.rawRows.length,
      truncated: outcome.rawRows.length >= (args.limit ?? 1000),
      rows: outcome.rawRows,
    },
    totals: {
      recordsScanned: outcome.stats.recordsScanned,
      bytesScanned: bytes,
      gbScanned:
        bytes !== undefined
          ? Number((bytes / 1_073_741_824).toFixed(4))
          : undefined,
    },
    warnings,
  };
}

export async function searchLogs(
  mgr: ClientManager,
  args: SearchArgs,
): Promise<SearchSummary> {
  const config = mgr.getConfig();
  const envCfg = mgr.getEffective(args.env);
  const ctx = opContext(mgr, args.env);
  const now = Date.now();

  const { found, missing, warnings } = await prepareGroups(mgr, args);
  const client = mgr.getLogsClient(args.env);

  const target = args.target ? envCfg.targets[args.target] : undefined;
  const defaultLookback = target?.defaultLookback ?? DEFAULT_LOOKBACK;
  let range = resolveRange(
    { from: args.from, to: args.to, lookback: args.lookback },
    now,
    defaultLookback,
  );

  const floor = dataFloorMs(found, now);
  if (floor !== undefined && range.startMs < floor) {
    warnings.push(
      `Start time clamped to ${new Date(floor).toISOString()} — the log groups hold no data before that ` +
        `(creation time / retention window).`,
    );
    range = {
      ...range,
      startMs: floor,
      label: `${new Date(floor).toISOString()} → ${new Date(range.endMs).toISOString()}`,
    };
  }

  const limit = Math.min(args.limit ?? 1_000, config.maxResults);
  const groupNames = found.map((g) => g.name);
  const query = buildInsightsQuery({
    pattern: args.pattern,
    regex: args.regex,
    caseInsensitive: args.caseInsensitive,
    queryOverride: args.queryOverride,
    extraFields: target?.fields,
    limit,
  });

  const mode = args.mode ?? "auto";
  const wideningAttempts: string[] = [];
  let run: EngineRun | undefined;
  let widened = false;

  const runFilterOnce = async (r: ResolvedRange): Promise<EngineRun> => {
    if (args.queryOverride) {
      throw new Error(
        "queryOverride requires the Logs Insights engine; it cannot run through FilterLogEvents. " +
          "Drop queryOverride or set mode='insights'.",
      );
    }
    const out = await runFilterSearch(client, ctx, {
      logGroups: groupNames,
      pattern: args.pattern,
      startMs: r.startMs,
      endMs: r.endMs,
      limit,
      deadlineMs: Date.now() + config.queryTimeoutSeconds * 1000,
    });
    return {
      events: out.events,
      truncated: out.truncated,
      engine: "filter",
      warnings: out.failures.map(({ logGroup, error }) => {
        const f = classifyAwsError(error, {
          ...ctx,
          operation: "FilterLogEvents",
          resource: logGroup,
        });
        return `Could not search ${logGroup} (${f.code}) — excluded from results. ${f.remediation}`;
      }),
    };
  };

  const runOnce = async (r: ResolvedRange): Promise<EngineRun> => {
    const deadlineMs = Date.now() + config.queryTimeoutSeconds * 1000;
    if (mode === "filter") return runFilterOnce(r);

    try {
      return await runInsightsAcrossBatches(
        mgr,
        args.env,
        groupNames,
        query,
        r,
        limit,
        deadlineMs,
      );
    } catch (err) {
      if (mode === "insights") throw err;

      // Auto mode: fall back when Insights is unavailable for a reason
      // FilterLogEvents would not share (quota, or no StartQuery permission).
      const failure: AwsFailure = classifyAwsError(err, {
        ...ctx,
        operation: "Logs Insights query",
      });
      if (
        failure.kind !== "quota-exceeded" &&
        failure.kind !== "access-denied"
      ) {
        throw err;
      }
      const fallback = await runFilterOnce(r);
      fallback.warnings.push(
        `Logs Insights was unavailable (${failure.code}); fell back to FilterLogEvents. ${failure.remediation}`,
      );
      return fallback;
    }
  };

  run = await runOnce(range);

  // Auto-widening: only when the caller gave no explicit range. Starting narrow
  // and widening on a miss is what keeps the common "find this ID" case both
  // fast and cheap, without silently scanning a week of logs up front.
  if (
    run.events.length === 0 &&
    range.inferred &&
    args.autoWiden !== false &&
    !args.queryOverride
  ) {
    for (let i = 0; i < 4; i++) {
      const wider = nextWiderRange(range, floor);
      if (!wider) break;
      wideningAttempts.push(
        `no hits in ${formatSpan(range.endMs - range.startMs)}, widened to ${formatSpan(wider.endMs - wider.startMs)}`,
      );
      range = wider;
      widened = true;
      run = await runOnce(range);
      if (run.events.length > 0) break;
    }
  }

  warnings.push(...run.warnings);

  const events = dedupe(run.events)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  if (events.length >= limit) {
    warnings.push(
      `Result set hit the limit of ${limit} events — there are probably more matches. ` +
        `Narrow the time range or raise limit (max ${config.maxResults}).`,
    );
  }

  if (events.length === 0) {
    warnings.push(
      `No matches. Checked ${groupNames.length} log group(s) over ${formatSpan(range.endMs - range.startMs)}. ` +
        `Verify the search term, or use list_log_streams to confirm these groups are receiving data at all.`,
    );
  }

  // Persist before summarizing: the file is the deliverable, the summary is
  // the index into it.
  let resultsFile: string | undefined;
  let fileWriteError: string | undefined;
  let truncated = run.truncated;

  if (events.length > 0) {
    try {
      const outcome = await writeResults(
        resolveOutputDir(config),
        `${args.env}-${args.target ?? args.pattern ?? "search"}`,
        events,
      );
      resultsFile = outcome.path;
      if (outcome.truncated) {
        truncated = true;
        warnings.push(
          `Result file hit the size ceiling; only ${outcome.events} of ${events.length} events were written.`,
        );
      }
      if (outcome.fallbackReason) {
        warnings.push(
          `Wrote results to a fallback directory: ${outcome.fallbackReason}`,
        );
      }
    } catch (err) {
      // Never lose the search to a disk problem — report it and return the
      // events inline via the preview instead.
      fileWriteError = (err as Error).message;
      warnings.push(
        `Could not write the results file (${fileWriteError}). Only the preview below is available.`,
      );
    }
  }

  const bytesScanned = run.bytesScanned;
  const breakdown = summarizeBreakdown(events);
  const full = args.verbosity === "full";

  return {
    env: args.env,
    profile: envCfg.profile,
    region: envCfg.region,
    engine: run.engine,
    // The generated query is diagnostic noise unless something looks wrong.
    query: full && run.engine === "insights" ? query : undefined,
    pattern: args.pattern,
    timeRange: {
      from: new Date(range.startMs).toISOString(),
      to: new Date(range.endMs).toISOString(),
      span: formatSpan(range.endMs - range.startMs),
      widened,
    },
    logGroups: {
      searched: groupNames.length,
      withHits: breakdown.byLogGroup,
      names:
        full || groupNames.length <= MAX_LISTED_LOG_GROUPS
          ? groupNames
          : undefined,
    },
    logGroupsMissing: missing,
    totals: {
      events: events.length,
      truncated,
      recordsScanned: run.recordsScanned,
      bytesScanned,
      gbScanned:
        bytesScanned !== undefined
          ? Number((bytesScanned / 1_073_741_824).toFixed(4))
          : undefined,
    },
    breakdown: {
      topStreams: breakdown.topStreams,
      firstEvent: breakdown.firstEvent,
      lastEvent: breakdown.lastEvent,
    },
    analysis: analyzeEvents(events),
    resultsFile,
    fileWriteError,
    // Full messages only on request; otherwise a shape check, not the payload.
    preview: events.slice(0, full ? 20 : PREVIEW_COUNT).map((e) =>
      full
        ? e
        : {
            ...e,
            message:
              e.message.length > PREVIEW_MESSAGE_CHARS
                ? `${e.message.slice(0, PREVIEW_MESSAGE_CHARS)}…(+${e.message.length - PREVIEW_MESSAGE_CHARS} chars, full text in resultsFile)`
                : e.message,
          },
    ),
    warnings,
    wideningAttempts:
      wideningAttempts.length > 0 ? wideningAttempts : undefined,
  };
}
