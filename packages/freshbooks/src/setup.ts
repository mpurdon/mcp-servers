#!/usr/bin/env node
/**
 * Interactive OAuth setup CLI.
 *
 * Flow:
 *   1. Read FRESHBOOKS_CLIENT_ID/SECRET from env (or .env if present).
 *   2. Ensure a locally-trusted TLS cert exists via mkcert (required because
 *      FreshBooks only accepts HTTPS redirect URIs).
 *   3. Open the FreshBooks authorize URL in the default browser.
 *   4. Spin up a one-shot HTTPS listener on https://localhost:8765/callback
 *      to capture the authorization code.
 *   5. Exchange code for tokens.
 *   6. Hit /auth/api/v1/users/me to discover account_id/business_name.
 *   7. Persist {access_token, refresh_token, expires_at, account_id, ...} to
 *      ~/.freshbooks-mcp/tokens.json with mode 0600.
 *   8. Print the exact Claude Desktop config snippet.
 *
 * Reads .env from cwd if FRESHBOOKS_CLIENT_ID is not already set in env.
 *
 * Prerequisites:
 *   brew install mkcert
 *   mkcert -install   (once per machine — installs the local CA)
 */

import https from "node:https";
import { exec, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";

import {
  computeExpiresAt,
  defaultTokensPath,
  exchangeAuthCode,
  loadAppCredentials,
  saveTokens,
  type AppCredentials,
  type TokenBundle,
} from "./freshbooks/auth.js";
import { loadDotEnv } from "./freshbooks/dotenv.js";

const AUTHORIZE_URL = "https://auth.freshbooks.com/oauth/authorize/";
const IDENTITY_URL = "https://api.freshbooks.com/auth/api/v1/users/me";
const CERTS_DIR = path.join(os.homedir(), ".freshbooks-mcp");

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      process.stderr.write(`(could not auto-open browser: ${err.message})\n`);
    }
  });
}

/**
 * Ensure mkcert-generated TLS cert files exist for localhost.
 * Certs are stored in ~/.freshbooks-mcp/ alongside tokens.
 * Returns the PEM-encoded key and cert as strings.
 */
async function ensureCerts(): Promise<{ key: string; cert: string }> {
  const keyPath = path.join(CERTS_DIR, "localhost-key.pem");
  const certPath = path.join(CERTS_DIR, "localhost.pem");

  const keyExists = await fs
    .stat(keyPath)
    .then(() => true)
    .catch(() => false);
  const certExists = await fs
    .stat(certPath)
    .then(() => true)
    .catch(() => false);

  if (!keyExists || !certExists) {
    // Check mkcert is available.
    const hasMkcert =
      process.platform === "win32"
        ? (() => {
            try {
              execSync("where mkcert", { stdio: "pipe" });
              return true;
            } catch {
              return false;
            }
          })()
        : (() => {
            try {
              execSync("which mkcert", { stdio: "pipe" });
              return true;
            } catch {
              return false;
            }
          })();

    if (!hasMkcert) {
      throw new Error(
        "mkcert is required to create a locally-trusted TLS certificate for the OAuth callback,\n" +
          "because FreshBooks only accepts HTTPS redirect URIs.\n\n" +
          "Install it and set up the local CA:\n" +
          "  brew install mkcert\n" +
          "  mkcert -install        # installs the local CA — only needed once per machine\n\n" +
          "Then re-run: npm run setup",
      );
    }

    process.stdout.write(
      "Generating locally-trusted TLS certificate with mkcert...\n",
    );
    await fs.mkdir(CERTS_DIR, { recursive: true, mode: 0o700 });
    execSync(
      `mkcert -key-file "${keyPath}" -cert-file "${certPath}" localhost 127.0.0.1`,
      { stdio: "inherit" },
    );
    process.stdout.write(`TLS cert saved to ${CERTS_DIR}\n`);
  } else {
    process.stdout.write("Using existing TLS cert.\n");
  }

  const [key, cert] = await Promise.all([
    fs.readFile(keyPath, "utf8"),
    fs.readFile(certPath, "utf8"),
  ]);
  return { key, cert };
}

interface CallbackResult {
  code: string;
  state: string | null;
}

/**
 * Listens on the redirect URI over HTTPS for exactly one /callback request.
 * Closes the server and resolves on success, rejects on error/timeout.
 */
