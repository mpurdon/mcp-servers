# @mpurdon/mcp-servers

The installer/configurator for the [@mpurdon MCP servers](https://github.com/mpurdon/mcp-servers).
It registers any combination of the servers into **Claude Desktop**, **Claude Code**,
or a **Claude Cowork** workspace — writing the right config file, idempotently.

## Usage

```bash
# interactive: pick a host, pick servers, enter credentials, write config
npx @mpurdon/mcp-servers configure

# preview the exact changes without writing anything
npx @mpurdon/mcp-servers configure --dry-run

# list available servers
npx @mpurdon/mcp-servers list
```

## What it does

1. **Detects** your installed Claude host(s) and lets you choose one.
2. Lets you **multi-select** which servers to enable.
3. **Prompts** for each server's required credentials (secrets are masked) — sourced
   from the server registry, so the prompts always match what each server needs.
4. **Merges** the entries into the host's `mcpServers` config without clobbering
   anything else in the file. Re-running is safe (idempotent); existing entries
   are only touched if they differ, and you're warned before any overwrite.
5. Prints **follow-up steps** for servers that need extra setup (e.g. the FreshBooks
   OAuth flow, or the MongoDB config file).

## Config locations

| Host                     | File                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| Claude Desktop (macOS)   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Claude Desktop (Linux)   | `~/.config/Claude/claude_desktop_config.json`                     |
| Claude Code              | `~/.claude.json`                                                  |
| Claude Cowork            | `<workspace>/.mcp.json`                                           |

After configuring, restart the host so it picks up the new servers.
