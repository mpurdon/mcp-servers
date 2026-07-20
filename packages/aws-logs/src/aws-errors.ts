import {
  AWS_CONFIG_FILE,
  AWS_CREDENTIALS_FILE,
  listAvailableProfiles,
} from "./aws-profiles.js";

export { listAvailableProfiles };

/**
 * Every AWS failure this server can hit, normalized into something the model
 * can act on. `remediation` is written for a human operator — it should say
 * exactly which command to run or which permission to add.
 */
export interface AwsFailure {
  kind:
    | "profile-missing"
    | "sso-expired"
    | "token-expired"
    | "credentials-invalid"
    | "credentials-missing"
    | "mfa-required"
    | "access-denied"
    | "not-found"
    | "throttled"
    | "quota-exceeded"
    | "invalid-request"
    | "network"
    | "service"
    | "unknown";
  code: string;
  message: string;
  remediation: string;
  /** Whether retrying the same call unchanged could plausibly succeed. */
  retryable: boolean;
}

export interface AwsErrorContext {
  env?: string;
  profile?: string;
  region?: string;
  operation: string;
  resource?: string;
}

interface AwsLikeError {
  name?: string;
  message?: string;
  code?: string;
  errno?: string | number;
  $metadata?: { httpStatusCode?: number };
  $fault?: "client" | "server";
  cause?: unknown;
}

function asAwsError(err: unknown): AwsLikeError {
  if (err && typeof err === "object") return err as AwsLikeError;
  return { message: String(err) };
}

/** Walk the cause chain so a wrapped CredentialsProviderError is still visible. */
function errorChainText(err: unknown, depth = 0): string {
  if (depth > 5 || !err || typeof err !== "object") return "";
  const e = err as AwsLikeError;
  const self = `${e.name ?? ""} ${e.code ?? ""} ${e.message ?? ""}`;
  return `${self} ${errorChainText(e.cause, depth + 1)}`;
}

function profileHint(profile?: string): string {
  if (!profile) return "";
  const available = listAvailableProfiles();
  if (available.length === 0) {
    return ` No profiles found in ${AWS_CONFIG_FILE} or ${AWS_CREDENTIALS_FILE}.`;
  }
  if (available.includes(profile)) return "";
  return ` Profile '${profile}' is not defined. Available profiles: ${available.join(", ")}.`;
}

