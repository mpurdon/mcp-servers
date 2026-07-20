# @mpurdon MCP servers

A monorepo of custom [Model Context Protocol](https://modelcontextprotocol.io)
servers, each independently installable and built to a shared standard that works
across **Claude Desktop**, **Claude Cowork**, and **Claude Code**.

All servers are **stdio** servers, written in TypeScript, validated with zod, and
follow the conventions in [`CONVENTIONS.md`](./CONVENTIONS.md) (stderr-only
logging, secrets never returned over the wire, startup config validation,
destructive-operation confirmation gates, graceful shutdown).

## Servers

| Package                                            | Install                          | What it does                                                              |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| [`@mpurdon/mcp-mongodb`](./packages/mongodb)       | `npx -y @mpurdon/mcp-mongodb`    | Query/manage MongoDB across dev/stg/prd with production write-protection. |
| [`@mpurdon/mcp-sumologic`](./packages/sumologic)   | `npx -y @mpurdon/mcp-sumologic`  | Run Sumo Logic searches and inspect results.                              |
| [`@mpurdon/mcp-freshbooks`](./packages/freshbooks) | `npx -y @mpurdon/mcp-freshbooks` | FreshBooks invoice & client operations.                                   |
| [`@mpurdon/mcp-github`](./packages/github)         | `npx -y @mpurdon/mcp-github`     | GitHub repo/issue/PR operations.                                          |
| [`@mpurdon/mcp-milo`](./packages/milo)             | `npx -y @mpurdon/mcp-milo`       | Query the Milo MySQL database.                                            |
| [`@mpurdon/mcp-aws-logs`](./packages/aws-logs)     | `npx -y @mpurdon/mcp-aws-logs`   | Search & aggregate AWS CloudWatch Logs across dev/stg/prd.                |

## Install

The fastest path is the interactive configurator, which detects your installed
Claude hosts and writes the right config file for each:

```bash
npx @mpurdon/mcp-servers configure
```

It will let you pick a host (Desktop / Cowork / Code), choose which servers to
enable, collect required credentials, and register them — idempotently, with a
`--dry-run` flag to preview the change first.

### Public and private servers

This repo holds the **public** servers (published to npm). Proprietary or
work-specific servers live in their own **private** repos — their code never
enters this public repo. A private server registers itself locally by writing a
descriptor to `~/.mpurdon-mcp/servers.d/<key>.json` (each private repo ships a
`*-register` command for this). The configurator **auto-discovers** those and
offers them in the same selectable list as the public servers (marked
`(private)`), launching them from their local path instead of npm. One install
experience spans both tiers.

### Manual registration

Every host uses the same `mcpServers` schema. Add an entry like:

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

into the host's config file:

- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **Claude Code** — `~/.claude.json` (user) or a project `.mcp.json`
- **Claude Cowork** — the workspace's `.mcp.json`

See each package's README for its required environment variables / config file.

## Development

```bash
pnpm install        # install all workspaces
pnpm build          # turbo build every package
pnpm typecheck      # tsc --noEmit across packages
pnpm lint           # eslint across packages
pnpm test           # run package tests
```

This repo uses **pnpm workspaces + Turborepo**, **Conventional Commits**
(enforced via commitlint + husky), and **Changesets** for versioning and
publishing. Each PR touching a package under `packages/` must include a
changeset (`pnpm changeset`).

## License

[MIT](./LICENSE) © Matthew Purdon
