import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveRegion } from "./aws-profiles.js";

export const CONFIG_PATH = join(homedir(), ".aws-logs-mcp", "config.json");

/**
 * A named collection of log groups, e.g. "OLP" -> the API lambda + the worker
 * service. Targets are what let a user say "search OLP logs" without naming
 * every log group.
 */
const TargetSchema = z
  .object({
    logGroups: z
      .array(z.string().min(1))
      .min(1, "a target needs at least one log group"),
    description: z.string().optional(),
    /**
     * Default lookback for this target when the caller gives no time range,
     * e.g. "1h". Overrides the server-wide default. Useful for chatty targets
     * where a 24h scan would be needlessly expensive.
     */
    defaultLookback: z.string().optional(),
    /** Extra Logs Insights fields to project alongside the standard ones. */
    fields: z.array(z.string().min(1)).optional(),
  })
  .strict();

const EnvironmentSchema = z
  .object({
    /** Named profile from ~/.aws/config or ~/.aws/credentials. */
    profile: z.string().min(1, "profile is required"),
    /**
     * Optional. When omitted the region is read from the profile itself, then
     * from regionDefaults. Credential tools (Leapp, aws sso) already write the
     * region into the profile, so repeating it here just invites drift.
     */
    region: z.string().min(1).optional(),
    /**
     * Expected 12-digit AWS account for this environment.
     *
     * Essential when several environments share one profile name — Leapp and
     * similar tools rewrite a single profile's credentials in place as you
     * switch sessions, so the profile alone cannot tell dev from prod. When
     * set, the server verifies the live identity before searching and refuses
     * to run against the wrong account.
     */
    accountId: z
      .string()
      .regex(/^\d{12}$/, "accountId must be a 12-digit AWS account id")
      .optional(),
    /** Human-readable label, e.g. "Production". */
    name: z.string().optional(),
    /** Named log-group sets. Optional — discovery works without them. */
    targets: z.record(z.string(), TargetSchema).default({}),
    /**
     * Default prefix for discover_log_groups in this environment, e.g. "/aws/lambda/olp-".
     * Keeps discovery from paging the entire account.
     */
    logGroupPrefix: z.string().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    /**
     * Used only when assumeDefaultEnvironment is true. Otherwise the server
     * asks which environment to use rather than guessing.
     */
    defaultEnvironment: z.string().optional(),
    /**
     * When false (the default) every environment-scoped tool called without an
     * explicit `env` returns an `environmentRequired` payload so the assistant
     * asks the user first. Set true to silently use defaultEnvironment.
     */
    assumeDefaultEnvironment: z.boolean().default(false),
    /**
     * Fallbacks used when neither the environment nor the profile names a
     * region. `bySsoSession` keys are sso_session names from ~/.aws/config.
     */
    regionDefaults: z
      .object({
        bySsoSession: z.record(z.string(), z.string()).default({}),
        fallback: z.string().min(1).default("us-east-1"),
      })
      .strict()
      .default({ bySsoSession: {}, fallback: "us-east-1" }),
    /** Where result files are written. Defaults to <tmpdir>/aws-logs-mcp. */
    outputDir: z.string().optional(),
    /** Hard ceiling on events returned by a single search. */
    maxResults: z.number().int().positive().max(100_000).default(10_000),
    /** Give up polling a Logs Insights query after this many seconds. */
    queryTimeoutSeconds: z.number().int().positive().max(900).default(120),
    /** Delete result files older than this on startup. 0 disables pruning. */
    resultRetentionHours: z.number().int().min(0).max(720).default(24),
    environments: z.record(z.string(), EnvironmentSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const keys = Object.keys(cfg.environments);
    if (keys.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["environments"],
        message: "at least one environment must be defined",
      });
      return;
    }
    if (cfg.defaultEnvironment && !keys.includes(cfg.defaultEnvironment)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultEnvironment"],
        message: `'${cfg.defaultEnvironment}' is not one of the defined environments (${keys.join(", ")})`,
      });
    }
    if (cfg.assumeDefaultEnvironment && !cfg.defaultEnvironment) {
      ctx.addIssue({
        code: "custom",
        path: ["assumeDefaultEnvironment"],
        message:
          "assumeDefaultEnvironment is true but defaultEnvironment is not set",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;
export type TargetConfig = z.infer<typeof TargetSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SAMPLE_CONFIG = `{
  "defaultEnvironment": "dev",
  "assumeDefaultEnvironment": false,
  "maxResults": 10000,
  "queryTimeoutSeconds": 120,
  "environments": {
    "dev": {
      "profile": "olp-dev",
      "region": "us-east-1",
      "name": "Development",
      "logGroupPrefix": "/aws/lambda/olp-",
      "targets": {
        "OLP": {
          "description": "OLP API + async workers",
          "logGroups": [
            "/aws/lambda/olp-api-dev",
            "/aws/ecs/olp-worker-dev"
          ]
        }
      }
    },
    "stg": {
      "profile": "olp-stg",
      "region": "us-east-1",
      "name": "Staging",
      "targets": {
        "OLP": { "logGroups": ["/aws/lambda/olp-api-stg"] }
      }
    },
    "prd": {
      "profile": "olp-prd",
      "region": "us-east-1",
      "name": "Production",
      "targets": {
        "OLP": { "logGroups": ["/aws/lambda/olp-api-prd"], "defaultLookback": "1h" }
      }
    }
  }
}`;

export function configHelp(path: string): string {
  return (
    `AWS Logs MCP config file not found at ${path}.\n\n` +
    `Create it with the following contents (fill in your real profiles, regions, and log groups):\n\n` +
    `mkdir -p "$(dirname '${path}')"\n` +
    `cat > '${path}' <<'EOF'\n${SAMPLE_CONFIG}\nEOF\n` +
    `chmod 600 '${path}'\n\n` +
    `Profiles are resolved from ~/.aws/config and ~/.aws/credentials — this server\n` +
    `never reads or stores credentials itself.`
  );
}

export function loadConfig(path: string = CONFIG_PATH): Config {
  if (!existsSync(path)) {
    throw new ConfigError(configHelp(path));
  }

  // A directory (or a dangling symlink target) at the config path produces a
  // confusing EISDIR from readFileSync; check first so the message is useful.
  try {
    if (!statSync(path).isFile()) {
      throw new ConfigError(`Config path ${path} exists but is not a file.`);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Failed to stat config at ${path}: ${(err as Error).message}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES") {
      throw new ConfigError(
        `Config at ${path} is not readable by this user (EACCES). Fix with: chmod 600 '${path}'`,
      );
    }
    throw new ConfigError(`Failed to read config at ${path}: ${e.message}`);
  }

  if (raw.trim() === "") {
    throw new ConfigError(`Config at ${path} is empty.\n\n${configHelp(path)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `Config at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config at ${path} failed validation:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`,
    );
  }

  return result.data;
}

export function resolveOutputDir(config: Config): string {
  return config.outputDir ?? join(tmpdir(), "aws-logs-mcp");
}

export function environmentKeys(config: Config): string[] {
  return Object.keys(config.environments);
}

/**
 * Describe an environment without leaking anything sensitive. Profile names
 * and regions are not secrets; credentials are never in this object to begin
 * with, since the SDK resolves them from the shared config files at call time.
 */
export function describeEnvironment(
  config: Config,
  env: string,
): {
  env: string;
  name?: string;
  profile: string;
  region: string;
  regionSource: string;
  accountId?: string;
  targets: { name: string; logGroups: number; description?: string }[];
} {
  const e = config.environments[env];
  const region = resolveRegion(e.profile, e.region, config.regionDefaults);
  return {
    env,
    name: e.name,
    profile: e.profile,
    region: region.region,
    regionSource: region.source,
    accountId: e.accountId,
    targets: Object.entries(e.targets).map(([name, t]) => ({
      name,
      logGroups: t.logGroups.length,
      description: t.description,
    })),
  };
}
