import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface PlannedChange {
  key: string;
  action: "add" | "update" | "unchanged";
  entry: McpServerEntry;
}

/** Read and parse an MCP config file, tolerating a missing or empty file. */
export function readConfig(path: string): McpConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as McpConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new Error(
      `Existing config at ${path} is not valid JSON (${(err as Error).message}). ` +
        "Fix or remove it before re-running.",
      { cause: err },
    );
  }
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compute what would change, without mutating anything. */
export function planChanges(
  config: McpConfig,
  desired: Record<string, McpServerEntry>,
): PlannedChange[] {
  const existing = config.mcpServers ?? {};
  return Object.entries(desired).map(([key, entry]) => {
    const prev = existing[key];
    let action: PlannedChange["action"];
    if (!prev) action = "add";
    else if (entriesEqual(prev, entry)) action = "unchanged";
    else action = "update";
    return { key, action, entry };
  });
}

/** Apply desired entries into the config object (in place) and return it. */
export function applyChanges(
  config: McpConfig,
  desired: Record<string, McpServerEntry>,
): McpConfig {
  config.mcpServers = { ...(config.mcpServers ?? {}), ...desired };
  return config;
}

/** Serialize and write the config, creating parent dirs as needed. */
export function writeConfig(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** A human-readable diff of planned changes for --dry-run and confirmations. */
export function renderPlan(path: string, changes: PlannedChange[]): string {
  const lines = [`Target: ${path}`, ""];
  for (const c of changes) {
    const marker = c.action === "add" ? "+" : c.action === "update" ? "~" : "=";
    lines.push(`  ${marker} ${c.key}  (${c.action})`);
    const envKeys = Object.keys(c.entry.env ?? {});
    const envDesc =
      envKeys.length > 0 ? `, env: ${envKeys.join(", ")}` : ", env: (none)";
    lines.push(`      ${c.entry.command} ${c.entry.args.join(" ")}${envDesc}`);
  }
  return lines.join("\n");
}
