/**
 * Token persistence and refresh for FreshBooks OAuth2.
 *
 * Tokens are stored at ~/.freshbooks-mcp/tokens.json with mode 0600.
 * The file holds the access_token, refresh_token, expiry, and the
 * discovered account_id + business_name so we don't refetch on every start.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  // Unix epoch seconds at which the access token expires.
  expires_at: number;
  // Discovered after first auth via /auth/api/v1/users/me.
  account_id: string;
  business_id?: number;
  business_name?: string;
  // ISO timestamp when this bundle was last written.
  updated_at: string;
}

export interface AppCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

const TOKEN_URL = "https://api.freshbooks.com/auth/oauth/token";

export function defaultTokensPath(): string {
  const override = process.env.FRESHBOOKS_TOKENS_PATH;
  if (override && override.length > 0) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : override;
  }
  return path.join(os.homedir(), ".freshbooks-mcp", "tokens.json");
}

/**
 * Optional override for the account_id used in /accounting and /uploads paths.
 * When unset, the value discovered during setup (stored in tokens.json) is used.
 */
export function accountIdOverride(): string | undefined {
  const v = process.env.FRESHBOOKS_ACCOUNT_ID;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Optional override for the business_id used in /projects and /timetracking paths.
 * When unset, the value discovered during setup (stored in tokens.json) is used.
 */
export function businessIdOverride(): number | undefined {
  const v = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!v || v.trim().length === 0) return undefined;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `FRESHBOOKS_BUSINESS_ID must be a positive integer, got: ${v}`,
    );
  }
  return n;
}

export function loadAppCredentials(): AppCredentials {
  const client_id = process.env.FRESHBOOKS_CLIENT_ID;
  const client_secret = process.env.FRESHBOOKS_CLIENT_SECRET;
  const redirect_uri =
    process.env.FRESHBOOKS_REDIRECT_URI ?? "https://localhost:8765/callback";
  if (!client_id || !client_secret) {
    throw new Error(
      "Missing FRESHBOOKS_CLIENT_ID or FRESHBOOKS_CLIENT_SECRET. " +
        "Set them in your environment (or in the env block of your Claude Desktop config) " +
        "and re-run setup if you have not yet authorized.",
    );
  }
  return { client_id, client_secret, redirect_uri };
}

/**
 * Load tokens from disk. Refuses to read a world- or group-readable file.
 */
export async function loadTokens(
  filePath = defaultTokensPath(),
): Promise<TokenBundle> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new Error(
      `No tokens file at ${filePath}. Run the freshbooks-setup command to authorize FreshBooks.`,
    );
  }
  // On non-Windows, enforce 0600. mode is the low 9 bits of stat.mode.
  if (process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `Refusing to read ${filePath}: permissions are ${mode.toString(8)}, ` +
          `must be 600. Run: chmod 600 ${filePath}`,
      );
    }
  }
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as TokenBundle;
  if (!parsed.access_token || !parsed.refresh_token || !parsed.account_id) {
    throw new Error(
      `Tokens file at ${filePath} is missing required fields. Re-run \`npm run setup\`.`,
    );
  }
  return parsed;
}

/**
 * Persist tokens with mode 0600. Creates the parent dir if needed.
 */
export async function saveTokens(
  tokens: TokenBundle,
  filePath = defaultTokensPath(),
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(tokens, null, 2);
  // Write with restrictive mode from the start.
  await fs.writeFile(filePath, json, { mode: 0o600, encoding: "utf8" });
  // Belt-and-suspenders: chmod in case umask interfered.
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeAuthCode(
  creds: AppCredentials,
  code: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const body = {
    grant_type: "authorization_code",
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: creds.redirect_uri,
    code,
  };
  return doTokenRequest(body);
}

/**
 * Use a refresh token to get a new access token.
 */
export async function refreshAccessToken(
  creds: AppCredentials,
  refresh_token: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const body = {
    grant_type: "refresh_token",
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: creds.redirect_uri,
    refresh_token,
  };
  return doTokenRequest(body);
}

async function doTokenRequest(body: Record<string, string>): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Never echo the request body — it contains the client_secret.
    throw new Error(
      `FreshBooks token endpoint returned ${res.status}: ${truncate(text, 500)}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(
      "FreshBooks token response missing access_token or refresh_token.",
    );
  }
  return data;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Compute expires_at (epoch seconds) from a Date and expires_in seconds,
 * subtracting a 60s safety margin so we refresh before the server thinks it expired.
 */
export function computeExpiresAt(
  expires_in: number,
  now: Date = new Date(),
): number {
  return Math.floor(now.getTime() / 1000) + expires_in - 60;
}
