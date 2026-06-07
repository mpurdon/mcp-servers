import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerDef, LocalServer, EnvVar } from "./registry.js";

/**
 * Directory where private/local MCP servers drop a descriptor so the public
 * configure CLI can offer them alongside the built-in public servers. Each
 * file is `<key>.json` describing one server. This keeps proprietary details
 * entirely on the user's machine — the public CLI ships no knowledge of them.
 */
export const SERVERS_DIR = join(homedir(), ".mpurdon-mcp", "servers.d");

/**
 * Descriptor schema version. A private server's `register` step writes this so
 * the CLI can reject descriptors written against an incompatible future format.
 */
export const DESCRIPTOR_VERSION = 1;

/**
 * Shape of a descriptor file written by a private server's `register` step.
 * It is a {@link LocalServer} (minus the `source` tag the CLI adds) plus a
 * schema `version`. Deriving it from LocalServer keeps the contract in one
 * place — new server fields flow through automatically.
 */
export type ServerDescriptor = Omit<LocalServer, "source" | "env"> & {
  version: number;
  env?: EnvVar[];
};

function isValidDescriptor(d: unknown): d is ServerDescriptor {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  const launch = o.launch as Record<string, unknown> | undefined;
  return (
    o.version === DESCRIPTOR_VERSION &&
    typeof o.key === "string" &&
    typeof o.title === "string" &&
    typeof o.description === "string" &&
    !!launch &&
    typeof launch.command === "string" &&
    Array.isArray(launch.args)
  );
}

/**
 * Read all locally-registered private server descriptors. Returns ServerDefs
 * tagged `source: "local"`. Invalid/unreadable files are skipped with a warning
 * to stderr rather than aborting the whole run.
 */
export function discoverLocalServers(): LocalServer[] {
  if (!existsSync(SERVERS_DIR)) return [];
  const out: LocalServer[] = [];
  for (const file of readdirSync(SERVERS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const path = join(SERVERS_DIR, file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isValidDescriptor(parsed)) {
        process.stderr.write(
          `[mcp-servers] skipping invalid descriptor: ${path}\n`,
        );
        continue;
      }
      const { version: _version, env, ...rest } = parsed;
      out.push({ ...rest, env: env ?? [], source: "local" });
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
  const byKey = new Map<string, ServerDef>();
  for (const s of [...builtin, ...discoverLocalServers()]) {
    byKey.set(s.key, s);
  }
  return [...byKey.values()];
}
