import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  ConfigError,
  describeEnvironment,
  loadConfig,
  resolveOutputDir,
} from "../config.js";
import type { ClientManager } from "../connection.js";
import { classifyAwsError, listAvailableProfiles } from "../aws-errors.js";
import {
  EnvArg,
  errorResult,
  resolveEnv,
  textResult,
  toToolError,
} from "./shared.js";

export function registerEnvironmentTools(
  server: McpServer,
  mgr: ClientManager,
): void {
  server.tool(
    "list_environments",
    "List the configured AWS environments (dev/stg/prd), their profiles, regions, and named log-group targets. Call this first when the user has not said which environment they mean.",
    {},
    async () => {
      const config = mgr.getConfig();
      return textResult({
        environments: Object.keys(config.environments).map((env) =>
          describeEnvironment(config, env),
        ),
        defaultEnvironment: config.defaultEnvironment,
        asksBeforeUsingDefault: !config.assumeDefaultEnvironment,
        outputDir: resolveOutputDir(config),
        awsProfilesOnThisMachine: listAvailableProfiles(),
      });
    },
  );

  server.tool(
    "check_credentials",
    "Verify that an environment's AWS profile resolves, whose identity it maps to, and whether CloudWatch Logs is actually readable. Run this when a search fails with a permissions or credentials error.",
    { env: EnvArg },
    async ({ env }) => {
      const resolved = resolveEnv(mgr, env);
      if (!resolved.ok) return textResult(resolved.payload);

      const envCfg = mgr.getEffective(resolved.env);

      // Step 1: can the credential chain produce credentials at all?
      const probe = await mgr.probeCredentials(resolved.env);
      if (!probe.ok) {
        return errorResult({
          env: resolved.env,
          profile: envCfg.profile,
          region: envCfg.region,
          credentialsResolved: false,
          error: probe.failure.kind,
          code: probe.failure.code,
          message: probe.failure.message,
          remediation: probe.failure.remediation,
        });
      }

      // Step 2: are they valid according to AWS?
      let identity;
      try {
        identity = await mgr.getCallerIdentity(resolved.env, true);
      } catch (err) {
        return toToolError(err, mgr, resolved.env, "sts:GetCallerIdentity");
      }

      // Step 3: separate "bad credentials" from "good credentials, no Logs access".
      let logsReadable = false;
      let logsError: Record<string, unknown> | undefined;
      try {
        await mgr
          .getLogsClient(resolved.env)
          .send(new DescribeLogGroupsCommand({ limit: 1 }));
        logsReadable = true;
      } catch (err) {
        const failure = classifyAwsError(err, {
          env: resolved.env,
          profile: envCfg.profile,
          region: envCfg.region,
          operation: "logs:DescribeLogGroups",
        });
        logsError = {
          error: failure.kind,
          code: failure.code,
          message: failure.message,
          remediation: failure.remediation,
        };
      }

      return textResult({
        env: resolved.env,
        profile: envCfg.profile,
        region: envCfg.region,
        credentialsResolved: true,
        credentialSource: probe.source,
        expiresAt: probe.expiration,
        identity,
        cloudWatchLogsReadable: logsReadable,
        cloudWatchLogsError: logsError,
      });
    },
  );

  server.tool(
    "reload_config",
    "Re-read ~/.aws-logs-mcp/config.json without restarting the host. Use after adding an environment, target, or log group.",
    {},
    async () => {
      let next;
      try {
        next = loadConfig();
      } catch (err) {
        return errorResult({
          error: "configError",
          message:
            err instanceof ConfigError
              ? err.message
              : `Failed to read config: ${(err as Error).message}`,
        });
      }

      mgr.reloadConfig(next);
      return textResult({
        reloaded: true,
        environments: Object.keys(next.environments).map((env) =>
          describeEnvironment(next, env),
        ),
        outputDir: resolveOutputDir(next),
      });
    },
  );
}