async function awaitCallback(
  redirectUri: string,
  expectedState: string,
  tlsCreds: { key: string; cert: string },
  timeoutMs = 5 * 60 * 1000,
): Promise<CallbackResult> {
  const parsed = new URL(redirectUri);
  const port = Number(parsed.port || 443);
  const expectedPath = parsed.pathname;

  return new Promise<CallbackResult>((resolve, reject) => {
    const server = https.createServer(
      { key: tlsCreds.key, cert: tlsCreds.cert },
      (req, res) => {
        if (!req.url) {
          res.statusCode = 400;
          res.end("missing url");
          return;
        }
        const reqUrl = new URL(req.url, `https://localhost:${port}`);
        if (reqUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(htmlPage(`Authorization failed: ${escapeHtml(error)}`));
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(htmlPage("No authorization code in callback URL."));
          server.close();
          reject(new Error("No code in callback"));
          return;
        }
        if (state !== expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(htmlPage("State mismatch — possible CSRF. Aborting."));
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          htmlPage(
            "Authorization complete. You can close this tab and return to your terminal.",
          ),
        );
        server.close();
        resolve({ code, state });
      },
    );

    server.on("error", (err) => reject(err));
    server.listen(port, "127.0.0.1");

    setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for callback.`,
        ),
      );
    }, timeoutMs).unref();
  });
}

function htmlPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>FreshBooks MCP</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:3rem;max-width:40rem;margin:auto;color:#222}</style>
</head><body><h2>FreshBooks MCP setup</h2><p>${message}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

async function discoverAccount(accessToken: string): Promise<{
  account_id: string;
  business_id?: number;
  business_name?: string;
}> {
  const res = await fetch(IDENTITY_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Api-Version": "alpha",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Identity lookup failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    response?: {
      business_memberships?: Array<{
        business: { id: number; name: string; account_id: string };
      }>;
    };
  };
  const memberships = data.response?.business_memberships ?? [];
  if (memberships.length === 0) {
    throw new Error(
      "No business memberships found on this FreshBooks user. " +
        "Make sure you authorized with the correct account.",
    );
  }
  if (memberships.length > 1) {
    process.stderr.write(
      `Note: ${memberships.length} businesses found; using "${memberships[0]!.business.name}". ` +
        "Edit ~/.freshbooks-mcp/tokens.json manually if you want a different one.\n",
    );
  }
  const m = memberships[0]!;
  return {
    account_id: m.business.account_id,
    business_id: m.business.id,
    business_name: m.business.name,
  };
}

function buildAuthorizeUrl(creds: AppCredentials, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", creds.client_id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", creds.redirect_uri);
  url.searchParams.set("state", state);
  return url.toString();
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function printClaudeDesktopSnippet(creds: AppCredentials): void {
  const distPath = path.resolve(process.cwd(), "dist", "index.js");
  const snippet = {
    mcpServers: {
      freshbooks: {
        command: "node",
        args: [distPath],
        env: {
          FRESHBOOKS_CLIENT_ID: creds.client_id,
          FRESHBOOKS_CLIENT_SECRET: creds.client_secret,
        },
      },
    },
  };
  process.stdout.write("\n--- Claude Desktop config snippet ---\n");
  process.stdout.write(
    "Paste the `freshbooks` entry into the `mcpServers` object in:\n",
  );
  process.stdout.write(
    "  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json\n",
  );
  process.stdout.write(
    "  Windows: %APPDATA%\\Claude\\claude_desktop_config.json\n\n",
  );
  process.stdout.write(JSON.stringify(snippet, null, 2));
  process.stdout.write("\n\n");
  process.stdout.write(
    "(The client secret is included above — keep this snippet private.)\n",
  );
}

async function main(): Promise<void> {
  await loadDotEnv();
  const creds = loadAppCredentials();
  const tlsCreds = await ensureCerts();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(creds, state);

  process.stdout.write("Opening FreshBooks authorization in your browser.\n");
  process.stdout.write(
    `If it does not open, paste this URL manually:\n\n  ${authUrl}\n\n`,
  );
  openInBrowser(authUrl);

  process.stdout.write(`Listening on ${creds.redirect_uri} for callback...\n`);
  const { code } = await awaitCallback(creds.redirect_uri, state, tlsCreds);
  process.stdout.write("Got authorization code, exchanging for tokens...\n");

  const exchanged = await exchangeAuthCode(creds, code);
  process.stdout.write("Got tokens, discovering account...\n");
  const account = await discoverAccount(exchanged.access_token);

  const bundle: TokenBundle = {
    access_token: exchanged.access_token,
    refresh_token: exchanged.refresh_token,
    expires_at: computeExpiresAt(exchanged.expires_in),
    account_id: account.account_id,
    business_id: account.business_id,
    business_name: account.business_name,
    updated_at: new Date().toISOString(),
  };
  const tokensPath = defaultTokensPath();
  await saveTokens(bundle, tokensPath);
  process.stdout.write(`Tokens saved to ${tokensPath} (mode 0600).\n`);
  process.stdout.write(
    `Connected to business: ${account.business_name ?? "(unnamed)"} ` +
      `(account_id=${account.account_id}).\n`,
  );

  printClaudeDesktopSnippet(creds);

  process.stdout.write("Setup complete.\n");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[setup] failed: ${msg}\n`);
  process.exit(1);
});
