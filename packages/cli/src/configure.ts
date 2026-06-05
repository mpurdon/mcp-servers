import * as p from "@clack/prompts";
import { HOSTS, getHost, type HostId } from "./hosts.js";
import { SERVERS, type ServerDef } from "./registry.js";
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
  const entry: McpServerEntry = {
    command: "npx",
    args: ["-y", server.packageName],
  };
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

export async function configure(opts: { dryRun: boolean }): Promise<void> {
  p.intro("@mpurdon/mcp-servers configure");

  // 1. Pick a host (default to a detected one).
  const detected = HOSTS.find((h) => h.id !== "cowork" && h.detect());
  const hostId = ensure(
    await p.select<HostId>({
      message: "Which Claude host do you want to configure?",
      initialValue: detected?.id ?? "desktop",
      options: HOSTS.map((h) => ({
        value: h.id,
        label: h.title,
        hint: h.id !== "cowork" && h.detect() ? "detected" : undefined,
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

  // 2. Pick servers.
  const chosen = ensure(
    await p.multiselect<string>({
      message: "Which servers do you want to enable?",
      required: true,
      options: SERVERS.map((s) => ({
        value: s.key,
        label: s.title,
        hint: s.description,
      })),
    }),
  );

  // 3. Collect env per server.
  const desired: Record<string, McpServerEntry> = {};
  const notes: string[] = [];
  for (const key of chosen) {
    const server = SERVERS.find((s) => s.key === key)!;
    const env: Record<string, string> = {};
    for (const v of server.env) {
      const value = v.secret
        ? ensure(
            await p.password({
              message: `${server.title} — ${v.label}${v.required ? "" : " (optional)"}`,
              validate: (val) => (v.required && !val ? "Required." : undefined),
            }),
          )
        : ensure(
            await p.text({
              message: `${server.title} — ${v.label}${v.required ? "" : " (optional)"}`,
              placeholder: v.default ?? "",
              defaultValue: v.default ?? "",
              validate: (val) => (v.required && !val ? "Required." : undefined),
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
