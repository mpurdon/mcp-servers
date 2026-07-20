import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { Config, EnvironmentConfig } from "./config.js";
import { classifyAwsError, type AwsFailure } from "./aws-errors.js";
import { readAwsProfiles, resolveRegion } from "./aws-profiles.js";

/** An environment config with its region actually resolved. */
export interface EffectiveEnvironment extends Omit<
  EnvironmentConfig,
  "region"
> {
  env: string;
  region: string;
  regionSource: string;
}

/** Identity cache TTL. Short, because tools like Leapp rewrite a profile's
 * credentials in place — a long-lived cache would keep pointing at the
 * account you just switched away from. */
const IDENTITY_TTL_MS = 5 * 60_000;

export interface CallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
  /** Inferred from the ARN shape — helps explain which credential kind is live. */
  credentialType: "sso-or-assumed-role" | "iam-user" | "root" | "unknown";
}

/**
 * Owns one CloudWatchLogsClient per environment. Clients are cached because
 * constructing one re-resolves the credential chain (which can mean a disk read
 * or an STS call), and a log search fans out across many requests.
 */
export class ClientManager {
  private config: Config;
  private readonly logsClients = new Map<string, CloudWatchLogsClient>();
  private readonly identities = new Map<
    string,
    { identity: CallerIdentity; at: number }
  >();

  constructor(config: Config) {
    this.config = config;
  }

  /** Resolve an environment's region: config → profile → regionDefaults. */
  getEffective(env: string): EffectiveEnvironment {
    const e = this.getEnvironment(env);
    const region = resolveRegion(
      e.profile,
      e.region,
      this.config.regionDefaults,
    );
    return { ...e, env, region: region.region, regionSource: region.source };
  }

  getRegion(env: string): string {
    return this.getEffective(env).region;
  }

  getConfig(): Config {
    return this.config;
  }

