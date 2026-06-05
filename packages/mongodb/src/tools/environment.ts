import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection.js";
import { EnvKey, loadConfig, safeHostFromUri, ConfigError } from "../config.js";

const textResult = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
});

const errorResult = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

export function registerEnvironmentTools(
  server: McpServer,
  conn: ConnectionManager,
): void {
  server.tool(
    "switch_environment",
    "Switch the active MongoDB environment (dev|stg|prd). Reconnects and verifies the new connection.",
    { env: EnvKey },
    async ({ env }) => {
      try {
        await conn.switchTo(env);
        return textResult({
          active: env,
          name: conn.getActiveEnvName(),
          host: conn.getActiveHost(),
          writesRestricted: conn.isProduction(),
        });
      } catch (err) {
        return errorResult(
          `Failed to switch to '${env}': ${(err as Error).message}`,
        );
      }
    },
  );

  server.tool(
    "current_environment",
    "Return the active environment, its display name, the connection host (no credentials), and whether writes require confirmation.",
    {},
    async () => {
      return textResult({
        active: conn.getActiveEnv(),
        name: conn.getActiveEnvName(),
        host: conn.getActiveHost(),
        writesRestricted: conn.isProduction(),
      });
    },
  );

  server.tool(
    "ping",
    "Ping the active MongoDB connection. Returns env, host, and round-trip time in ms.",
    {},
    async () => {
      const start = Date.now();
      try {
        const client = await conn.getClient();
        await client.db("admin").command({ ping: 1 });
        return textResult({
          ok: true,
          env: conn.getActiveEnv(),
          host: conn.getActiveHost(),
          roundTripMs: Date.now() - start,
        });
      } catch (err) {
        return errorResult(
          `ping failed (env=${conn.getActiveEnv()}, host=${conn.getActiveHost()}): ${(err as Error).message}`,
        );
      }
    },
  );

  server.tool(
    "reload_config",
    "Re-read ~/.mongodb-mcp/config.json and reconnect without restarting Claude Desktop. Useful after updating connection strings.",
    {},
    async () => {
      let newConfig;
      try {
        newConfig = loadConfig();
      } catch (err) {
        return errorResult(
          err instanceof ConfigError
            ? `Config error: ${err.message}`
            : `Failed to read config: ${(err as Error).message}`,
        );
      }
      try {
        await conn.reloadConfig(newConfig);
      } catch (err) {
        return errorResult(
          `Config loaded but reconnect failed: ${(err as Error).message}`,
        );
      }
      const envs = Object.entries(newConfig.environments).map(([key, val]) => ({
        env: key,
        name: val.name,
        host: safeHostFromUri(val.connectionString),
      }));
      return textResult({
        reloaded: true,
        active: conn.getActiveEnv(),
        name: conn.getActiveEnvName(),
        host: conn.getActiveHost(),
        writesRestricted: conn.isProduction(),
        environments: envs,
      });
    },
  );
}

// Re-exported helpers used by other tool modules.
export const _internal = { textResult, errorResult };
export { textResult, errorResult };

// Validation helpers used by read.ts / write.ts.
export const NonEmptyString = z.string().min(1);
