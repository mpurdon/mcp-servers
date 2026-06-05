import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type HostId = "desktop" | "code" | "cowork";

export interface HostDef {
  id: HostId;
  title: string;
  /**
   * Resolve the MCP config file path for this host. Returns null when the path
   * cannot be determined without more input (Cowork needs a workspace dir).
   */
  resolvePath: (opts: { workspaceDir?: string }) => string | null;
  /** True when this host appears installed (its config dir/file exists). */
  detect: () => boolean;
}

function desktopConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
    case "win32":
      return join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    default:
      // Linux / others
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

export const HOSTS: HostDef[] = [
  {
    id: "desktop",
    title: "Claude Desktop",
    resolvePath: () => desktopConfigPath(),
    detect: () => {
      const p = desktopConfigPath();
      // The parent dir existing is a good signal even before any MCP is added.
      return existsSync(p) || existsSync(join(p, ".."));
    },
  },
  {
    id: "code",
    title: "Claude Code",
    resolvePath: () => join(homedir(), ".claude.json"),
    detect: () => existsSync(join(homedir(), ".claude.json")),
  },
  {
    id: "cowork",
    title: "Claude Cowork (workspace .mcp.json)",
    resolvePath: ({ workspaceDir }) =>
      workspaceDir ? join(workspaceDir, ".mcp.json") : null,
    detect: () => true, // always selectable; path is prompted
  },
];

export function getHost(id: HostId): HostDef {
  const host = HOSTS.find((h) => h.id === id);
  if (!host) throw new Error(`Unknown host: ${id}`);
  return host;
}
