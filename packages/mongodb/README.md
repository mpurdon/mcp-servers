# @mpurdon/mcp-mongodb

A local **stdio** MCP server that lets Claude query and manage MongoDB across `dev` / `stg` / `prd` environments, with a safety gate on write operations in production.

- Three named environments selectable at runtime (`switch_environment`)
- Read tools (`find`, `aggregate`, `count`, `list_*`) work in every environment
- Write tools (`insert_*`, `update_*`, `delete_*`) require `confirmed: true` when the active environment is `prd`
- `drop_collection` requires `confirmed: true` in **every** environment
- Connection strings are never returned over the wire — only hostnames

---

## Install

```bash
npx -y @mpurdon/mcp-mongodb   # downloads & runs the latest published build
```

No global install needed — the host (Claude Desktop / Cowork / Code) runs it via
`npx` per session. The fastest way to register it is the monorepo configurator:

```bash
npx @mpurdon/mcp-servers configure
```

…or configure it manually with the steps below.

## Setup

### 1. Create the config file

The server reads `~/.mongodb-mcp/config.json`. Create it with your real connection strings:

```bash
mkdir -p ~/.mongodb-mcp
cat > ~/.mongodb-mcp/config.json <<'EOF'
{
  "defaultEnvironment": "dev",
  "environments": {
    "dev": { "connectionString": "mongodb://localhost:27017", "name": "Development" },
    "stg": { "connectionString": "mongodb://user:pass@staging-host:27017/?authSource=admin", "name": "Staging" },
    "prd": { "connectionString": "mongodb://user:pass@prod-host:27017/?authSource=admin", "name": "Production" }
  }
}
EOF
chmod 600 ~/.mongodb-mcp/config.json
```

> The file contains credentials. `chmod 600` ensures only your user can read it.

### 2. Register with your Claude host

Add this to your host's MCP config (or let `npx @mpurdon/mcp-servers configure` do it):

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "@mpurdon/mcp-mongodb"],
      "env": {}
    }
  }
}
```

Config file location per host:

- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Claude Code** — `~/.claude.json` (user) or a project `.mcp.json`
- **Claude Cowork** — the workspace's `.mcp.json`

Restart the host.

### 3. Verify

Ask: _"What MongoDB environment am I connected to?"_ — Claude should call `current_environment` and return the active env, display name, host, and whether writes are restricted.

---

## Tool reference

### Environment

| Tool                      | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `switch_environment(env)` | Reconnect to `dev`, `stg`, or `prd`.                           |
| `current_environment()`   | Return active env, display name, host, write-restriction flag. |

### Read (unrestricted)

| Tool                                                              | Description                                |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `list_databases()`                                                | List all databases.                        |
| `list_collections(database)`                                      | List collections in a db.                  |
| `find(database, collection, filter?, projection?, limit?, sort?)` | Query docs. Default `limit=20`, max `500`. |
| `aggregate(database, collection, pipeline)`                       | Run a pipeline. Capped at 500 results.     |
| `count(database, collection, filter?)`                            | Count matching docs.                       |

### Write (require `confirmed: true` in `prd`)

- `insert_one(database, collection, document)`
- `insert_many(database, collection, documents)`
- `update_one(database, collection, filter, update, upsert?)`
- `update_many(database, collection, filter, update)`
- `delete_one(database, collection, filter)`
- `delete_many(database, collection, filter)`

When called in `prd` without `confirmed: true`, the server returns a structured `confirmationRequired` payload describing the planned execution. Re-invoke the same tool with `confirmed: true` to actually run it.

### Always-confirm

- `drop_collection(database, collection)` — requires `confirmed: true` in **every** environment.

---

## Security notes

- **No credentials in responses.** Status responses include only the host (`host:port`), never the username/password or full URI.
- **Config file permissions.** Use `chmod 600 ~/.mongodb-mcp/config.json`.
- **Stdio only.** No TCP socket is opened; the server only accepts MCP traffic from its stdin (Claude Desktop spawns it per session).
- **Input validation.** All tool parameters are validated with Zod before any MongoDB call.
- **Production gate.** Writes in `prd` are rejected unless the caller explicitly opts in with `confirmed: true`. `drop_collection` is gated in every environment.

---

## Development

From the monorepo root:

```bash
pnpm --filter @mpurdon/mcp-mongodb dev        # run from source (tsx)
pnpm --filter @mpurdon/mcp-mongodb typecheck  # type-check only
pnpm --filter @mpurdon/mcp-mongodb build      # build to dist/
```

### Project layout

```
src/
  index.ts            # server entry — loads config, wires transport
  config.ts           # config schema + safe host extraction
  connection.ts       # singleton MongoClient manager
  tools/
    environment.ts    # switch_environment, current_environment
    read.ts           # list_databases, list_collections, find, aggregate, count
    write.ts          # insert/update/delete/drop with prod confirmation guard
```
