import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AWS_CONFIG_FILE =
  process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
export const AWS_CREDENTIALS_FILE =
  process.env.AWS_SHARED_CREDENTIALS_FILE ??
  join(homedir(), ".aws", "credentials");

export interface ProfileInfo {
  name: string;
  region?: string;
  ssoSession?: string;
  ssoStartUrl?: string;
  roleArn?: string;
  sourceProfile?: string;
}

/**
 * Only these keys are ever read out of the shared AWS files. Credential
 * material (aws_access_key_id, aws_secret_access_key, aws_session_token) is
 * deliberately excluded so it never enters this process's memory — the SDK
 * resolves those itself, out of our sight.
 */
const SAFE_KEYS: Record<string, keyof ProfileInfo> = {
  region: "region",
  sso_session: "ssoSession",
  sso_start_url: "ssoStartUrl",
  role_arn: "roleArn",
  source_profile: "sourceProfile",
};

function parseFile(
  file: string,
  stripProfilePrefix: boolean,
  out: Map<string, ProfileInfo>,
): void {
  if (!existsSync(file)) return;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }

  let current: ProfileInfo | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      let name = section[1].trim();
      // [sso-session foo] blocks describe a session, not a profile.
      if (name.startsWith("sso-session ")) {
        current = undefined;
        continue;
      }
      if (stripProfilePrefix && name.startsWith("profile ")) {
        name = name.slice("profile ".length).trim();
      }
      if (!name) {
        current = undefined;
        continue;
      }
      // The same profile can appear in both files; merge rather than replace.
      current = out.get(name) ?? { name };
      out.set(name, current);
      continue;
    }

    if (!current) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const field = SAFE_KEYS[key];
    if (!field) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (value) (current[field] as string) = value;
  }
}

export function readAwsProfiles(): Map<string, ProfileInfo> {
  const out = new Map<string, ProfileInfo>();
  parseFile(AWS_CONFIG_FILE, true, out);
  parseFile(AWS_CREDENTIALS_FILE, false, out);
  return out;
}

export function listAvailableProfiles(): string[] {
  return [...readAwsProfiles().keys()].sort();
}

export interface RegionDefaults {
  /** Map an sso_session name to a default region, e.g. { trajector: "us-east-2" }. */
  bySsoSession?: Record<string, string>;
  fallback?: string;
}

export interface ResolvedRegion {
  region: string;
  source: string;
}

/**
 * Work out which region a profile should query.
 *
 * Tools like Leapp write the region into the profile itself, so reading it from
 * there is both less to configure and less to get out of sync. Explicit config
 * still wins when someone needs to override it.
 */
export function resolveRegion(
  profileName: string,
  explicit: string | undefined,
  defaults: RegionDefaults | undefined,
  profiles: Map<string, ProfileInfo> = readAwsProfiles(),
): ResolvedRegion {
  if (explicit) return { region: explicit, source: "config" };

  const profile = profiles.get(profileName);

  if (profile?.region) {
    return { region: profile.region, source: `profile '${profileName}'` };
  }

  // Follow a role chain to its source profile, which is usually where the
  // region actually lives.
  if (profile?.sourceProfile) {
    const parent = profiles.get(profile.sourceProfile);
    if (parent?.region) {
      return {
        region: parent.region,
        source: `source_profile '${profile.sourceProfile}'`,
      };
    }
  }

  const bySession = defaults?.bySsoSession ?? {};
  if (profile?.ssoSession && bySession[profile.ssoSession]) {
    return {
      region: bySession[profile.ssoSession],
      source: `regionDefaults.bySsoSession['${profile.ssoSession}']`,
    };
  }

  const fallback = defaults?.fallback ?? "us-east-1";
  return { region: fallback, source: "regionDefaults.fallback" };
}
