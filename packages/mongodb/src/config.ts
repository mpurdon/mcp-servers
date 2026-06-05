import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_PATH = join(homedir(), ".mongodb-mcp", "config.json");

export const EnvKey = z.enum(["dev", "stg", "prd"]);
export type EnvKey = z.infer<typeof EnvKey>;

const EnvironmentSchema = z
  .object({
    connectionString: z.string().min(1, "connectionString is required"),
    name: z.string().min(1, "name is required"),
  })
  .strict();

export const ConfigSchema = z
  .object({
    defaultEnvironment: EnvKey,
    environments: z
      .object({
        dev: EnvironmentSchema,
        stg: EnvironmentSchema,
        prd: EnvironmentSchema,
      })
      .strict(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SAMPLE_CONFIG = `{
  "defaultEnvironment": "dev",
  "environments": {
    "dev": { "connectionString": "mongodb://localhost:27017", "name": "Development" },
    "stg": { "connectionString": "mongodb://user:pass@staging-host:27017/?authSource=admin", "name": "Staging" },
    "prd": { "connectionString": "mongodb://user:pass@prod-host:27017/?authSource=admin", "name": "Production" }
  }
}`;

export function loadConfig(path: string = CONFIG_PATH): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `MongoDB MCP config file not found at ${path}.\n\n` +
        `Create it with the following contents (fill in real connection strings):\n\n` +
        `mkdir -p "$(dirname '${path}')"\n` +
        `cat > '${path}' <<'EOF'\n${SAMPLE_CONFIG}\nEOF\n`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Failed to read config at ${path}: ${(err as Error).message}`,
    );
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

/**
 * Extract a non-sensitive host descriptor from a MongoDB connection string.
 * Never returns credentials or the full URI.
 */
export function safeHostFromUri(uri: string): string {
  try {
    // mongodb:// and mongodb+srv:// are URL-parseable by WHATWG URL.
    const u = new URL(uri);
    // u.host includes hostname[:port]; strip credentials by construction (URL exposes them in u.username/u.password).
    return u.host || "(unknown host)";
  } catch {
    return "(unparseable host)";
  }
}
