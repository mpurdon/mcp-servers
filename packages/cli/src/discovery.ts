import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerDef, EnvVar } from "./registry.js";

/**
 * Directory where private/local MCP servers drop a descriptor so the public
 * configure CLI can offer them alongside the built-in public servers. Each
 * file is `<key>.json` describing one server. This keeps proprietary details
 * entirely on the user's machine — the public CLI ships no knowledge of them.
 */
export const SERVERS_DIR = join(homedir(), ".mpurdon-mcp", "servers.d");

/** Shape of a descriptor file written by a private server's `register` step. */
interface ServerDescriptor {
  key: string;
  title: string;
  description: string;
  launch: { command: string; args: string[] };
  env?: EnvVar[];
  configFile?: { relativePath: string; note: string };
  setupNote?: string;
}

function isValidDescriptor(d: unknown): d is ServerDescriptor {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    typeof o.title === "string" &&
    typeof o.description === "string" &&
    !!o.launch &&
    typeof o.launch === "object" &&
    typeof (o.launch as Record<string, unknown>).command === "string" &&
    Array.isArray((o.launch as Record<string, unknown>).args)
  );
}

/**
 * Read all locally-registered private server descriptors. Returns ServerDefs
 * tagged `source: "local"`. Invalid/unreadable files are skipped with a warning
 * to stderr rather than aborting the whole run.
 */
export function discoverLocalServers(): ServerDef[] {
  if (!existsSync(SERVERS_DIR)) return [];
  const out: ServerDef[] = [];
  for (const file of readdirSync(SERVERS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const path = join(SERVERS_DIR, file);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!isValidDescriptor(parsed)) {
        process.stderr.write(
          `[mcp-servers] skipping invalid descriptor: ${path}\n`,
        );
        continue;
      }
      out.push({
        key: parsed.key,
        title: parsed.title,
        description: parsed.description,
        launch: parsed.launch,
        env: parsed.env ?? [],
        configFile: parsed.configFile,
        setupNote: parsed.setupNote,
        source: "local",
      });
    } catch (err) {
      process.stderr.write(
        `[mcp-servers] could not read descriptor ${path}: ${(err as Error).message}\n`,
      );
    }
  }
  return out;
}

/**
 * Merge built-in public servers with discovered local ones. Local descriptors
 * win on key collision (lets you override a public server with a local build).
 */
export function allServers(builtin: ServerDef[]): ServerDef[] {
  const local = discoverLocalServers();
  const byKey = new Map<string, ServerDef>();
  for (const s of builtin) byKey.set(s.key, s);
  for (const s of local) byKey.set(s.key, s);
  return [...byKey.values()];
}