  hasEnvironment(env: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.config.environments, env);
  }

  getEnvironment(env: string): EnvironmentConfig {
    const e = this.config.environments[env];
    if (!e) {
      throw new Error(
        `Unknown environment '${env}'. Defined environments: ${Object.keys(this.config.environments).join(", ")}`,
      );
    }
    return e;
  }

  /**
   * fromNodeProviderChain resolves static keys, SSO sessions, and
   * role_arn+source_profile chains from the shared config files — which is why
   * a single provider covers the "mix of both" credential setup.
   */
  private credentials(env: string): ReturnType<typeof fromNodeProviderChain> {
    const e = this.getEffective(env);
    return fromNodeProviderChain({
      profile: e.profile,
      clientConfig: { region: e.region },
      // Non-interactive host: never let the SDK block on an MFA/SSO prompt.
      ignoreCache: false,
    });
  }

  getLogsClient(env: string): CloudWatchLogsClient {
    const cached = this.logsClients.get(env);
    if (cached) return cached;

    const e = this.getEffective(env);
    const client = new CloudWatchLogsClient({
      region: e.region,
      credentials: this.credentials(env),
      // Adaptive mode adds client-side rate limiting on top of retries, which
      // is what keeps a wide fan-out from stampeding into sustained throttling.
      retryMode: "adaptive",
      maxAttempts: 8,
      requestHandler: {
        requestTimeout: 60_000,
        connectionTimeout: 10_000,
      },
    });
    this.logsClients.set(env, client);
    return client;
  }

  /** Verify credentials actually work, and report who we are. */
  async getCallerIdentity(env: string, force = false): Promise<CallerIdentity> {
    if (!force) {
      const cached = this.identities.get(env);
      if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
        return cached.identity;
      }
    }

    const e = this.getEffective(env);
    const sts = new STSClient({
      region: e.region,
      credentials: this.credentials(env),
      retryMode: "adaptive",
      maxAttempts: 4,
      requestHandler: { requestTimeout: 15_000, connectionTimeout: 8_000 },
    });

    try {
      const out = await sts.send(new GetCallerIdentityCommand({}));
      const arn = out.Arn ?? "";
      const identity: CallerIdentity = {
        accountId: out.Account ?? "unknown",
        arn,
        userId: out.UserId ?? "unknown",
        credentialType: arn.includes(":assumed-role/")
          ? "sso-or-assumed-role"
          : arn.includes(":user/")
            ? "iam-user"
            : arn.endsWith(":root")
              ? "root"
              : "unknown",
      };
      this.identities.set(env, { identity, at: Date.now() });
      return identity;
    } finally {
      sts.destroy();
    }
  }

  /**
   * Refuse to operate if the live credentials point at a different account than
   * the environment declares.
   *
   * This is the safeguard for shared-profile setups: when Leapp (or any similar
   * tool) writes dev, staging, and production into the same named profile, the
   * profile name tells you nothing about which account you are actually in. A
   * search that silently ran against production because the wrong session was
   * active is exactly the failure this prevents.
   */
  async assertExpectedAccount(
    env: string,
  ): Promise<CallerIdentity | undefined> {
    const e = this.getEffective(env);

    if (!e.accountId) {
      // A profile used by exactly one environment is unambiguous — the profile
      // name identifies the account. A profile shared by several environments
      // is not: without a declared accountId we would happily "search prd"
      // against whichever session happens to be active. Refuse instead.
      const sharing = Object.entries(this.config.environments)
        .filter(([, cfg]) => cfg.profile === e.profile)
        .map(([key]) => key);

      if (sharing.length > 1) {
        throw Object.assign(
          new Error(
            `Environment '${env}' cannot be verified. Profile '${e.profile}' is shared by ` +
              `${sharing.length} environments (${sharing.join(", ")}), so the profile alone ` +
              `does not identify which AWS account is live — searching now could silently hit ` +
              `the wrong environment.\n\n` +
              `Add the expected account to '${env}' in ~/.aws-logs-mcp/config.json:\n` +
              `  "${env}": { "profile": "${e.profile}", "accountId": "<12-digit account id>", ... }\n\n` +
              `Activate the ${e.name ?? env} session in your credential tool and run ` +
              `check_credentials to read its account id. Nothing was searched.`,
          ),
          { name: "AmbiguousEnvironment" },
        );
      }
      return undefined;
    }

    const identity = await this.getCallerIdentity(env);
    if (identity.accountId === e.accountId) return identity;

    throw Object.assign(
      new Error(
        `Environment '${env}' expects AWS account ${e.accountId}` +
          `${e.name ? ` (${e.name})` : ""}, but profile '${e.profile}' is currently ` +
          `authenticated to account ${identity.accountId}.\n\n` +
          `Profile '${e.profile}' is shared across environments, so its credentials ` +
          `reflect whichever session is currently active. Switch to the ` +
          `${e.name ?? env} session in your credential tool (e.g. Leapp), then retry. ` +
          `Nothing was searched.`,
      ),
      { name: "AccountMismatch" },
    );
  }

  /** Drop cached clients and identities so the next call re-resolves credentials. */
  refresh(): void {
    this.close();
  }

  /** Profile metadata (region, sso_session) as read from ~/.aws — never secrets. */
  describeProfiles(): ReturnType<typeof readAwsProfiles> {
    return readAwsProfiles();
  }

  /**
   * Resolve credentials without calling STS. Used to distinguish "the profile
   * is broken" from "the profile is fine but lacks CloudWatch permissions".
   */
  async probeCredentials(
    env: string,
  ): Promise<
    | { ok: true; expiration?: string; source: string }
    | { ok: false; failure: AwsFailure }
  > {
    const e = this.getEnvironment(env);
    try {
      const creds = await this.credentials(env)();
      return {
        ok: true,
        expiration: creds.expiration?.toISOString(),
        source: creds.expiration
          ? "temporary (SSO / assumed role)"
          : "static keys",
      };
    } catch (err) {
      return {
        ok: false,
        failure: classifyAwsError(err, {
          env,
          profile: e.profile,
          region: e.region,
          operation: "resolve credentials",
        }),
      };
    }
  }

  /** Swap in a freshly loaded config, dropping every cached client. */
  reloadConfig(config: Config): void {
    this.close();
    this.config = config;
  }

  close(): void {
    for (const client of this.logsClients.values()) {
      try {
        client.destroy();
      } catch {
        // Destroying a client that never opened a socket can throw; ignore.
      }
    }
    this.logsClients.clear();
    this.identities.clear();
  }
}
