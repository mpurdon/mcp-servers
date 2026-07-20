import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientManager } from "../connection.js";
import {
  describeLogGroups,
  describeLogStreams,
  getStreamEvents,
} from "../logs.js";
import { parseInstant, parseDuration } from "../time.js";
import { EnvArg, resolveEnv, textResult, toToolError } from "./shared.js";

const humanBytes = (bytes?: number): string | undefined => {
  if (bytes === undefined) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const iso = (ms?: number): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

export function registerDiscoveryTools(
  server: McpServer,
  mgr: ClientManager,
): void {
  server.tool(
    "discover_log_groups",
    "List CloudWatch log groups in an environment, optionally filtered by name prefix. Use this to find real log group names when the user names a service that has no configured target.",
    {
      env: EnvArg,
      prefix: z
        .string()
        .optional()
        .describe(
          "Log group name prefix, e.g. '/aws/lambda/olp-'. Defaults to the environment's configured logGroupPrefix. Matching is case-sensitive.",
        ),
      contains: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter applied client-side after the prefix query. Use when you know part of the name but not its start.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe("Maximum log groups to return (default 200)."),
    },
    async ({ env, prefix, contains, limit }) => {
      const resolved = resolveEnv(mgr, env);
      if (!resolved.ok) return textResult(resolved.payload);

      const envCfg = mgr.getEffective(resolved.env);
      const effectivePrefix = prefix ?? envCfg.logGroupPrefix;

      try {
        const groups = await describeLogGroups(
          mgr.getLogsClient(resolved.env),
          { env: resolved.env, profile: envCfg.profile, region: envCfg.region },
          { prefix: effectivePrefix, limit: limit ?? 200 },
        );

        const needle = contains?.toLowerCase();
        const filtered = needle
          ? groups.filter((g) => g.name.toLowerCase().includes(needle))
          : groups;

        return textResult({
          env: resolved.env,
          region: envCfg.region,
          prefix: effectivePrefix ?? "(none — whole account)",
          contains,
          count: filtered.length,
          truncated: groups.length >= (limit ?? 200),
          logGroups: filtered.map((g) => ({
            name: g.name,
            retentionDays: g.retentionDays ?? "never expires",
            storedBytes: humanBytes(g.storedBytes),
            created: iso(g.createdMs),
            class: g.logGroupClass,
          })),
        });
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "logs:DescribeLogGroups");
      }
    },
  );

  server.tool(
    "list_log_streams",
    "List log streams in a log group, newest activity first. Use it to confirm a log group is actually receiving data, and to see the time window its data covers before running an expensive search.",
    {
      env: EnvArg,
      logGroup: z.string().min(1).describe("Exact log group name."),
      prefix: z
        .string()
        .optional()
        .describe(
          "Log stream name prefix. Note: supplying this switches ordering from last-event-time to name.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Maximum streams to return (default 50)."),
    },
    async ({ env, logGroup, prefix, limit }) => {
      const resolved = resolveEnv(mgr, env);
      if (!resolved.ok) return textResult(resolved.payload);

      const envCfg = mgr.getEffective(resolved.env);
      try {
        const streams = await describeLogStreams(
          mgr.getLogsClient(resolved.env),
          { env: resolved.env, profile: envCfg.profile, region: envCfg.region },
          { logGroup, prefix, limit: limit ?? 50 },
        );

        const lastEvents = streams
          .map((s) => s.lastEventMs)
          .filter((v): v is number => typeof v === "number");

        return textResult({
          env: resolved.env,
          logGroup,
          count: streams.length,
          mostRecentEvent:
            lastEvents.length > 0 ? iso(Math.max(...lastEvents)) : undefined,
          note:
            streams.length === 0
              ? "This log group has no streams — nothing has ever been written to it."
              : undefined,
          streams: streams.map((s) => ({
            name: s.name,
            firstEvent: iso(s.firstEventMs),
            lastEvent: iso(s.lastEventMs),
            storedBytes: humanBytes(s.storedBytes),
          })),
        });
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "logs:DescribeLogStreams");
      }
    },
  );

  server.tool(
    "get_log_context",
    "Fetch the raw events surrounding a specific moment in one log stream. Use this after a search to read what happened immediately before and after a hit — search results are filtered, this is not.",
    {
      env: EnvArg,
      logGroup: z.string().min(1).describe("Exact log group name."),
      logStream: z
        .string()
        .min(1)
        .describe("Exact log stream name, as returned in a search result."),
      around: z
        .string()
        .describe(
          "The moment to centre on: an ISO-8601 timestamp (use the `time` field from a search hit) or an epoch timestamp.",
        ),
      window: z
        .string()
        .optional()
        .describe(
          "How far to look either side, e.g. '30s', '5m'. Default '1m'.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe("Maximum events to return (default 200)."),
    },
    async ({ env, logGroup, logStream, around, window, limit }) => {
      const resolved = resolveEnv(mgr, env);
      if (!resolved.ok) return textResult(resolved.payload);

      const envCfg = mgr.getEffective(resolved.env);
      try {
        const now = Date.now();
        const centre = parseInstant(around, now);
        const half = parseDuration(window ?? "1m");

        const events = await getStreamEvents(
          mgr.getLogsClient(resolved.env),
          { env: resolved.env, profile: envCfg.profile, region: envCfg.region },
          {
            logGroup,
            logStream,
            startMs: centre - half,
            endMs: centre + half,
            limit: limit ?? 200,
          },
        );

        return textResult({
          env: resolved.env,
          logGroup,
          logStream,
          centre: new Date(centre).toISOString(),
          window: window ?? "1m",
          count: events.length,
          events,
        });
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "logs:GetLogEvents");
      }
    },
  );
}
