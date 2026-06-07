#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = "https://api.github.com";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  process.stderr.write(
    `[github] GITHUB_TOKEN environment variable is required. Set it in your MCP server config's "env" block.\n`,
  );
  process.exit(1);
}

// `GITHUB_TOKEN` is `string | undefined` until narrowed; capture the narrowed
// value so the rest of the module sees a plain `string`.
const TOKEN: string = GITHUB_TOKEN;

const GH_HEADERS: Record<string, string> = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// ---------------------------------------------------------------------------
// Minimal GitHub API types
// ---------------------------------------------------------------------------

interface GhUser {
  login?: string;
}

interface GhLabel {
  name?: string;
}

interface GhOrg {
  login?: string;
  description?: string | null;
  html_url?: string;
}

interface GhDeploymentStatus {
  state?: string;
  created_at?: string;
  description?: string | null;
  environment_url?: string;
}

interface GhDeployment {
  id: number;
  environment?: string;
  sha?: string;
  created_at?: string;
  creator?: GhUser | null;
  url?: string;
}

interface GhBranchRef {
  ref?: string;
  sha: string;
}

interface GhPullRequest {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  user?: GhUser | null;
  html_url?: string;
  body?: string | null;
  base?: GhBranchRef;
  head: GhBranchRef;
  created_at?: string;
  updated_at?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  mergeable_state?: string;
  labels?: GhLabel[];
  requested_reviewers?: GhUser[];
  repository_url?: string;
  pull_request?: unknown;
}

interface GhFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GhReview {
  state: string;
  user?: GhUser | null;
}

interface GhCheckRun {
  name: string;
  status?: string;
  conclusion?: string | null;
}

interface GhCheckRunsResponse {
  check_runs?: GhCheckRun[];
}

interface GhStep {
  name: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GhJob {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  runner_name?: string;
  html_url?: string;
  steps?: GhStep[];
}

interface GhJobsResponse {
  jobs?: GhJob[];
}

interface GhCommit {
  message?: string;
  author?: { name?: string };
}

interface GhWorkflowRun {
  id: number;
  name?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  head_sha?: string;
  head_commit?: GhCommit | null;
  actor?: GhUser | null;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string | null;
  html_url?: string;
}

interface GhWorkflowRunsResponse {
  total_count: number;
  workflow_runs: GhWorkflowRun[];
}

interface GhSearchResponse {
  total_count: number;
  items: GhPullRequest[];
}

interface GhRepo {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  open_issues_count?: number;
  pushed_at?: string;
  archived?: boolean;
  html_url?: string;
}

interface GhIssueComment {
  id: number;
  html_url?: string;
  created_at?: string;
}

interface FetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_API_PREFIX = "https://api.github.com/repos/";
const repoFromUrl = (url: string): string => url.replace(REPO_API_PREFIX, "");
const isDependabot = (user: GhUser | null | undefined): boolean =>
  user?.login === "dependabot[bot]";
const labelNames = (labels: GhLabel[] | undefined): string[] =>
  labels
    ?.map((l) => l.name)
    .filter((n): n is string => typeof n === "string") ?? [];
const ageHoursFrom = (dateStr: string): number =>
  Math.round((Date.now() - new Date(dateStr).getTime()) / 3600000);

function ghUrl(path: string): string {
  return path.startsWith("https://") ? path : `${BASE_URL}${path}`;
}

async function ghRequest<T = unknown>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const response = await fetch(ghUrl(path), {
    ...options,
    headers: {
      ...GH_HEADERS,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status} on ${path}: ${text}`);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function ghPaginate<T = unknown>(
  path: string,
  maxItems = 500,
): Promise<T[]> {
  const results: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  let url: string | null = ghUrl(`${path}${sep}per_page=100`);
  while (url && results.length < maxItems) {
    const response = await fetch(url, { headers: GH_HEADERS });
    if (!response.ok) break;
    const data: unknown = await response.json();
    results.push(...(Array.isArray(data) ? (data as T[]) : []));
    const link = response.headers.get("link");
    url = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return results.slice(0, maxItems);
}

function parseHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

const infraPattern =
  /\.(tf|tfvars|bicep|json|ya?ml)$|cdk\.|Dockerfile|docker-compose/i;
const ciPattern = /\.github\/workflows|\.circleci|Jenkinsfile|\.gitlab-ci/i;
const depPattern =
  /package\.json|requirements\.txt|Pipfile|go\.mod|Gemfile|pom\.xml|build\.gradle/i;

type FileCategory = "ci" | "infra" | "deps" | "code";

function categorizeFile(filename: string): FileCategory {
  if (ciPattern.test(filename)) return "ci";
  if (infraPattern.test(filename)) return "infra";
  if (depPattern.test(filename)) return "deps";
  return "code";
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function listMyOrgs(): Promise<unknown> {
  const data = await ghRequest<GhOrg[]>("/user/orgs?per_page=100");
  return data.map((o) => ({
    login: o.login,
    description: o.description,
    url: o.html_url,
  }));
}

interface GetDeploymentEnvironmentsArgs {
  owner: string;
  repo: string;
  commit_sha?: string;
  pr_number?: number;
}

async function getDeploymentEnvironments({
  owner,
  repo,
  commit_sha,
  pr_number,
}: GetDeploymentEnvironmentsArgs): Promise<unknown> {
  let sha = commit_sha;

  if (!sha && pr_number) {
    const pr = await ghRequest<GhPullRequest>(
      `/repos/${owner}/${repo}/pulls/${pr_number}`,
    );
    sha = pr.merge_commit_sha ?? undefined;
    if (!sha)
      throw new Error(
        `PR #${pr_number} has not been merged — no merge commit SHA available.`,
      );
  }

