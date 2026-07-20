import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveOutputDir } from "../config.js";
import type { ClientManager } from "../connection.js";
import { searchLogs, aggregateLogs } from "../search.js";
import { readResults } from "../results.js";
import {
  EnvArg,
  errorResult,
  resolveEnv,
  textResult,
  toToolError,
} from "./shared.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function registerSearchTools(
  server: McpServer,
  mgr: ClientManager,
): void {
  server.tool(
    "search_logs",
    "Search CloudWatch Logs across one or more log groups and streams, aggregate the hits, and write them to a file on disk. Returns a summary plus the file path — read that file to analyze the full result set. Always confirm the environment with the user first.",
    {
      env: EnvArg,
      target: z
        .string()
        .optional()
        .describe(
          "A named log-group set from the config, e.g. 'OLP'. The fastest way to search a known service.",
        ),
      logGroups: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Explicit log group names. Takes precedence over target. Use discover_log_groups to find them.",
        ),
      logGroupPrefix: z
        .string()
        .optional()
        .describe(
          "Search every log group matching this prefix. Used when neither target nor logGroups is given.",
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "The text to find, e.g. a request id like 'abc123'. Matched as a literal case-sensitive substring unless regex or caseInsensitive is set.",
        ),
      regex: z
        .boolean()
        .optional()
        .describe(
          "Treat `pattern` as a regular expression instead of a literal.",
        ),
      caseInsensitive: z
        .boolean()
        .optional()
        .describe("Match `pattern` case-insensitively."),
      queryOverride: z
        .string()
        .optional()
        .describe(
          "A complete CloudWatch Logs Insights query, replacing pattern entirely. Use for stats/aggregations, e.g. 'stats count(*) by bin(5m)'. Forces the Insights engine and disables auto-widening.",
        ),
      from: z
        .string()
        .optional()
        .describe(
          "Start of the search window: ISO-8601, an epoch timestamp, or a relative offset like '-2h'.",
        ),
      to: z
        .string()
        .optional()
        .describe("End of the search window. Defaults to now."),
      lookback: z
        .string()
        .optional()
        .describe(
          "Shorthand for a window ending now, e.g. '15m', '24h'. Ignored if `from` is given.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum events to return (default 1000)."),
      mode: z
        .enum(["auto", "insights", "filter"])
        .optional()
        .describe(
          "Search engine. 'auto' (default) uses Logs Insights and falls back to FilterLogEvents on quota/permission failures. 'filter' avoids Insights per-GB scan charges but is slower.",
        ),
      autoWiden: z
        .boolean()
        .optional()
        .describe(
          "When no time range is given and nothing is found, progressively widen the window (15m → 1h → 6h → 24h → 3d → 7d). Default true.",
        ),
      verbosity: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default) returns the digested analysis with a short truncated preview — use this. 'full' additionally echoes the generated query, every log group name, and 20 untruncated events; only worth it when debugging the search itself.",
        ),
    },
    async (args) => {
      const resolved = resolveEnv(mgr, args.env);
      if (!resolved.ok) return textResult(resolved.payload);

      if (!args.pattern && !args.queryOverride) {
        return errorResult({
          error: "missingSearchTerm",
          message:
            "Provide `pattern` (the text to find) or `queryOverride` (a full Logs Insights query).",
        });
      }

      try {
        const summary = await searchLogs(mgr, { ...args, env: resolved.env });
        return textResult({
          ...summary,
          nextSteps: summary.resultsFile
            ? `Full results are in ${summary.resultsFile} (NDJSON, newest first). ` +
              `Read that file directly, or page it with read_search_results.`
            : "No results file was written — see warnings.",
        });
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "search_logs");
      }
    },
  );

  server.tool(
    "read_search_results",
    "Page through a results file written by search_logs, with an optional substring filter. Use this when you cannot read the file from disk directly, or to slice a large result set without loading all of it.",
    {
      path: z
        .string()
        .min(1)
        .describe("The resultsFile path returned by search_logs."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of the first matching event to return (default 0)."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("How many events to return (default 100, max 1000)."),
      contains: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter applied to each event line.",
        ),
      fields: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Dot paths to return instead of whole events, e.g. ['time','message.message_type','message.details.rule_arn']. Paths descend into a JSON-encoded message. Use the field names from the search's analysis block — this is by far the cheapest way to read many events.",
        ),
      maxMessageChars: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe(
          "Truncate each event's message to this length. Ignored when `fields` is set.",
        ),
    },
    async ({ path, offset, limit, contains, fields, maxMessageChars }) => {
      // Constrain reads to directories this server writes to, so the tool
      // cannot be steered into reading arbitrary files.
      const allowed = [
        resolveOutputDir(mgr.getConfig()),
        join(tmpdir(), "aws-logs-mcp"),
      ];
      try {
        return textResult(
          await readResults(path, allowed, {
            offset,
            limit,
            contains,
            fields,
            maxMessageChars,
          }),
        );
      } catch (err) {
        return errorResult({
          error: "readFailed",
          message: (err as Error).message,
        });
      }
    },
  );

  server.tool(
    "aggregate_logs",
    "Group and count log events server-side with CloudWatch Logs Insights, returning one row per group instead of the raw events. This is the efficient way to answer 'which/how many X' questions — e.g. all client ids that had an event, error counts by type, requests per minute. Vastly cheaper than search_logs + counting, because AWS does the aggregation and only the reduced result crosses the wire. Confirm the environment first.",
    {
      env: EnvArg,
      target: z
        .string()
        .optional()
        .describe("A named log-group set from the config, e.g. 'OLP-events'."),
      logGroups: z
        .array(z.string().min(1))
        .optional()
        .describe("Explicit log group names. Takes precedence over target."),
      logGroupPrefix: z
        .string()
        .optional()
        .describe("Aggregate over every log group matching this prefix."),
      by: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Group-by dimensions as Logs Insights field paths, e.g. ['detail.globalClientId'] or ['detail-type','detail.status']. Dotted/hyphenated paths are backtick-quoted automatically.",
        ),
      metrics: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Aggregate expressions with aliases, e.g. ['count(*) as events','earliest(@timestamp) as first','latest(@timestamp) as last','count_distinct(detail.matterId) as matters']. Defaults to ['count(*) as count'].",
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'A Logs Insights filter expression WITHOUT the leading \'filter\', e.g. `detail-type = "brief-reviewCompleted"` or `detail.status = "completed" and level = "ERROR"`.',
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "A literal substring that must appear in the raw message, combined with `filter`. Useful to scope by an id before grouping.",
        ),
      sort: z
        .string()
        .optional()
        .describe(
          "Sort clause without 'sort', e.g. 'events desc'. Defaults to the first metric's alias descending.",
        ),
      from: z
        .string()
        .optional()
        .describe("Window start (ISO/epoch/relative)."),
      to: z.string().optional().describe("Window end. Defaults to now."),
      lookback: z
        .string()
        .optional()
        .describe("Window ending now, e.g. '7d'. Ignored if `from` is set."),
      limit: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe("Maximum groups to return (default 1000)."),
    },
    async (args) => {
      const resolved = resolveEnv(mgr, args.env);
      if (!resolved.ok) return textResult(resolved.payload);
      try {
        return textResult(
          await aggregateLogs(mgr, { ...args, env: resolved.env }),
        );
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "aggregate_logs");
      }
    },
  );
}
