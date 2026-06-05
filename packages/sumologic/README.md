# @mpurdon/mcp-sumologic

A local **stdio** MCP server for the [Sumo Logic](https://www.sumologic.com/)
search API. Start search jobs, poll for results, and (optionally) use a
context-config file that maps friendly application/infrastructure names to source
categories and canned query shortcuts.

- Runs the Sumo Logic search-job lifecycle (create → poll → fetch records/messages)
- Optional `sumologic-context.json` adds environment-aware source discovery and query shortcuts
- stdio only; credentials come from environment variables and are never returned over the wire

## Install

```bash
npx -y @mpurdon/mcp-sumologic
```

Or register it interactively with `npx @mpurdon/mcp-servers configure`.

## Configuration

Set these in the `env` block of your host's MCP config (see below):

| Variable                   | Required | Default                         | Description                                                                                     |
| -------------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SUMOLOGIC_ACCESS_ID`      | yes      | —                               | Sumo Logic access ID.                                                                           |
| `SUMOLOGIC_ACCESS_KEY`     | yes      | —                               | Sumo Logic access key.                                                                          |
| `SUMOLOGIC_API_ENDPOINT`   | no       | `https://api.sumologic.com/api` | Your deployment's API endpoint ([list](https://help.sumologic.com/docs/reuse/api-endpoints/)).  |
| `SUMOLOGIC_CONTEXT_CONFIG` | no       | `./sumologic-context.json`      | Path to an optional context-config JSON. Missing file is fine — the server degrades gracefully. |
| `SUMOLOGIC_DEFAULT_ENV`    | no       | `production`                    | Default environment key used by context-aware tools.                                            |

> Create access keys in Sumo Logic under **Administration → Security → Access Keys**.

## Register with your Claude host

```json
{
  "mcpServers": {
    "sumologic": {
      "command": "npx",
      "args": ["-y", "@mpurdon/mcp-sumologic"],
      "env": {
        "SUMOLOGIC_ACCESS_ID": "...",
        "SUMOLOGIC_ACCESS_KEY": "...",
        "SUMOLOGIC_API_ENDPOINT": "https://api.us2.sumologic.com/api"
      }
    }
  }
}
```

Config file location per host:

- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Claude Code** — `~/.claude.json` (user) or a project `.mcp.json`
- **Claude Cowork** — the workspace's `.mcp.json`

Restart the host.

## Security notes

- Credentials are read from env only and are sent to Sumo Logic via HTTP Basic auth — they are never echoed in tool results or errors.
- stdio only: no network listener is opened by the server itself.
- All tool inputs are validated with zod before any API call.