  const path = sha
    ? `/repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(sha)}&per_page=100`
    : `/repos/${owner}/${repo}/deployments?per_page=100`;

  const deployments = await ghRequest<GhDeployment[]>(path);
  if (!deployments.length)
    return { repo: `${owner}/${repo}`, sha: sha ?? null, deployments: [] };

  const enriched = await Promise.all(
    deployments.map(async (d) => {
      const statuses = await ghRequest<GhDeploymentStatus[]>(
        `/repos/${owner}/${repo}/deployments/${d.id}/statuses?per_page=1`,
      ).catch((): GhDeploymentStatus[] => []);
      const latest = statuses[0];
      return {
        environment: d.environment,
        sha: d.sha?.slice(0, 8),
        status: latest?.state ?? "unknown",
        deployed_at: latest?.created_at ?? d.created_at,
        deployed_by: d.creator?.login,
        description: latest?.description ?? null,
        url: latest?.environment_url || d.url,
      };
    }),
  );

  enriched.sort(
    (a, b) =>
      new Date(b.deployed_at ?? 0).getTime() -
      new Date(a.deployed_at ?? 0).getTime(),
  );
  return { repo: `${owner}/${repo}`, sha: sha ?? null, deployments: enriched };
}

interface GetOrgRecentPRsArgs {
  org: string;
  hours_ago?: number;
  state?: string;
  limit?: number;
}

