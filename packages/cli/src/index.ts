#!/usr/bin/env node
import { configure } from "./configure.js";
import { BUILTIN_SERVERS } from "./registry.js";
import { allServers } from "./discovery.js";

const HELP = `@mpurdon/mcp-servers — install & configure @mpurdon MCP servers

Usage:
  npx @mpurdon/mcp-servers configure [--dry-run]
  npx @mpurdon/mcp-servers list
  npx @mpurdon/mcp-servers --help

Commands:
  configure    Interactively register servers into Claude Desktop, Code, or Cowork.
  list         Print the available servers.

Options:
  --dry-run    Show the planned config changes without writing anything.
  -h, --help   Show this help.
`;

function list(): void {
  for (const s of allServers(BUILTIN_SERVERS)) {
    const origin = s.source === "local" ? "(private, local)" : s.packageName;
    process.stdout.write(`${s.key.padEnd(12)} ${origin}\n`);
    process.stdout.write(`${" ".repeat(12)} ${s.description}\n`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const command = argv[0];
  switch (command) {
    case "configure":
      await configure({ dryRun: argv.includes("--dry-run") });
      break;
    case "list":
      list();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp-servers] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
