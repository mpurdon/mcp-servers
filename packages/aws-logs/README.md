# @mpurdon/mcp-aws-logs

Local stdio MCP server for searching **AWS CloudWatch Logs** across environments,
log groups, and log streams using your named AWS profiles.

Ask _"search OLP logs for id abc123"_ and the assistant asks which environment
(dev/stg/prd), resolves `OLP` to its log groups, runs a Logs Insights query with
a sensible time window, aggregates the hits, writes them to a file on disk, and
hands back the path plus a summary.

## Why it works this way

- **It asks before it acts.** Every tool takes an optional `env`. Omit it and the
  tool returns an `environmentRequired` payload listing your environments instead
  of guessing — a search against `prd` costs real money and reads real customer
  data.
- **Results go to disk, not into the context window.** Full results are written
  as NDJSON; the model gets a path plus a digest.
- **The events are analyzed, not dumped.** Log lines are ~90% boilerplate — the
  same ARNs and account ids on every record. `search_logs` returns an `analysis`
  block that says the constant fields once, tallies the few fields that actually
  vary (message type, level, status), names the high-cardinality identifier
  fields without listing them, and bins the events into a timeline. A 33-event,
  57 KB result set comes back as a ~10 KB digest that answers "what happened"
  without reading a single raw event. `read_search_results` then supports
  `fields` projection (return two dot-paths per event instead of a 1 KB blob)
  for the rare case you need to walk individual records.
- **Narrow first, widen on a miss.** Searches default to a 1-hour window. If
  nothing is found and you gave no explicit range, the window widens
  15m → 1h → 6h → 24h → 3d → 7d, stopping at the log group's creation time or
  retention cutoff. Logs Insights is billed per GB scanned, so the cheap query
  runs first.
- **Failures say what to do.** An expired SSO session returns
  `aws sso login --profile <name>`, not a stack trace. A missing profile lists the
  profiles you actually have. Missing IAM permissions list the exact actions needed.

## Configuration

Create `~/.aws-logs-mcp/config.json`:

```json
{
  "defaultEnvironment": "dev",
  "assumeDefaultEnvironment": false,
  "environments": {
    "dev": {
      "profile": "olp-dev",
      "region": "us-east-1",
      "name": "Development",
      "logGroupPrefix": "/aws/lambda/olp-",
      "targets": {
        "OLP": {
          "description": "OLP API + async workers",
          "logGroups": ["/aws/lambda/olp-api-dev", "/aws/ecs/olp-worker-dev"]
        }
      }
    },
    "stg": {
      "profile": "olp-stg",
      "region": "us-east-1",
      "name": "Staging",
      "targets": {}
    },
    "prd": {
      "profile": "olp-prd",
      "region": "us-east-1",
      "name": "Production",
      "targets": {
        "OLP": {
          "logGroups": ["/aws/lambda/olp-api-prd"],
          "defaultLookback": "1h"
        }
      }
    }
  }
}
```

```bash
chmod 600 ~/.aws-logs-mcp/config.json
```

The server starts with a copy-pasteable template if the file is missing.

### Keys

| Key                                 | Default                     | Meaning                                                                               |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `environments.<key>.profile`        | —                           | Named profile from `~/.aws/config` / `~/.aws/credentials`.                            |
| `environments.<key>.region`         | from profile                | Override only. Normally read from the profile itself.                                 |
| `environments.<key>.accountId`      | —                           | Expected 12-digit account. Required when a profile is shared by several environments. |
| `environments.<key>.targets`        | `{}`                        | Named log-group sets, e.g. `OLP`.                                                     |
| `environments.<key>.logGroupPrefix` | —                           | Default prefix for discovery in this environment.                                     |
| `defaultEnvironment`                | —                           | Only used when `assumeDefaultEnvironment` is true.                                    |
| `assumeDefaultEnvironment`          | `false`                     | `true` skips the "which environment?" prompt.                                         |
| `regionDefaults`                    | `{ fallback: "us-east-1" }` | Fallbacks when neither the environment nor the profile names a region.                |
| `outputDir`                         | `<tmpdir>/aws-logs-mcp`     | Where result files are written.                                                       |
| `maxResults`                        | `10000`                     | Hard ceiling on events per search.                                                    |
| `queryTimeoutSeconds`               | `120`                       | Give up polling an Insights query after this long.                                    |
| `resultRetentionHours`              | `24`                        | Prune result files older than this at startup.                                        |

Targets are optional — `discover_log_groups` finds log groups you never configured.

### Regions

`region` is optional. It resolves in this order:

1. The environment's explicit `region`.
2. The profile's own `region` in `~/.aws/config` (following `source_profile` for role chains).
3. `regionDefaults.bySsoSession[<the profile's sso_session>]`.
4. `regionDefaults.fallback` (default `us-east-1`).

Credential tools already write the region into the profile, so repeating it in
this config just invites drift. `list_environments` reports `regionSource` so you
can see which rule applied.

```json
"regionDefaults": {
  "bySsoSession": { "trajector": "us-east-2" },
  "fallback": "us-east-1"
}
```

### Shared profiles (Leapp and friends)

Some credential managers write **every** environment into a single named profile
and swap its credentials as you switch sessions. The profile name then tells you
nothing about which account is live — "search prd" would happily run against dev.