async function getOrgRecentPRs({
  org,
  hours_ago = 24,
  limit = 50,
}: GetOrgRecentPRsArgs): Promise<unknown> {
  const since = parseHoursAgo(hours_ago);
  const sinceDate = since.slice(0, 10);
  const sinceTs = new Date(since).getTime();

  const query = `is:pr org:${org} updated:>=${sinceDate}`;
  let searchData: GhSearchResponse;
  try {
    searchData = await ghRequest<GhSearchResponse>(
      `/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=${Math.min(limit, 100)}`,
    );
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("422") || message.includes("404")) {
      throw new Error(
        `Could not find org "${org}". Use list_my_orgs to see the organizations your account belongs to.`,
        { cause: err },
      );
    }
    throw err;
  }

  const filtered = searchData.items.filter(
    (pr) => new Date(pr.updated_at ?? 0).getTime() >= sinceTs,
  );

  // Batch to stay under GitHub's secondary rate limit
  const BATCH = 8;
  const enriched: PromiseSettledResult<unknown>[] = [];
  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = await Promise.allSettled(
      filtered.slice(i, i + BATCH).map(async (pr) => {
        const repo = repoFromUrl(pr.repository_url ?? "");
        const description_excerpt =
          pr.body?.slice(0, 400).replace(/\r?\n/g, " ") ?? null;

        let size: {
          files_changed: number | null;
          additions: number | null;
          deletions: number | null;
          ci_status: string | null;
        } = {
          files_changed: null,
          additions: null,
          deletions: null,
          ci_status: null,
        };
        try {
          const detail = await ghRequest<GhPullRequest>(
            `/repos/${repo}/pulls/${pr.number}`,
          );
          size = {
            files_changed: detail.changed_files ?? null,
            additions: detail.additions ?? null,
            deletions: detail.deletions ?? null,
            ci_status: detail.mergeable_state ?? null, // clean | dirty | blocked | unknown | unstable
          };
        } catch (err) {
          process.stderr.write(
            `[github] Enrich ${repo}#${pr.number}: ${(err as Error).message}\n`,
          );
        }

        return {
          repo,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft || false,
          author: pr.user?.login,
          is_dependabot: isDependabot(pr.user),
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          labels: labelNames(pr.labels),
          url: pr.html_url,
          description_excerpt,
          ...size,
        };
      }),
    );
    enriched.push(...batch);
  }

  return {
    org,
    window_hours: hours_ago,
    since,
    total_found: filtered.length,
    prs: enriched.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : (r.reason as Error | undefined)?.message,
    ),
  };
}

interface GetPRForReviewArgs {
  owner: string;
  repo: string;
  pull_number: number;
  include_patches?: boolean;
}

