#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, resolveOutputDir } from "./config.js";
import { ClientManager } from "./connection.js";
import { pruneOldResults } from "./results.js";
import { registerEnvironmentTools } from "./tools/environment.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerSearchTools } from "./tools/search.js";

const log = (msg: string): void => {
  process.stderr.write(`[aws-logs] ${msg}\n`);
};

const INSTRUCTIONS = `AWS CloudWatch Logs search server.

Workflow:
1. Environment first. Every tool takes an optional \`env\` (dev/stg/prd). If you omit it,
   the tool returns an \`environmentRequired\` payload — ask the user which environment
   they mean and call again with \`env\` set. Never guess, especially for production.
2. Resolve what to search. Named targets (e.g. "OLP") map to log groups in the config;
   use discover_log_groups when the user names a service with no configured target.
3. Search with search_logs. It writes full results to an NDJSON file and returns a summary
   plus the file path — read that file to do the actual analysis. The summary's preview is
   only a sample.
4. Follow up with get_log_context to read unfiltered events around a specific hit.

Cost and efficiency: searches default to a 1-hour window and widen only if nothing is found.
Logs Insights is billed per GB scanned, so prefer a narrow time range and specific log groups.
Pass mode='filter' to avoid Insights scan charges at the cost of speed.`;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stderr only — anything on stdout corrupts the JSON-RPC stream.
      log(err.message);
      process.exit(1);
    }
    throw err;
  }

  const outputDir = resolveOutputDir(config);
  const mgr = new ClientManager(config);

  const server = new McpServer(
    { name: "aws-logs", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  registerEnvironmentTools(server, mgr);
  registerDiscoveryTools(server, mgr);
  registerSearchTools(server, mgr);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(
    `ready (stdio) — environments: ${Object.keys(config.environments).join(", ")}; ` +
      `results: ${outputDir}`,
  );

  // Best-effort housekeeping so result files do not accumulate in /tmp. Runs
  // after connect so a slow filesystem never delays server readiness.
  void pruneOldResults(outputDir, config.resultRetentionHours)
    .then((n) => {
      if (n > 0)
        log(
          `pruned ${n} result file(s) older than ${config.resultRetentionHours}h`,
        );
    })
    .catch(() => undefined);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      mgr.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// A CloudWatch call that settles after the MCP layer already responded must not
// take the process down and reset session state.
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection (ignored): ${reason}`);
});

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