export function classifyAwsError(
  err: unknown,
  ctx: AwsErrorContext,
): AwsFailure {
  const e = asAwsError(err);
  const name = e.name ?? "";
  const code = e.code ?? name ?? "UnknownError";
  const text = errorChainText(err).toLowerCase();
  const status = e.$metadata?.httpStatusCode;
  const where = ctx.resource ? ` (${ctx.resource})` : "";
  const profileSuffix = ctx.profile ? ` [profile ${ctx.profile}]` : "";
  const base = `${ctx.operation} failed${where}${profileSuffix}: ${e.message ?? code}`;

  // --- Credential resolution ------------------------------------------------

  if (
    text.includes("could not be found") &&
    (text.includes("profile") || name === "CredentialsProviderError")
  ) {
    return {
      kind: "profile-missing",
      code: "ProfileNotFound",
      message: base,
      remediation:
        `Check the 'profile' value for environment '${ctx.env ?? "?"}' in ~/.aws-logs-mcp/config.json.` +
        profileHint(ctx.profile),
      retryable: false,
    };
  }

  // The SDK words this several different ways depending on whether the token
  // is expired, invalid, or absent ("...has expired", "...is invalid",
  // "run aws sso login"), so match on the combination rather than one phrase —
  // otherwise these fall through to the generic credentials-missing branch and
  // lose the one instruction that actually fixes them.
  const mentionsSso = text.includes("sso");
  if (
    name.includes("SSOToken") ||
    (mentionsSso &&
      (text.includes("expired") ||
        text.includes("invalid") ||
        text.includes("refresh") ||
        text.includes("aws sso login")))
  ) {
    return {
      kind: "sso-expired",
      code: "SSOTokenExpired",
      message: base,
      remediation: `The SSO session for this profile is expired or invalid. Run: aws sso login --profile ${ctx.profile ?? "<profile>"}`,
      retryable: false,
    };
  }

  if (name === "ExpiredTokenException" || name === "ExpiredToken") {
    return {
      kind: "token-expired",
      code: name,
      message: base,
      remediation:
        `Temporary credentials for profile '${ctx.profile ?? "?"}' expired. ` +
        `If this is an SSO profile run: aws sso login --profile ${ctx.profile ?? "<profile>"}. ` +
        `If it is an assume-role profile, re-run the role chain or refresh the source profile's keys.`,
      retryable: false,
    };
  }

  if (
    name === "InvalidClientTokenId" ||
    name === "UnrecognizedClientException" ||
    name === "SignatureDoesNotMatch" ||
    name === "AuthFailure"
  ) {
    return {
      kind: "credentials-invalid",
      code: name,
      message: base,
      remediation:
        `The access key for profile '${ctx.profile ?? "?"}' is invalid, inactive, or deleted. ` +
        `Verify with: aws sts get-caller-identity --profile ${ctx.profile ?? "<profile>"}`,
      retryable: false,
    };
  }

  if (
    name === "CredentialsProviderError" ||
    text.includes("could not load credentials from any providers")
  ) {
    return {
      kind: "credentials-missing",
      code: "CredentialsNotFound",
      message: base,
      remediation:
        `No usable credentials resolved for profile '${ctx.profile ?? "?"}'. ` +
        `Confirm the profile exists and has either static keys, an sso_session, or role_arn+source_profile.` +
        profileHint(ctx.profile),
      retryable: false,
    };
  }

  if (
    text.includes("multi-factor") ||
    text.includes("mfa") ||
    name === "TokenRefreshRequired"
  ) {
    return {
      kind: "mfa-required",
      code: name || "MFARequired",
      message: base,
      remediation:
        `Profile '${ctx.profile ?? "?"}' requires MFA. MCP servers run non-interactively and cannot prompt for a token code. ` +
        `Refresh the session in your terminal first (e.g. aws sts get-session-token / your MFA helper), then retry.`,
      retryable: false,
    };
  }

  // --- Authorization --------------------------------------------------------

  if (
    name === "AccessDeniedException" ||
    name === "AccessDenied" ||
    status === 403
  ) {
    const scp = text.includes("service control policy");
    return {
      kind: "access-denied",
      code: name || "AccessDenied",
      message: base,
      remediation: scp
        ? `Blocked by a service control policy on the account behind profile '${ctx.profile ?? "?"}'. This cannot be fixed locally — ask your AWS org admin.`
        : `The principal for profile '${ctx.profile ?? "?"}' lacks permission for ${ctx.operation}. ` +
          `Searching needs: logs:StartQuery, logs:GetQueryResults, logs:StopQuery, logs:DescribeLogGroups, ` +
          `logs:DescribeLogStreams, logs:FilterLogEvents, logs:GetLogEvents.`,
      retryable: false,
    };
  }

  // --- Resource -------------------------------------------------------------

  if (name === "ResourceNotFoundException" || status === 404) {
    return {
      kind: "not-found",
      code: name || "NotFound",
      message: base,
      remediation:
        `The log group or stream does not exist in region ${ctx.region ?? "?"} for this account. ` +
        `Use discover_log_groups to list what is actually there — log group names are case-sensitive and often differ per environment.`,
      retryable: false,
    };
  }

  // --- Rate / quota ---------------------------------------------------------

  if (
    name === "ThrottlingException" ||
    name === "TooManyRequestsException" ||
    name === "RequestThrottled" ||
    name === "ThrottledException" ||
    status === 429
  ) {
    return {
      kind: "throttled",
      code: name || "Throttled",
      message: base,
      remediation:
        "CloudWatch Logs throttled the request. The server already retries with adaptive backoff; " +
        "if this persists, narrow the time range or search fewer log groups at once.",
      retryable: true,
    };
  }

  if (name === "LimitExceededException") {
    return {
      kind: "quota-exceeded",
      code: name,
      message: base,
      remediation:
        "The account hit its concurrent Logs Insights query limit (default 30). " +
        "The server retries and can fall back to FilterLogEvents — pass mode='filter' to skip Insights entirely.",
      retryable: true,
    };
  }

  // --- Request shape --------------------------------------------------------

  if (name === "MalformedQueryException") {
    return {
      kind: "invalid-request",
      code: name,
      message: base,
      remediation:
        "The Logs Insights query is syntactically invalid. If you passed queryOverride, check the pipe syntax; " +
        "otherwise report this as a server bug.",
      retryable: false,
    };
  }

  if (
    name === "InvalidParameterException" ||
    name === "ValidationException" ||
    status === 400
  ) {
    return {
      kind: "invalid-request",
      code: name || "ValidationError",
      message: base,
      remediation:
        "AWS rejected the request parameters — commonly a start time after the end time, " +
        "a time range predating log group creation, or more than 50 log groups in one query.",
      retryable: false,
    };
  }

  // --- Transport ------------------------------------------------------------

  const errno = typeof e.errno === "string" ? e.errno : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    errno === "ENOTFOUND" ||
    text.includes("socket hang up") ||
    text.includes("network")
  ) {
    return {
      kind: "network",
      code: String(code),
      message: base,
      remediation:
        `Could not reach the CloudWatch Logs endpoint for region ${ctx.region ?? "?"}. ` +
        `Check connectivity, VPN, and any HTTPS_PROXY setting; also verify the region name is spelled correctly.`,
      retryable: true,
    };
  }

  if (e.$fault === "server" || (status !== undefined && status >= 500)) {
    return {
      kind: "service",
      code: name || `HTTP${status}`,
      message: base,
      remediation:
        "AWS returned a server-side error. This is usually transient — retry shortly.",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    code: name || "UnknownError",
    message: base,
    remediation:
      "Unrecognized failure. Re-run with the same arguments; if it repeats, check the CloudWatch Logs service health dashboard.",
    retryable: false,
  };
}

export function isRetryableAwsError(
  err: unknown,
  ctx: AwsErrorContext,
): boolean {
  return classifyAwsError(err, ctx).retryable;
}
