#!/usr/bin/env node
/**
 * FreshBooks MCP server (stdio transport for Claude Desktop).
 *
 * On startup:
 *   1. Load app credentials from env (FRESHBOOKS_CLIENT_ID/SECRET).
 *   2. Load tokens from disk (default ~/.freshbooks-mcp/tokens.json, mode 0600 enforced).
 *   3. If access token is expired, refresh proactively before serving the first request.
 *   4. Register tools and start the stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  computeExpiresAt,
  defaultTokensPath,
  loadAppCredentials,
  loadTokens,
  refreshAccessToken,
  saveTokens,
} from "./freshbooks/auth.js";
import { FreshBooksClient } from "./freshbooks/client.js";
import { loadDotEnv } from "./freshbooks/dotenv.js";

import {
  CreateInvoiceInput,
  DeleteInvoiceInput,
  GetInvoiceInput,
  ListInvoicesInput,
  SendInvoiceInput,
  UpdateInvoiceInput,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  sendInvoice,
  updateInvoice,
} from "./tools/invoices.js";
import {
  GetClientInput,
  ListClientsInput,
  getClient,
  listClients,
} from "./tools/clients.js";
import { ListItemsInput, listItems } from "./tools/items.js";
import { GetAccountInfoInput, getAccountInfo } from "./tools/account.js";
import {
  GenerateTimesheetInput,
  generateTimesheet,
} from "./tools/timesheet.js";
import {
  GenerateInvoiceInput,
  generateInvoice,
} from "./tools/invoice_generator.js";
import {
  ListTimeEntriesInput,
  CreateTimeEntryInput,
  listTimeEntries,
  createTimeEntry,
} from "./tools/time_entries.js";

const SERVER_NAME = "freshbooks";
const SERVER_VERSION = "0.1.0";

function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  // Surface FreshBooks API error bodies when present, but never echo headers.
  const body =
    err && typeof err === "object" && "body" in err
      ? (err as { body: unknown }).body
      : undefined;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: message,
          ...(body !== undefined ? { detail: body } : {}),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Adapter: wraps a typed handler so it conforms to the MCP SDK's tool callback
 * signature. The SDK already validates inputs against the registered ZodRawShape
 * before invoking the callback, so we accept its loose `{[x: string]: any}` shape
 * and re-cast through `unknown` to our typed handler. Errors are mapped to
 * isError results so Claude can reason about failures.
 */
function tool<T extends z.ZodObject<z.ZodRawShape>>(
  _schema: T,
  handler: (input: z.infer<T>) => Promise<unknown>,
) {
  return async (raw: { [x: string]: unknown }) => {
    try {
      const input = raw as unknown as z.infer<T>;
      return jsonResult(await handler(input));
    } catch (err) {
      return errorResult(err);
    }
  };
}

