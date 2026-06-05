# freshbooks-mcp

A local MCP (Model Context Protocol) server that gives Claude Desktop access to your FreshBooks invoices. List, view, create, update, send, and (soft-)delete invoices, plus list clients and items so you can construct invoices end-to-end.

- **Transport:** stdio (single user, runs on your machine)
- **Auth:** OAuth2 with refresh-token persistence at `~/.freshbooks-mcp/tokens.json` (mode 0600)
- **Runtime:** Node 20+, TypeScript built to ESM

## Prerequisites

- Node.js 20 or newer
- A FreshBooks account with API access
- Claude Desktop (https://claude.ai/download)
- **mkcert** — generates a locally-trusted TLS cert so the OAuth callback can run over HTTPS (required by FreshBooks):
  ```bash
  brew install mkcert
  mkcert -install   # installs the local CA — only needed once per machine
  ```

## 1. Create a FreshBooks developer app

FreshBooks uses OAuth2, so you need a developer app to get a Client ID and Secret.

1. Sign in at https://my.freshbooks.com.
2. Open https://my.freshbooks.com/#/developer.
3. Click **Create an App**. Give it a name like `Claude MCP (local)` and a short description. The app type is "Private app" or similar — there is no review process for private apps.
4. Under **Redirect URIs**, add exactly:
   ```
   https://localhost:8765/callback
   ```
   (If you need a different port, set `FRESHBOOKS_REDIRECT_URI` in the environment before running setup, and add the matching URL to your app. Must be HTTPS.)
5. Save. Copy the **Client ID** and **Client Secret** somewhere private — you'll paste them into a `.env` file in the next step.

The required scopes are the defaults (read/write on accounting resources). FreshBooks will prompt you to consent during the OAuth flow.

## 2. Install and build

```bash
npm install
npm run build
```

## 3. Run setup (one-time OAuth)

Create a `.env` in the project root (copy from `.env.example`):

```
FRESHBOOKS_CLIENT_ID=your_client_id
FRESHBOOKS_CLIENT_SECRET=your_client_secret
```

Then:

```bash
npm run setup
```

What happens:

1. Your default browser opens to `https://auth.freshbooks.com/oauth/authorize/...`. Sign in and approve.
2. FreshBooks redirects to `https://localhost:8765/callback` with an auth code. The setup script catches it via a one-shot local HTTPS listener (using a mkcert-generated cert) and exchanges it for tokens.
3. The script calls `/auth/api/v1/users/me` to discover your `account_id` and business name.
4. Tokens are written to `~/.freshbooks-mcp/tokens.json` with mode 0600. The directory `~/.freshbooks-mcp` is created with mode 0700.
5. The script prints a Claude Desktop config snippet — copy it.

If you have multiple businesses on your FreshBooks account, the script picks the first one and prints a note. To target a different one, set `FRESHBOOKS_ACCOUNT_ID` and `FRESHBOOKS_BUSINESS_ID` in the server env (these override the discovered values). See "Multiple businesses on one FreshBooks account" below.

## 4. Add to Claude Desktop config

Open the Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Paste the snippet that `npm run setup` printed into the `mcpServers` object. It looks like:

```json
{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["/Users/mp/.claude/mcp-servers/freshbooks/dist/index.js"],
      "env": {
        "FRESHBOOKS_CLIENT_ID": "your_client_id",
        "FRESHBOOKS_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Both `FRESHBOOKS_CLIENT_ID` and `FRESHBOOKS_CLIENT_SECRET` are required at runtime: the server uses them to refresh the access token when it expires (every ~12h).

The server also reads a `.env` file in the project root on startup as a fallback, so any `FRESHBOOKS_*` var not present in the `env` block above is picked up from there. The `env` block always takes precedence. Recognized vars: `FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET`, `FRESHBOOKS_REDIRECT_URI`, `FRESHBOOKS_TOKENS_PATH`, `FRESHBOOKS_ACCOUNT_ID`, `FRESHBOOKS_BUSINESS_ID` — see `.env.example`.

Restart Claude Desktop. You should see `freshbooks` appear in the tools menu.

## Available tools

All tools accept structured JSON input. Below are the inputs for each.

### Invoices

- **`list_invoices`** — `{ status?, client_id?, date_from?, date_to?, search?, page?, per_page? }`
  Filter by `v3_status` (`draft`, `sent`, `viewed`, `paid`, `overdue`, ...), client, date range, or invoice number substring. Default `per_page` is 20.
- **`get_invoice`** — `{ invoice_id: number }`
- **`create_invoice`** — `{ client_id, lines: [{ description, qty, unit_cost, name?, taxName1?, taxAmount1? }], currency_code?, due_offset_days?, notes?, terms?, invoice_number?, create_date? }`
  `unit_cost` is a decimal (e.g. `75.00` for $75), not cents. Tax amounts are percentages (e.g. `13` for 13%).
- **`update_invoice`** — `{ invoice_id, notes?, terms?, due_offset_days?, invoice_number?, lines? }`
  Partial update. Note: if you pass `lines`, it **replaces** all line items on the invoice.
- **`send_invoice`** — `{ invoice_id, recipients?, subject?, body? }`
  Emails the invoice (FreshBooks `action_email: true`). Defaults to the client's email on file.
- **`delete_invoice`** — `{ invoice_id }`
  **Soft delete.** Sets `vis_state=1`. The invoice is recoverable from the FreshBooks UI's deleted items view; this server does not expose a permanent-delete tool.

### Clients

- **`list_clients`** — `{ search?, page?, per_page? }`
- **`get_client`** — `{ client_id: number }`

### Items

- **`list_items`** — `{ search?, page?, per_page? }`
  Saved line items, useful when constructing invoices.

### Account

- **`get_account_info`** — `{}`
  Returns `{ account_id, business_id, business_name }`. Use this to verify setup.

## Example prompts in Claude Desktop

- "List all overdue invoices."
- "Show me invoice 12345."
- "Find clients matching 'Acme'."
- "Draft an invoice to client 678910 for 8 hours of consulting at $150/hr, due in 30 days."
- "Email invoice 12345 to billing@example.com with subject 'March invoice'."

Claude will ask for confirmation before destructive actions like `delete_invoice` or `send_invoice` — review the proposed input before approving.

## Security notes

- Tokens are stored at `~/.freshbooks-mcp/tokens.json` with mode 0600. The server refuses to start if the file is group- or world-readable.
- The client secret is loaded from environment variables, not from disk.
- `Authorization` headers are never logged. The client redacts request bodies in error messages.
- All tool inputs are validated with strict Zod schemas (extra fields are rejected).
- The OAuth setup uses a CSRF `state` parameter and verifies it on the callback.
- The server binds the OAuth callback listener to `127.0.0.1` only.

## Troubleshooting

### `Refusing to read ~/.freshbooks-mcp/tokens.json: permissions are 644, must be 600`

The token file is too permissive. Fix:

```bash
chmod 600 ~/.freshbooks-mcp/tokens.json
chmod 700 ~/.freshbooks-mcp
```

### `FreshBooks token refresh failed ... Re-run npm run setup to re-authorize.`

The refresh token has been revoked or expired. Re-run `npm run setup`. Common causes:

- You changed your FreshBooks password.
- You revoked the app's access in your FreshBooks settings.
- The refresh token has been unused for a very long time.

### `Could not refresh FreshBooks access token at startup`

Same as above. The server proactively refreshes if the access token is within 60s of expiry, so this surfaces stale-refresh-token problems early.

### Claude Desktop says the server crashed / disappeared

1. Check Claude Desktop's log file (Help -> Open Developer Tools -> Console for the renderer; the main process log is in the same directory as the config file).
2. Run the server manually to see its stderr:
   ```bash
   FRESHBOOKS_CLIENT_ID=... FRESHBOOKS_CLIENT_SECRET=... node /Users/mp/.claude/mcp-servers/freshbooks/dist/index.js
   ```
   It will sit waiting for stdio JSON-RPC; press Ctrl+C to exit. If startup failed it prints `[freshbooks-mcp] fatal: ...` to stderr.
3. Common fix: re-run `npm run build` after pulling updates.

### `429 Too Many Requests` showing up

The server respects FreshBooks' `Retry-After` header automatically (single retry). If you're hitting the limit consistently, increase `per_page` to fetch more per call, or cache results in your conversation.

### Multiple businesses on one FreshBooks account

`npm run setup` picks the first business and prints a note. To target a different one, set these in the server's `env` block (they take precedence over the discovered values in `tokens.json`):

```json
"env": {
  "FRESHBOOKS_CLIENT_ID": "your_client_id",
  "FRESHBOOKS_CLIENT_SECRET": "your_client_secret",
  "FRESHBOOKS_ACCOUNT_ID": "abc123",
  "FRESHBOOKS_BUSINESS_ID": "456"
}
```

`FRESHBOOKS_ACCOUNT_ID` is used for `/accounting` and `/uploads` paths (invoices, clients, items, attachments); `FRESHBOOKS_BUSINESS_ID` is used for `/projects` and `/timetracking` paths (time entries, timesheets). You can find both by hitting `https://api.freshbooks.com/auth/api/v1/users/me` with your access token, or by running the `get_account_info` tool. (Editing `~/.freshbooks-mcp/tokens.json` directly still works too — the server re-reads it on each request — but env vars are the cleaner option.)

## File layout

```
src/
  index.ts              # MCP server entry (stdio)
  setup.ts              # OAuth setup CLI
  freshbooks/
    auth.ts             # token load/save/refresh
    client.ts           # API client with auto-refresh + 429 handling
    types.ts            # FreshBooks DTOs
  tools/
    invoices.ts         # list/get/create/update/send/delete
    clients.ts          # list/get
    items.ts            # list
    account.ts          # get_account_info
```

## License

Private — for personal use.
