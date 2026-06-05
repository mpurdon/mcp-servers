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

## Public and private servers

The configurator offers two tiers in one selectable list:

- **Public servers** — the npm-published `@mpurdon/mcp-*` packages, launched via `npx`.
- **Private/local servers** — proprietary or work-specific servers whose code lives
  in a separate private repo. They register themselves by dropping a descriptor in
  `~/.mpurdon-mcp/servers.d/<key>.json` (each private repo provides its own
  `*-register` command). The configurator auto-discovers these and launches them by
  their local path. No proprietary detail ever lives in this public repo — only the
  descriptor on your machine.

So `configure` shows everything you have installed — public and private — as one list,
marking private ones `(private)`.

## What it does

1. **Detects** your installed Claude host(s) and lets you choose one.
2. Lets you **multi-select** which servers to enable (public + discovered private).
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
