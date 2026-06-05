# @mpurdon/mcp-github

A local **stdio** MCP server for GitHub, focused on org/repo triage and
pull-request review workflows via the GitHub REST API.

Tools: `list_my_orgs`, `list_org_repos`, `get_org_recent_prs`, `get_pr_for_review`,
`get_pr_ci_failures`, `get_security_prs`, `get_deployment_environments`,
`search_issues`, `list_workflow_runs`, `get_workflow_run`, `create_issue_comment`.

## Install

```bash
npx -y @mpurdon/mcp-github
```

Or register it interactively with `npx @mpurdon/mcp-servers configure`.

## Configuration

| Variable       | Required | Description                                                                                                                                                      |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | yes      | A GitHub personal access token (classic or fine-grained) with the scopes needed for the repos/orgs you want to query (typically `repo`, `read:org`, `workflow`). |

Create one at <https://github.com/settings/tokens>. The token is only ever sent
in the `Authorization` header — it is never returned in tool results or errors.

## Register with your Claude host

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@mpurdon/mcp-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
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

- The token is read from env only and never crosses the MCP wire.
- stdio only: the server opens no network listener of its own.