async function main(): Promise<void> {
  // Pick up FRESHBOOKS_* vars from a .env file if present (env block always wins).
  await loadDotEnv();
  const creds = loadAppCredentials();
  const tokensPath = defaultTokensPath();
  const tokens = await loadTokens(tokensPath);

  // Proactive refresh if expired or expiring within 60s.
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokens.expires_at <= nowSec + 60) {
    try {
      const fresh = await refreshAccessToken(creds, tokens.refresh_token);
      tokens.access_token = fresh.access_token;
      tokens.refresh_token = fresh.refresh_token;
      tokens.expires_at = computeExpiresAt(fresh.expires_in);
      tokens.updated_at = new Date().toISOString();
      await saveTokens(tokens, tokensPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not refresh FreshBooks access token at startup (${msg}). ` +
          "Re-run the freshbooks-setup command to re-authorize.",
        { cause: err },
      );
    }
  }

  const fbClient = new FreshBooksClient({ creds, tokens, tokensPath });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---------- Invoices ----------

  server.tool(
    "list_invoices",
    "List invoices with optional filters (status, client, date range, search).",
    ListInvoicesInput.shape,
    tool(ListInvoicesInput, (i) => listInvoices(fbClient, i)),
  );

  server.tool(
    "get_invoice",
    "Get a single invoice by id.",
    GetInvoiceInput.shape,
    tool(GetInvoiceInput, (i) => getInvoice(fbClient, i)),
  );

  server.tool(
    "create_invoice",
    "Create a draft invoice for a client. Use list_clients to find client_id.",
    CreateInvoiceInput.shape,
    tool(CreateInvoiceInput, (i) => createInvoice(fbClient, i)),
  );

  server.tool(
    "update_invoice",
    "Partially update an invoice. If `lines` is given, REPLACES all line items.",
    UpdateInvoiceInput.shape,
    tool(UpdateInvoiceInput, (i) => updateInvoice(fbClient, i)),
  );

  server.tool(
    "send_invoice",
    "Email an invoice to its client. Optional recipient/subject/body overrides.",
    SendInvoiceInput.shape,
    tool(SendInvoiceInput, (i) => sendInvoice(fbClient, i)),
  );

  server.tool(
    "delete_invoice",
    "Soft-delete an invoice (FreshBooks marks vis_state=1; recoverable in UI).",
    DeleteInvoiceInput.shape,
    tool(DeleteInvoiceInput, (i) => deleteInvoice(fbClient, i)),
  );

  // ---------- Clients ----------

  server.tool(
    "list_clients",
    "List clients with optional organization search.",
    ListClientsInput.shape,
    tool(ListClientsInput, (i) => listClients(fbClient, i)),
  );

  server.tool(
    "get_client",
    "Get a single client by id.",
    GetClientInput.shape,
    tool(GetClientInput, (i) => getClient(fbClient, i)),
  );

  // ---------- Items ----------

  server.tool(
    "list_items",
    "List saved line items (useful when constructing invoices).",
    ListItemsInput.shape,
    tool(ListItemsInput, (i) => listItems(fbClient, i)),
  );

  // ---------- Account ----------

  server.tool(
    "get_account_info",
    "Return the discovered account_id and business name. Use to verify setup.",
    GetAccountInfoInput.shape,
    tool(GetAccountInfoInput, (i) => getAccountInfo(fbClient, i)),
  );

  // ---------- Timesheet ----------

  server.tool(
    "generate_timesheet",
    "Fetch time entries from FreshBooks and generate a Consultant-Bi-Weekly-Timesheet Excel file in ~/Documents/trajector/timesheets/.",
    GenerateTimesheetInput.shape,
    tool(GenerateTimesheetInput, (i) => generateTimesheet(fbClient, i)),
  );

  // ---------- Time Entries ----------

  server.tool(
    "list_time_entries",
    "List time entries for a date range. Returns a day-by-day breakdown, total hours, and which weekdays are missing entries. Use this before creating entries to see what already exists.",
    ListTimeEntriesInput.shape,
    tool(ListTimeEntriesInput, (i) => listTimeEntries(fbClient, i)),
  );

  server.tool(
    "create_time_entry",
    "Create a single time entry in FreshBooks for a given date, project, service, and duration. Use list_time_entries first to find project_id and service_id.",
    CreateTimeEntryInput.shape,
    tool(CreateTimeEntryInput, (i) => createTimeEntry(fbClient, i)),
  );

  server.tool(
    "generate_invoice",
    "Fetch time entries for a date range, group by project/service, look up billable rates, and create a draft FreshBooks invoice for Trajector. Returns invoice ID, number, total, and a line-item breakdown.",
    GenerateInvoiceInput.shape,
    tool(GenerateInvoiceInput, (i) => generateInvoice(fbClient, i)),
  );

  // ---------- Transport ----------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the transport closes.

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Guard late rejections (e.g. a FreshBooks request that resolves after the MCP
// layer already returned) so they can't crash the process and reset state.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[freshbooks] unhandled rejection (ignored): ${reason}\n`,
  );
});

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // stderr is fine: MCP stdio uses stdout for JSON-RPC, stderr is logging.
  process.stderr.write(`[freshbooks] fatal: ${message}\n`);
  process.exit(1);
});
