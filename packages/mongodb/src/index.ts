#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { ConnectionManager } from "./connection.js";
import { registerEnvironmentTools } from "./tools/environment.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Write to stderr so it surfaces in the host's MCP log without
      // corrupting the stdio JSON-RPC stream on stdout.
      process.stderr.write(`[mongodb] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const conn = new ConnectionManager(config);

  const server = new McpServer(
    {
      name: "mongodb",
      version: "0.1.0",
    },
    {
      instructions:
        "MongoDB MCP server. Switch environments with switch_environment; check status with current_environment. Read tools are unrestricted. Write tools require confirmed=true when the active environment is 'prd'. drop_collection ALWAYS requires confirmed=true.",
    },
  );

  registerEnvironmentTools(server, conn);
  registerReadTools(server, conn);
  registerWriteTools(server, conn);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await conn.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Prevent unhandled rejections (e.g. a MongoDB op that times out after the
// MCP layer already returned) from crashing the process and resetting state.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[mongodb] unhandled rejection (ignored): ${reason}\n`);
});

main().catch((err) => {
  process.stderr.write(`[mongodb] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
