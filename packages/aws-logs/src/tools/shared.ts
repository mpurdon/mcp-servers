import { z } from "zod";
import type { ClientManager } from "../connection.js";
import { classifyAwsError } from "../aws-errors.js";
import { TimeRangeError } from "../time.js";

export const textResult = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

export const errorResult = (obj: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

export const EnvArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Environment key from ~/.aws-logs-mcp/config.json (e.g. dev, stg, prd). " +
      "If omitted, the server returns the list of environments and asks you to pick one — " +
      "ask the user which environment they mean rather than guessing.",
  );

/**
 * Resolve the environment for a call. Deliberately refuses to guess: the whole
 * point is that the assistant asks "dev, stg, or prd?" before touching an
 * account, since the same search against prd has real cost and real blast
 * radius. Set assumeDefaultEnvironment in config to opt out.
 */
export type EnvResolution =
  | { ok: true; env: string }
  | { ok: false; payload: Record<string, unknown> };

export function resolveEnv(mgr: ClientManager, env?: string): EnvResolution {
  const config = mgr.getConfig();
  const choices = Object.keys(config.environments).map((key) => {
    const e = mgr.getEffective(key);
    return {
      env: key,
      name: e.name,
      profile: e.profile,
      region: e.region,
      accountId: e.accountId,
      targets: Object.keys(e.targets),
    };
  });

  if (env) {
    if (!mgr.hasEnvironment(env)) {
      return {
        ok: false,
        payload: {
          error: "unknownEnvironment",
          message: `'${env}' is not a configured environment.`,
          availableEnvironments: choices,
        },
      };
    }
    return { ok: true, env };
  }

  if (config.assumeDefaultEnvironment && config.defaultEnvironment) {
    return { ok: true, env: config.defaultEnvironment };
  }

  return {
    ok: false,
    payload: {
      environmentRequired: true,
      message:
        "Which environment should this run against? Ask the user to choose one of the " +
        "environments below, then call this tool again with `env` set.",
      availableEnvironments: choices,
      suggestedDefault: config.defaultEnvironment,
    },
  };
}

/** Turn any thrown value into a structured, actionable tool error. */
export function toToolError(
  err: unknown,
  mgr: ClientManager,
  env: string | undefined,
  operation: string,
): ReturnType<typeof errorResult> {
  if (err instanceof TimeRangeError) {
    return errorResult({
      error: "invalidTimeRange",
      message: err.message,
      remediation:
        "Use 'now', a relative offset like '-2h', or an ISO-8601 timestamp for from/to.",
    });
  }

  const envCfg =
    env && mgr.hasEnvironment(env) ? mgr.getEffective(env) : undefined;
  const failure = classifyAwsError(err, {
    env,
    profile: envCfg?.profile,
    region: envCfg?.region,
    operation,
  });

  // A plain Error we threw ourselves (bad target name, no log groups, etc.)
  // classifies as "unknown"; surface its message rather than a generic hint.
  if (failure.kind === "unknown" && err instanceof Error) {
    return errorResult({
      error: "requestFailed",
      operation,
      message: err.message,
    });
  }

  return errorResult({
    error: failure.kind,
    code: failure.code,
    operation,
    message: failure.message,
    remediation: failure.remediation,
    retryable: failure.retryable,
  });
}
