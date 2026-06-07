/**
 * Typed FreshBooks API client.
 *
 * - Auto-refreshes the access token on 401 (single retry).
 * - Respects 429 Retry-After (single retry with capped backoff).
 * - Unwraps the FreshBooks `{ response: { result: { ... } } }` envelope.
 * - Builds URLs with URL/URLSearchParams — no string concatenation.
 * - attachFileToInvoice: uploads a file to FreshBooks and associates it with an invoice.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  type AppCredentials,
  type TokenBundle,
  accountIdOverride,
  businessIdOverride,
  computeExpiresAt,
  loadTokens,
  refreshAccessToken,
  saveTokens,
} from "./auth.js";

const API_BASE = "https://api.freshbooks.com";

export interface ClientOptions {
  creds: AppCredentials;
  tokens: TokenBundle;
  tokensPath: string;
  // Default request timeout in ms.
  timeoutMs?: number;
}

export class FreshBooksError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "FreshBooksError";
    this.status = status;
    this.body = body;
  }
}

export class FreshBooksClient {
  private creds: AppCredentials;
  private tokens: TokenBundle;
  private tokensPath: string;
  private timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.creds = opts.creds;
    this.tokens = opts.tokens;
    this.tokensPath = opts.tokensPath;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // FRESHBOOKS_ACCOUNT_ID / FRESHBOOKS_BUSINESS_ID env vars take precedence over
  // the values discovered during setup — useful when one FreshBooks login owns
  // multiple businesses and you want to target one other than the first.
  get accountId(): string {
    return accountIdOverride() ?? this.tokens.account_id;
  }

  get businessName(): string | undefined {
    return this.tokens.business_name;
  }

  get businessId(): number | undefined {
    return businessIdOverride() ?? this.tokens.business_id;
  }

  /**
   * Low-level request. Handles auth refresh on 401 and Retry-After on 429.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathname: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    return this.requestWithRetry(method, pathname, options, 0);
  }

  private async requestWithRetry<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathname: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    },
    attempt: number,
  ): Promise<T> {
    // Reload tokens from disk on the first attempt so changes to tokens.json
    // (e.g. switching account_id) take effect without restarting the server.
    if (attempt === 0) {
      try {
        this.tokens = await loadTokens(this.tokensPath);
      } catch {
        // If reload fails, continue with cached tokens.
      }
    }

    const url = new URL(pathname, API_BASE);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens.access_token}`,
      "Api-Version": "alpha",
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 401 -> try one refresh, then retry once.
    if (res.status === 401 && attempt === 0) {
      await this.refresh();
      return this.requestWithRetry<T>(method, pathname, options, attempt + 1);
    }

    // 429 -> respect Retry-After (single retry).
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const delayMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
      await new Promise((r) => setTimeout(r, delayMs));
      return this.requestWithRetry<T>(method, pathname, options, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave as text */
      }
      throw new FreshBooksError(
        `FreshBooks ${method} ${pathname} failed: ${res.status}`,
        res.status,
        parsed,
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Refresh the access token and persist the new bundle.
   * Throws with a clear "re-run setup" hint if the refresh token is rejected.
   */
  private async refresh(): Promise<void> {
    try {
      const fresh = await refreshAccessToken(
        this.creds,
        this.tokens.refresh_token,
      );
      this.tokens = {
        ...this.tokens,
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expires_at: computeExpiresAt(fresh.expires_in),
        updated_at: new Date().toISOString(),
      };
      await saveTokens(this.tokens, this.tokensPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `FreshBooks token refresh failed (${msg}). ` +
          "Re-run the freshbooks-setup command to re-authorize.",
        { cause: err },
      );
    }
  }

  // ---------- Domain helpers (unwrap FreshBooks envelopes) ----------

  /**
   * Accounting endpoints wrap responses in { response: { result: { ... } } }.
   * If `resultKey` is provided, returns result[key] (e.g. "invoice", "client").
   * If empty string, returns the whole result object (used for list endpoints
   * where the result holds the collection plus pagination siblings).
   */
  async accounting<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathname: string,
    resultKey: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    type Envelope = { response: { result: Record<string, unknown> } };
    const env = await this.request<Envelope>(method, pathname, options);
    if (!env || !env.response || !env.response.result) {
      throw new FreshBooksError(
        `Unexpected response shape from ${pathname}`,
        200,
        env,
      );
    }
    if (resultKey === "") {
      return env.response.result as T;
    }
    return env.response.result[resultKey] as T;
  }

  /**
   * Identity endpoints (/auth/api/v1/...) return { response: { ... } } without `result`.
   */
  async identity<T>(pathname: string): Promise<T> {
    type Envelope = { response: T };
    const env = await this.request<Envelope>("GET", pathname);
    if (!env || !env.response) {
      throw new FreshBooksError(
        `Unexpected identity response from ${pathname}`,
        200,
        env,
      );
    }
    return env.response;
  }

  /**
   * Upload a local file as a FreshBooks attachment, then associate it with an invoice.
   *
   * FreshBooks two-step process:
   *   1. POST /uploads/account/{id}/attachments  (multipart/form-data)
   *      → returns { jwt, public_id } to identify the upload
   *   2. POST /accounting/account/{id}/invoices/invoices/{inv}/attachments
   *      → binds the upload to the invoice
   */
  async attachFileToInvoice(
    invoiceId: number,
    filePath: string,
  ): Promise<{ fileName: string; attached: boolean }> {
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);

    // ── Step 1: upload ────────────────────────────────────────────────────────
    const formData = new FormData();
    const blob = new Blob([fileBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    formData.append("content", blob, fileName);

    const uploadUrl = `${API_BASE}/uploads/account/${this.tokens.account_id}/attachments`;
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.tokens.access_token}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new FreshBooksError(
        `Attachment upload failed: ${uploadRes.status}`,
        uploadRes.status,
        text,
      );
    }

    // The uploads endpoint returns several possible shapes depending on API version.
    // Try each known path before giving up.
    const uploadJson = (await uploadRes.json()) as Record<string, unknown>;
    const att =
      ((uploadJson?.["response"] as Record<string, unknown> | undefined)?.[
        "result"
      ] as Record<string, unknown> | undefined) ??
      (uploadJson?.["attachment"] as Record<string, unknown> | undefined) ??
      uploadJson;

    const jwt = (att?.["jwt"] as string | undefined) ?? undefined;
    const publicId = (att?.["public_id"] as string | undefined) ?? undefined;

    if (!jwt && !publicId) {
      throw new FreshBooksError(
        `Attachment upload succeeded but response contained no jwt or public_id`,
        uploadRes.status,
        uploadJson,
      );
    }

    // ── Step 2: associate with invoice ────────────────────────────────────────
    const attachBody: Record<string, unknown> = { name: fileName };
    if (jwt) attachBody["jwt"] = jwt;
    if (publicId) attachBody["public_id"] = publicId;

    const assocPath = `/accounting/account/${this.accountId}/invoices/invoices/${invoiceId}/attachments`;

    await this.request("POST", assocPath, { body: { attachment: attachBody } });

    return { fileName, attached: true };
  }
}