Set `accountId` on each environment to close that hole. Before any search the
server checks the live STS identity and refuses on mismatch, naming the session
you need to activate. If a profile is shared by more than one environment and an
environment omits `accountId`, that environment refuses to run at all rather than
search an unverified account.

### Credentials

Credentials are resolved by the AWS SDK's standard provider chain per profile, so
static keys, SSO sessions, and `role_arn` + `source_profile` chains all work. This
server never reads, stores, or returns credentials; it only ever reports the
profile name, region, and (from `check_credentials`) the STS caller identity.

MFA-prompting profiles will not work — an MCP server runs non-interactively and
cannot prompt for a token code. Refresh the session in your terminal first.

Required IAM permissions:

```
logs:StartQuery, logs:GetQueryResults, logs:StopQuery,
logs:DescribeLogGroups, logs:DescribeLogStreams,
logs:FilterLogEvents, logs:GetLogEvents
```

## Tools

| Tool                  | Purpose                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `list_environments`   | Configured environments, profiles, regions, targets.                                 |
| `check_credentials`   | Verify a profile resolves, whose identity it is, and whether CloudWatch is readable. |
| `reload_config`       | Re-read the config file without restarting the host.                                 |
| `discover_log_groups` | List log groups by prefix / substring.                                               |
| `list_log_streams`    | Streams in a group, newest first — confirms a group is receiving data.               |
| `get_log_context`     | Unfiltered events around a moment in one stream.                                     |
| `search_logs`         | Find matching events, digest them, write the full set to disk.                       |
| `read_search_results` | Page/filter/project a result file server-side.                                       |
| `aggregate_logs`      | Group and count events server-side; returns one row per group, not the events.       |

### `aggregate_logs`

For "which / how many X" questions, this is the efficient path. It builds a Logs
Insights `stats … by …` query, so AWS computes the aggregation and only the
reduced rows come back — no raw events, no result file.

| Argument                                         | Notes                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `env`, `target` / `logGroups` / `logGroupPrefix` | Same resolution as `search_logs`.                                                                            |
| `by`                                             | Group-by field paths, e.g. `["detail.globalClientId"]`. Dotted/hyphenated paths are backtick-quoted for you. |
| `metrics`                                        | Aggregates with aliases, e.g. `["count(*) as events","latest(@timestamp) as last"]`. Defaults to `count(*)`. |
| `filter`                                         | Raw Insights filter without the leading `filter`, e.g. `` `detail-type` = "brief-reviewCompleted" ``.        |
| `pattern`                                        | Literal `@message` substring, combined with `filter`.                                                        |
| `from` / `to` / `lookback`, `sort`, `limit`      | As for `search_logs`.                                                                                        |

```
aggregate_logs(env=dev, target=OLP-events,
  filter='`detail-type` = "brief-reviewCompleted"',
  by=["detail.globalClientId","detail.status"],
  metrics=["count(*) as events","latest(@timestamp) as last"])
→ one row per client, ~1 KB total.
```

Capped at 50 log groups (one Insights query): merging aggregates across batches
would corrupt `latest`/`avg`/percentiles, so it refuses rather than mislead.

### `search_logs`

| Argument                    | Notes                                                           |
| --------------------------- | --------------------------------------------------------------- |
| `env`                       | `dev`/`stg`/`prd`. Omit to be asked.                            |
| `target`                    | A configured alias, e.g. `OLP`.                                 |
| `logGroups`                 | Explicit names. Takes precedence over `target`.                 |
| `logGroupPrefix`            | Search everything matching a prefix.                            |
| `pattern`                   | The text to find. Literal, case-sensitive substring by default. |
| `regex` / `caseInsensitive` | Switch matching mode.                                           |
| `queryOverride`             | A full Logs Insights query, for `stats`/aggregations.           |
| `from` / `to` / `lookback`  | ISO-8601, epoch, or relative (`-2h`).                           |
| `limit`                     | Max events (default 1000).                                      |
| `mode`                      | `auto` (default), `insights`, or `filter`.                      |
| `autoWiden`                 | Disable progressive widening.                                   |

Returns a summary — engine used, resolved time range, per-log-group and
per-stream hit counts, first/last event, GB scanned — plus `resultsFile`, an
NDJSON file sorted newest-first.

### Engines

`auto` runs **Logs Insights** (`StartQuery`), which searches up to 50 log groups
server-side in one job. It falls back to **`FilterLogEvents`** when Insights is
unavailable for a reason the fallback does not share — the account's concurrent
query quota, or missing `logs:StartQuery` permission.

Pass `mode: "filter"` to avoid Insights per-GB scan charges entirely, at the cost
of speed: it is one paginated call per log group, fanned out with bounded
concurrency.

### Reliability

- Adaptive retry mode with client-side rate limiting on every AWS client.
- Full-jitter exponential backoff on `StartQuery` for the concurrent-query quota,
  which the SDK treats as a terminal error.
- Abandoned queries are always `StopQuery`'d, so a timeout does not leak one of
  the account's 30 concurrent query slots.
- Log groups are verified before searching; a renamed group degrades to a warning
  instead of failing the whole search.
- Partial results survive batch failures, query timeouts, and disk problems.

## Install

```json
{
  "mcpServers": {
    "aws-logs": {
      "command": "npx",
      "args": ["-y", "@mpurdon/mcp-aws-logs"],
      "env": {}
    }
  }
}
```

Or via the configurator:

```bash
npx @mpurdon/mcp-servers configure
```
