import * as p from "@clack/prompts";
import { HOSTS, getHost, type HostId } from "./hosts.js";
import { BUILTIN_SERVERS, type ServerDef } from "./registry.js";
import { allServers } from "./discovery.js";
import {
  readConfig,
  planChanges,
  applyChanges,
  writeConfig,
  renderPlan,
  type McpServerEntry,
} from "./config-file.js";

function bail(message = "Cancelled."): never {
  p.cancel(message);
  process.exit(1);
}

function ensure<T>(value: T | symbol): T {
  if (p.isCancel(value)) bail();
  return value as T;
}

function entryFor(
  server: ServerDef,
  env: Record<string, string>,
): McpServerEntry {
  // Local/private servers carry an explicit launch command (e.g. a built dist
  // on disk); public servers run from npm via npx.
  const entry: McpServerEntry =
    server.source === "local"
      ? { command: server.launch.command, args: [...server.launch.args] }
      : { command: "npx", args: ["-y", server.packageName] };
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

export async function configure(opts: { dryRun: boolean }): Promise<void> {
  p.intro("@mpurdon/mcp-servers configure");

  // 1. Pick a host (default to a detected one). Detect once — each detect()
  //    may hit the filesystem, so don't call it twice per host.
  const detectedIds = new Set(
    HOSTS.filter((h) => h.id !== "cowork" && h.detect()).map((h) => h.id),
  );
  const hostId = ensure(
    await p.select<HostId>({
      message: "Which Claude host do you want to configure?",
      initialValue: [...detectedIds][0] ?? "desktop",
      options: HOSTS.map((h) => ({
        value: h.id,
        label: h.title,
        hint: detectedIds.has(h.id) ? "detected" : undefined,
      })),
    }),
  );
  const host = getHost(hostId);

  // Resolve the target config path (Cowork needs a workspace dir).
  let workspaceDir: string | undefined;
  if (hostId === "cowork") {
    workspaceDir = ensure(
      await p.text({
        message: "Path to the Cowork workspace (its .mcp.json lives here):",
        placeholder: process.cwd(),
        defaultValue: process.cwd(),
      }),
    );
  }
  const targetPath = host.resolvePath({ workspaceDir });
  if (!targetPath) bail("Could not determine the config file path.");

  // 2. Pick servers — built-in public servers plus any locally-registered
  //    private servers discovered under ~/.mpurdon-mcp/servers.d/.
  const servers = allServers(BUILTIN_SERVERS);
  const chosen = ensure(
    await p.multiselect<string>({
      message: "Which servers do you want to enable?",
      required: true,
      options: servers.map((s) => ({
        value: s.key,
        label: s.source === "local" ? `${s.title} (private)` : s.title,
        hint: s.description,
      })),
    }),
  );

  // 3. Collect env per server.
  const desired: Record<string, McpServerEntry> = {};
  const notes: string[] = [];
  for (const key of chosen) {
    const server = servers.find((s) => s.key === key)!;
    const env: Record<string, string> = {};
    for (const v of server.env) {
      const message = `${server.title} — ${v.label}${v.required ? "" : " (optional)"}`;
      const validate = (val: string | undefined) =>
        v.required && !val ? "Required." : undefined;
      const value = ensure(
        v.secret
          ? await p.password({ message, validate })
          : await p.text({
              message,
              placeholder: v.default ?? "",
              defaultValue: v.default ?? "",
              validate,
            }),
      );
      if (value) env[v.key] = value;
    }
    desired[key] = entryFor(server, env);

    if (server.configFile)
      notes.push(`[${server.key}] ${server.configFile.note}`);
    if (server.setupNote) notes.push(`[${server.key}] ${server.setupNote}`);
  }

  // 4. Plan and show the diff.
  const config = readConfig(targetPath);
  const changes = planChanges(config, desired);
  p.note(renderPlan(targetPath, changes), "Planned changes");

  const overwrites = changes.filter((c) => c.action === "update");
  if (overwrites.length > 0) {
    p.log.warn(
      `This will overwrite existing entries: ${overwrites.map((c) => c.key).join(", ")}`,
    );
  }

  if (opts.dryRun) {
    p.outro("Dry run — no files were modified.");
    return;
  }

  const proceed = ensure(
    await p.confirm({ message: `Write these changes to ${targetPath}?` }),
  );
  if (!proceed) bail("No changes written.");

  // 5. Apply.
  applyChanges(config, desired);
  writeConfig(targetPath, config);
  p.log.success(`Updated ${targetPath}`);

  if (notes.length > 0) {
    p.note(notes.join("\n\n"), "Follow-up steps");
  }
  p.outro(
    `Done. Restart ${host.title} so it picks up the new server${chosen.length > 1 ? "s" : ""}.`,
  );
}