async function getPRForReview({
  owner,
  repo,
  pull_number,
  include_patches = true,
}: GetPRForReviewArgs): Promise<unknown> {
  // Fetch PR first to get head SHA, then fan out remaining calls in parallel
  const pr = await ghRequest<GhPullRequest>(
    `/repos/${owner}/${repo}/pulls/${pull_number}`,
  );

  const [files, reviews, checkRunsData] = await Promise.all([
    ghRequest<GhFile[]>(
      `/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100`,
    ),
    ghRequest<GhReview[]>(
      `/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=100`,
    ),
    ghRequest<GhCheckRunsResponse>(
      `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    ).catch((): null => null),
  ]);

  const checkRuns = checkRunsData?.check_runs ?? [];

  const categorisedFiles = files.map((f) => ({
    filename: f.filename,
    status: f.status,
    category: categorizeFile(f.filename),
    additions: f.additions,
    deletions: f.deletions,
    patch: include_patches && f.patch ? f.patch.slice(0, 3000) : undefined,
  }));

  const reviewSummary = reviews.reduce<
    Record<string, Array<string | undefined>>
  >((acc, r) => {
    (acc[r.state] ??= []).push(r.user?.login);
    return acc;
  }, {});

  const ciSummary = checkRuns.reduce(
    (acc, r) => {
      acc.total++;
      if (r.conclusion === "success") acc.passed++;
      else if (r.conclusion === "failure") {
        acc.failed++;
        acc.failures.push(r.name);
      }
      if (r.status !== "completed") acc.pending++;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, pending: 0, failures: [] as string[] },
  );

  const touches = (cat: FileCategory): boolean =>
    categorisedFiles.some((f) => f.category === cat);

  return {
    repo: `${owner}/${repo}`,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    merged_at: pr.merged_at,
    author: pr.user?.login,
    is_dependabot: isDependabot(pr.user),
    url: pr.html_url,
    description: pr.body ? pr.body.slice(0, 8000) : "(no description)",
    base_branch: pr.base?.ref,
    head_branch: pr.head?.ref,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    size: {
      files_changed: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    file_categories: {
      touches_infra: touches("infra"),
      touches_ci: touches("ci"),
      touches_deps: touches("deps"),
    },
    files: categorisedFiles,
    reviews: reviewSummary,
    ci: ciSummary,
    labels: labelNames(pr.labels),
    requested_reviewers: pr.requested_reviewers?.map((r) => r.login) ?? [],
    mergeable_state: pr.mergeable_state,
  };
}

interface GetSecurityPRsArgs {
  org: string;
  min_hours_open?: number;
  limit?: number;
}

async function getSecurityPRs({
  org,
  min_hours_open = 4,
  limit = 40,
}: GetSecurityPRsArgs): Promise<unknown> {
  const query = `is:pr is:open org:${org} author:app/dependabot`;
  const searchData = await ghRequest<GhSearchResponse>(
    `/search/issues?q=${encodeURIComponent(query)}&sort=created&per_page=${Math.min(limit, 100)}`,
  );

  const thresholdHours = min_hours_open;
  const severityOrder: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    MODERATE: 2,
    LOW: 3,
    unknown: 4,
  };

  const prs = searchData.items
    .filter(
      (pr) =>
        ageHoursFrom(pr.created_at ?? new Date().toISOString()) >=
        thresholdHours,
    )
    .map((pr) => {
      const severityMatch = (pr.title ?? "").match(
        /\b(CRITICAL|HIGH|MEDIUM|LOW|MODERATE)\b/i,
      );
      return {
        repo: repoFromUrl(pr.repository_url ?? ""),
        number: pr.number,
        title: pr.title,
        severity: severityMatch?.[1]?.toUpperCase() ?? "unknown",
        age_hours: ageHoursFrom(pr.created_at ?? new Date().toISOString()),
        reviewers_assigned: (pr.requested_reviewers?.length ?? 0) > 0,
        labels: labelNames(pr.labels),
        url: pr.html_url,
      };
    });

  prs.sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4) ||
      b.age_hours - a.age_hours,
  );

  return { org, total: prs.length, min_hours_open, prs };
}

interface ListOrgReposArgs {
  org: string;
  sort?: string;
  limit?: number;
}

async function listOrgRepos({
  org,
  sort = "updated",
  limit = 50,
}: ListOrgReposArgs): Promise<unknown> {
  const data =
    limit > 100
      ? await ghPaginate<GhRepo>(
          `/orgs/${org}/repos?type=all&sort=${sort}`,
          limit,
        )
      : await ghRequest<GhRepo[]>(
          `/orgs/${org}/repos?type=all&sort=${sort}&per_page=${limit}`,
        );

  return data.map((r) => ({
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    default_branch: r.default_branch,
    open_issues: r.open_issues_count,
    pushed_at: r.pushed_at,
    archived: r.archived,
    url: r.html_url,
  }));
}

interface SearchIssuesArgs {
  query: string;
  limit?: number;
}

async function searchIssues({
  query,
  limit = 30,
}: SearchIssuesArgs): Promise<unknown> {
  const data = await ghRequest<GhSearchResponse>(
    `/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=${Math.min(limit, 100)}`,
  );
  return {
    total: data.total_count,
    items: data.items.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      repo: repoFromUrl(i.repository_url ?? ""),
      author: i.user?.login,
      updated_at: i.updated_at,
      labels: labelNames(i.labels),
      url: i.html_url,
      is_pr: !!i.pull_request,
    })),
  };
}

interface ListWorkflowRunsArgs {
  owner: string;
  repo: string;
  branch?: string;
  event?: string;
  status?: string;
  limit?: number;
}

async function listWorkflowRuns({
  owner,
  repo,
  branch,
  event,
  status,
  limit = 30,
}: ListWorkflowRunsArgs): Promise<unknown> {
  let path = `/repos/${owner}/${repo}/actions/runs?per_page=${Math.min(limit, 100)}`;
  if (branch) path += `&branch=${encodeURIComponent(branch)}`;
  if (event) path += `&event=${encodeURIComponent(event)}`;
  if (status) path += `&status=${encodeURIComponent(status)}`;

  const data = await ghRequest<GhWorkflowRunsResponse>(path);
  return {
    total: data.total_count,
    runs: data.workflow_runs.map((r) => ({
      id: r.id,
      name: r.name,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      branch: r.head_branch,
      commit: {
        sha: r.head_sha?.slice(0, 8),
        message: r.head_commit?.message?.split("\n")[0],
      },
      actor: r.actor?.login,
      created_at: r.created_at,
      updated_at: r.updated_at,
      duration_seconds: r.run_started_at
        ? Math.round(
            (new Date(r.updated_at ?? 0).getTime() -
              new Date(r.run_started_at).getTime()) /
              1000,
          )
        : null,
      url: r.html_url,
    })),
  };
}

interface GetWorkflowRunArgs {
  owner: string;
  repo: string;
  run_id: number;
}

async function getWorkflowRun({
  owner,
  repo,
  run_id,
}: GetWorkflowRunArgs): Promise<unknown> {
  const [run, jobsData] = await Promise.all([
    ghRequest<GhWorkflowRun>(`/repos/${owner}/${repo}/actions/runs/${run_id}`),
    ghRequest<GhJobsResponse>(
      `/repos/${owner}/${repo}/actions/runs/${run_id}/jobs?per_page=100`,
    ),
  ]);

  const durationSeconds = run.run_started_at
    ? Math.round(
        (new Date(run.updated_at ?? 0).getTime() -
          new Date(run.run_started_at).getTime()) /
          1000,
      )
    : null;

  return {
    id: run.id,
    name: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    commit: {
      sha: run.head_sha?.slice(0, 8),
      message: run.head_commit?.message?.split("\n")[0],
      author: run.head_commit?.author?.name,
    },
    actor: run.actor?.login,
    created_at: run.created_at,
    updated_at: run.updated_at,
    duration_seconds: durationSeconds,
    url: run.html_url,
    jobs: (jobsData.jobs ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      started_at: j.started_at,
      completed_at: j.completed_at,
      duration_seconds:
        j.started_at && j.completed_at
          ? Math.round(
              (new Date(j.completed_at).getTime() -
                new Date(j.started_at).getTime()) /
                1000,
            )
          : null,
      runner: j.runner_name,
      url: j.html_url,
      steps: j.steps?.map((s) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
        duration_seconds:
          s.started_at && s.completed_at
            ? Math.round(
                (new Date(s.completed_at).getTime() -
                  new Date(s.started_at).getTime()) /
                  1000,
              )
            : null,
      })),
    })),
  };
}

// Extract the last `maxLines` lines from the section of a GitHub Actions log
// that corresponds to `stepName`. Falls back to the tail of the full log if
// the group header isn't found (e.g. the step was set-up machinery with no
// explicit ##[group] marker).
function extractStepLogTail(
  logText: string,
  stepName: string,
  maxLines: number,
): string {
  const allLines = logText.split("\n");

  // GitHub log lines: "2024-01-01T00:00:00.0000000Z ##[group]StepName"
  const groupStart = allLines.findIndex(
    (line) =>
      line.includes(`##[group]${stepName}`) ||
      line.includes(`##[group]Run ${stepName}`),
  );

  let sectionLines: string[];
  if (groupStart !== -1) {
    const groupEnd = allLines.findIndex(
      (line, idx) => idx > groupStart && line.includes("##[endgroup]"),
    );
    const end = groupEnd !== -1 ? groupEnd : allLines.length;
    sectionLines = allLines.slice(groupStart + 1, end);
  } else {
    sectionLines = allLines; // fallback: whole log
  }

  // Strip leading ISO timestamp ("2024-01-01T00:00:00.0000000Z ") from each line
  const cleaned = sectionLines
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    .filter((l) => l.trim() !== "");

  return cleaned.slice(-maxLines).join("\n") || "(no output)";
}

interface GetPRCIFailuresArgs {
  owner: string;
  repo: string;
  pull_number: number;
  log_lines?: number;
}

async function getPRCIFailures({
  owner,
  repo,
  pull_number,
  log_lines = 50,
}: GetPRCIFailuresArgs): Promise<unknown> {
  // Phase 1: resolve PR head SHA
  const pr = await ghRequest<GhPullRequest>(
    `/repos/${owner}/${repo}/pulls/${pull_number}`,
  );
  const headSha = pr.head.sha;

  // Phase 2: find failed workflow runs for this commit
  const runsData = await ghRequest<GhWorkflowRunsResponse>(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
  );

  const allRuns = runsData.workflow_runs ?? [];
  const failedRuns = allRuns.filter((r) => r.conclusion === "failure");

  if (!failedRuns.length) {
    return {
      pr_number: pull_number,
      head_sha: headSha,
      failing_runs: [],
      message: "No failing CI runs found for this PR's head commit.",
    };
  }

  // Deduplicate: keep only the most-recent run per workflow name
  const byWorkflow = new Map<string | undefined, GhWorkflowRun>();
  for (const run of failedRuns) {
    const existing = byWorkflow.get(run.name);
    if (
      !existing ||
      new Date(run.created_at ?? 0) > new Date(existing.created_at ?? 0)
    ) {
      byWorkflow.set(run.name, run);
    }
  }
  const uniqueFailedRuns = [...byWorkflow.values()];

  // Phase 3 + 4: enrich each run — jobs → failing steps → log tails
  // Batch 4 at a time to stay well under GitHub's secondary rate limit
  const BATCH = 4;
  const failingRuns: unknown[] = [];
  for (let i = 0; i < uniqueFailedRuns.length; i += BATCH) {
    const batch = await Promise.all(
      uniqueFailedRuns.slice(i, i + BATCH).map(async (run) => {
        const jobsData = await ghRequest<GhJobsResponse>(
          `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        );
        const failingJobs = (jobsData.jobs ?? []).filter(
          (j) => j.conclusion === "failure",
        );

        const enrichedJobs = await Promise.all(
          failingJobs.map(async (job) => {
            const failingSteps = (job.steps ?? []).filter(
              (s) => s.conclusion === "failure",
            );

            // Fetch the full job log once; GitHub returns a 302 → pre-signed URL
            let jobLogText: string | null = null;
            let logFetchError: string | null = null;
            try {
              const logResp = await fetch(
                `${BASE_URL}/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`,
                { headers: { Authorization: `Bearer ${TOKEN}` } },
              );
              if (!logResp.ok) {
                logFetchError = `HTTP ${logResp.status}`;
              } else {
                jobLogText = await logResp.text();
              }
            } catch (err) {
              logFetchError = (err as Error).message;
            }

            const stepsWithLogs = failingSteps.map((step) => {
              if (logFetchError || !jobLogText) {
                return {
                  step_name: step.name,
                  log_tail: null,
                  log_error:
                    logFetchError ??
                    "Logs unavailable (expired or insufficient permissions)",
                };
              }
              return {
                step_name: step.name,
                log_tail: extractStepLogTail(jobLogText, step.name, log_lines),
              };
            });

            return {
              job_id: job.id,
              job_name: job.name,
              failing_steps: stepsWithLogs,
            };
          }),
        );

        return {
          run_id: run.id,
          workflow_name: run.name,
          run_url: run.html_url,
          failing_jobs: enrichedJobs,
        };
      }),
    );
    failingRuns.push(...batch);
  }

  return {
    pr_number: pull_number,
    head_sha: headSha,
    failing_runs: failingRuns,
  };
}

interface CreateIssueCommentArgs {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

async function createIssueComment({
  owner,
  repo,
  issue_number,
  body,
}: CreateIssueCommentArgs): Promise<unknown> {
  const result = await ghRequest<GhIssueComment>(
    `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
  return { id: result.id, url: result.html_url, created_at: result.created_at };
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

function buildServer(): Server {
  const server = new Server(
    { name: "github", version: "0.4.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        {
          name: "list_my_orgs",
          description:
            "List all GitHub organizations the authenticated user belongs to. Use this first when you don't know the org name.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "get_deployment_environments",
          description:
            "Get deployment status across environments for a repo, optionally filtered to a specific commit SHA or PR number. Use this to check which environments a merged PR has been deployed to.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              commit_sha: {
                type: "string",
                description: "Filter to deployments for this commit SHA",
              },
              pr_number: {
                type: "number",
                description:
                  "Resolve the merge commit SHA from this PR number and filter by it",
              },
            },
            required: ["owner", "repo"],
          },
        },
        {
          name: "get_org_recent_prs",
          description:
            "Scan all repos in a GitHub org for PR activity in the last N hours. Returns a triage-ready summary for each PR: repo, title, state, author, labels, size (files/additions/deletions), and CI merge state. Use this as the first step in the daily review workflow to discover what needs deeper attention.",
          inputSchema: {
            type: "object",
            properties: {
              org: {
                type: "string",
                description: "GitHub organization name (e.g. 'team-and-tech')",
              },
              hours_ago: {
                type: "number",
                description: "How far back to look in hours. Default: 24",
              },
              state: {
                type: "string",
                description:
                  "Filter by PR state: 'open', 'closed', or 'all'. Default: 'all'",
              },
              limit: {
                type: "number",
                description: "Max PRs to return. Default: 50",
              },
            },
            required: ["org"],
          },
        },
        {
          name: "get_pr_for_review",
          description:
            "Get full context for a single PR, structured for architectural review. Returns: description, all changed files categorised by type (infra/ci/deps/code) with diff patches, CI check results, and review verdicts. Use after get_org_recent_prs to deep-dive on PRs that look architecturally significant.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              pull_number: {
                type: "number",
                description: "Pull request number",
              },
              include_patches: {
                type: "boolean",
                description:
                  "Include diff patches in file data. Default: true. Set false for large PRs where you only need the file list.",
              },
            },
            required: ["owner", "repo", "pull_number"],
          },
        },
        {
          name: "get_pr_ci_failures",
          description:
            "Get the failing CI check details for a pull request — finds the most recent failed workflow run for the PR's head commit and returns the failing job names, steps, and log tail. Use this immediately after get_pr_for_review surfaces a CI failure.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              pull_number: {
                type: "number",
                description: "Pull request number",
              },
              log_lines: {
                type: "number",
                description:
                  "How many lines of log tail to return per failing step. Default: 50",
              },
            },
            required: ["owner", "repo", "pull_number"],
          },
        },
        {
          name: "get_security_prs",
          description:
            "Find open Dependabot security PRs across an org that have been sitting open without attention. Returns age, severity extracted from the PR title, and whether reviewers are assigned. Sorted by severity then age.",
          inputSchema: {
            type: "object",
            properties: {
              org: { type: "string", description: "GitHub organization name" },
              min_hours_open: {
                type: "number",
                description:
                  "Only return PRs open for at least this many hours. Default: 4",
              },
              limit: {
                type: "number",
                description: "Max PRs to return. Default: 40",
              },
            },
            required: ["org"],
          },
        },
        {
          name: "list_org_repos",
          description:
            "List repositories in a GitHub organization. Useful for scoping which repos to include in a review, or checking which repos have had recent pushes.",
          inputSchema: {
            type: "object",
            properties: {
              org: { type: "string", description: "GitHub organization name" },
              sort: {
                type: "string",
                description:
                  "Sort by: created, updated, pushed, full_name. Default: updated",
              },
              limit: {
                type: "number",
                description: "Max repos to return. Default: 50",
              },
            },
            required: ["org"],
          },
        },
        {
          name: "search_issues",
          description:
            "Search issues and PRs across GitHub using GitHub's search syntax. Use for targeted queries like finding all open PRs with a specific label, PRs merged in a date range, or issues assigned to a user. Examples: 'org:team-and-tech is:pr is:open label:security', 'repo:team-and-tech/nexus is:pr merged:>=2026-05-01'",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "GitHub search query string",
              },
              limit: {
                type: "number",
                description: "Max results to return. Default: 30",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "list_workflow_runs",
          description:
            "List GitHub Actions workflow runs for a repo. Returns run name, trigger event, status, conclusion, branch, commit, actor, duration, and URL. Filter by branch, event type (push, pull_request, workflow_dispatch, schedule, etc.), or status (queued, in_progress, completed, failure, success, cancelled).",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              branch: {
                type: "string",
                description: "Filter to runs on this branch",
              },
              event: {
                type: "string",
                description:
                  "Filter by trigger event: push, pull_request, workflow_dispatch, schedule, etc.",
              },
              status: {
                type: "string",
                description:
                  "Filter by status: queued, in_progress, completed, success, failure, cancelled, skipped, timed_out, action_required",
              },
              limit: {
                type: "number",
                description: "Max runs to return. Default: 30",
              },
            },
            required: ["owner", "repo"],
          },
        },
        {
          name: "get_workflow_run",
          description:
            "Get full details for a specific GitHub Actions run: all jobs with their steps, durations, and conclusions. Use this after list_workflow_runs to diagnose a failure — the steps breakdown shows exactly which step failed and how long each took.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              run_id: {
                type: "number",
                description: "The workflow run ID (from list_workflow_runs)",
              },
            },
            required: ["owner", "repo", "run_id"],
          },
        },
        {
          name: "create_issue_comment",
          description:
            "Post a comment on a GitHub issue or PR. Use to leave ADR recommendations, security flags, or review notes directly on the PR rather than only in a report file.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repo owner (org or user)",
              },
              repo: { type: "string", description: "Repository name" },
              issue_number: {
                type: "number",
                description: "Issue or PR number",
              },
              body: {
                type: "string",
                description: "Comment body (Markdown supported)",
              },
            },
            required: ["owner", "repo", "issue_number", "body"],
          },
        },
      ],
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      let result: unknown;
      switch (name) {
        case "list_my_orgs":
          result = await listMyOrgs();
          break;
        case "get_deployment_environments":
          result = await getDeploymentEnvironments(
            args as unknown as GetDeploymentEnvironmentsArgs,
          );
          break;
        case "get_org_recent_prs":
          result = await getOrgRecentPRs(
            args as unknown as GetOrgRecentPRsArgs,
          );
          break;
        case "get_pr_for_review":
          result = await getPRForReview(args as unknown as GetPRForReviewArgs);
          break;
        case "get_pr_ci_failures":
          result = await getPRCIFailures(
            args as unknown as GetPRCIFailuresArgs,
          );
          break;
        case "get_security_prs":
          result = await getSecurityPRs(args as unknown as GetSecurityPRsArgs);
          break;
        case "list_org_repos":
          result = await listOrgRepos(args as unknown as ListOrgReposArgs);
          break;
        case "search_issues":
          result = await searchIssues(args as unknown as SearchIssuesArgs);
          break;
        case "list_workflow_runs":
          result = await listWorkflowRuns(
            args as unknown as ListWorkflowRunsArgs,
          );
          break;
        case "get_workflow_run":
          result = await getWorkflowRun(args as unknown as GetWorkflowRunArgs);
          break;
        case "create_issue_comment":
          result = await createIssueComment(
            args as unknown as CreateIssueCommentArgs,
          );
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Prevent unhandled rejections (e.g. a GitHub call that resolves after the MCP
// layer already returned) from crashing the process and resetting state.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[github] unhandled rejection (ignored): ${String(reason)}\n`,
  );
});

main().catch((err: unknown) => {
  process.stderr.write(
    `[github] fatal: ${(err as Error).stack ?? String(err)}\n`,
  );
  process.exit(1);
});
