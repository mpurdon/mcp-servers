---
"@mpurdon/mcp-aws-logs": minor
"@mpurdon/mcp-servers": patch
---

Add the AWS CloudWatch Logs MCP server.

Searches and aggregates CloudWatch Logs across environments, log groups, and log
streams using named AWS profiles. Logs Insights is the primary engine with a
FilterLogEvents fallback; results are written to disk as NDJSON and the model
receives a summary plus the file path.

- Environment-scoped tools ask which environment to use rather than defaulting
  into production.
- Named targets (e.g. `OLP`) map to log-group sets, alongside live prefix-based
  discovery for groups that were never configured.
- Time ranges start narrow and widen progressively on a miss, bounded by log
  group creation time and retention.
- Adaptive retry, full-jitter backoff on the Insights concurrency quota, and
  guaranteed `StopQuery` on abandonment.
- AWS failures are classified into actionable remediations (expired SSO session,
  missing profile, missing IAM actions) instead of raw SDK errors.
- `region` is optional and resolved from the AWS profile, with configurable
  `regionDefaults` (by `sso_session`, then a fallback).
- Optional per-environment `accountId` is verified against the live STS identity
  before searching. Required when several environments share one profile — as
  credential managers like Leapp do — so "search prd" can never silently run
  against whichever session happens to be active.
- `search_logs` returns a token-efficient `analysis` digest instead of raw
  events: constant fields stated once, varying fields tallied, identifier fields
  named but not listed, plus a timeline and severity counts. A 57 KB / 33-event
  result collapses to a ~10 KB digest. `read_search_results` gains `fields`
  (dot-path projection, descending into JSON messages) and `maxMessageChars`;
  `search_logs` gains `verbosity` ("summary" default vs "full").
- New `aggregate_logs` tool pushes "group by / count by" questions into Logs
  Insights `stats`, returning one row per group instead of the underlying
  events — the answer to a "which clients / how many errors" question comes back
  in ~1 KB. Field paths are backtick-quoted automatically; capped at 50 log
  groups since cross-batch aggregate merging can't be done correctly.

Also registers the server in the `@mpurdon/mcp-servers` configurator.
