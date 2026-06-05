/**
 * Minimal .env loader — no dependency. Handles `KEY=value` lines, `#` comments,
 * and single/double-quoted values. Never overrides a variable already present in
 * the environment (the MCP client's `env` block always wins).
 *
 * Looks for `.env` in the package root first (so it works regardless of the
 * server's working directory), then falls back to the current directory. The
 * first file found wins.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function candidatePaths(): string[] {
  // Compiled location is dist/freshbooks/dotenv.js — package root is two up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, "..", "..");
  const cwd = process.cwd();
  const out: string[] = [];
  for (const p of [path.join(packageRoot, ".env"), path.join(cwd, ".env")]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export async function loadDotEnv(): Promise<void> {
  for (const envPath of candidatePaths()) {
    let raw: string;
    try {
      raw = await fs.readFile(envPath, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return; // first .env wins
  }
}
