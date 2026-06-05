/**
 * Invoice tools: list, get, create, update, send, delete.
 *
 * FreshBooks invoice status mapping (v3_status):
 *   draft, created, sent, viewed, partial, paid, auto-paid, retry,
 *   failed, declined, overdue, disputed, resolved
 *
 * Money on invoice creation uses the { amount: "12.50", code: "USD" } shape
 * for `unit_cost`. Read-side amount fields use the same shape.
 *
 * Delete is a soft delete: PUT with { invoice: { vis_state: 1 } }. We
 * expose this via delete_invoice and document it in the README.
 */

import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";
import type { Invoice } from "../freshbooks/types.js";

// ---------- Schemas ----------

const InvoiceStatusEnum = z.enum([
  "draft",
  "created",
  "sent",
  "viewed",
  "partial",
  "paid",
  "auto-paid",
  "retry",
  "failed",
  "declined",
  "overdue",
  "disputed",
  "resolved",
]);

export const ListInvoicesInput = z
  .object({
    status: InvoiceStatusEnum.optional().describe("Filter by v3_status."),
    client_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("FreshBooks client (userid)."),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("YYYY-MM-DD."),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("YYYY-MM-DD."),
    search: z
      .string()
      .max(200)
      .optional()
      .describe("Match invoice number or notes."),
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const GetInvoiceInput = z
  .object({
    invoice_id: z.number().int().positive(),
  })
  .strict();

const LineItemInput = z
  .object({
    description: z.string().min(1).max(10_000),
    qty: z.number().positive(),
    unit_cost: z
      .number()
      .nonnegative()
      .describe("Per-unit price as a decimal, e.g. 75.00."),
    name: z.string().max(200).optional(),
    taxName1: z.string().max(50).optional(),
    taxAmount1: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Percent, e.g. 13."),
  })
  .strict();

export const CreateInvoiceInput = z
  .object({
    client_id: z
      .number()
      .int()
      .positive()
      .describe("FreshBooks userid of the client."),
    lines: z.array(LineItemInput).min(1).max(100),
    currency_code: z.string().length(3).default("USD"),
    due_offset_days: z.number().int().min(0).max(365).optional(),
    notes: z.string().max(10_000).optional(),
    terms: z.string().max(10_000).optional(),
    invoice_number: z.string().max(50).optional(),
    create_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export const UpdateInvoiceInput = z
  .object({
    invoice_id: z.number().int().positive(),
    notes: z.string().max(10_000).optional(),
    terms: z.string().max(10_000).optional(),
    due_offset_days: z.number().int().min(0).max(365).optional(),
    invoice_number: z.string().max(50).optional(),
    lines: z
      .array(LineItemInput)
      .min(1)
      .max(100)
      .optional()
      .describe("If provided, REPLACES all line items."),
  })
  .strict();

export const SendInvoiceInput = z
  .object({
    invoice_id: z.number().int().positive(),
    recipients: z
      .array(z.string().email())
      .max(10)
      .optional()
      .describe("Override recipients. Defaults to client's email on file."),
    subject: z.string().max(200).optional(),
    body: z.string().max(10_000).optional(),
  })
  .strict();

export const DeleteInvoiceInput = z
  .object({
    invoice_id: z.number().int().positive(),
  })
  .strict();

// ---------- Handlers ----------

export async function listInvoices(
  client: FreshBooksClient,
  input: z.infer<typeof ListInvoicesInput>,
): Promise<unknown> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices`;
  const query: Record<string, string | number> = {
    page: input.page,
    per_page: input.per_page,
  };
  if (input.status) query["search[v3_status]"] = input.status;
  if (input.client_id) query["search[customerid]"] = input.client_id;
  if (input.date_from) query["search[date_min]"] = input.date_from;
  if (input.date_to) query["search[date_max]"] = input.date_to;
  if (input.search) query["search[invoice_number_like]"] = input.search;

  type Result = {
    invoices: Invoice[];
    page: number;
    pages: number;
    per_page: number;
    total: number;
  };
  const result = await client.accounting<Result>("GET", path, "", { query });
  // accounting<T> returns env.response.result[key]; for list we want the whole result.
  // Use a different unwrap path: pull the whole result object.
  return summarizeListResult(result);
}

// listInvoices/listClients/listItems all share the same envelope shape.
// `accounting` extracts result[key]; for lists we want the result object itself,
// so use a custom unwrap helper here.
function summarizeListResult<
  T extends { invoices?: unknown; clients?: unknown; items?: unknown },
>(result: T): T {
  return result;
}

export async function getInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof GetInvoiceInput>,
): Promise<Invoice> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices/${input.invoice_id}`;
  return client.accounting<Invoice>("GET", path, "invoice", {
    query: { "include[]": "lines" },
  });
}

export async function createInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof CreateInvoiceInput>,
): Promise<Invoice> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices`;
  const body = {
    invoice: {
      customerid: input.client_id,
      currency_code: input.currency_code,
      create_date: input.create_date,
      due_offset_days: input.due_offset_days,
      invoice_number: input.invoice_number,
      notes: input.notes,
      terms: input.terms,
      lines: input.lines.map((l) => ({
        type: 0,
        name: l.name,
        description: l.description,
        qty: String(l.qty),
        unit_cost: {
          amount: l.unit_cost.toFixed(2),
          code: input.currency_code,
        },
        ...(l.taxName1 ? { taxName1: l.taxName1 } : {}),
        ...(l.taxAmount1 !== undefined
          ? { taxAmount1: String(l.taxAmount1) }
          : {}),
      })),
    },
  };
  return client.accounting<Invoice>("POST", path, "invoice", { body });
}

export async function updateInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof UpdateInvoiceInput>,
): Promise<Invoice> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices/${input.invoice_id}`;
  const invoice: Record<string, unknown> = {};
  if (input.notes !== undefined) invoice.notes = input.notes;
  if (input.terms !== undefined) invoice.terms = input.terms;
  if (input.due_offset_days !== undefined)
    invoice.due_offset_days = input.due_offset_days;
  if (input.invoice_number !== undefined)
    invoice.invoice_number = input.invoice_number;
  if (input.lines) {
    invoice.lines = input.lines.map((l) => ({
      type: 0,
      name: l.name,
      description: l.description,
      qty: String(l.qty),
      unit_cost: { amount: l.unit_cost.toFixed(2), code: "USD" },
      ...(l.taxName1 ? { taxName1: l.taxName1 } : {}),
      ...(l.taxAmount1 !== undefined
        ? { taxAmount1: String(l.taxAmount1) }
        : {}),
    }));
  }
  return client.accounting<Invoice>("PUT", path, "invoice", {
    body: { invoice },
  });
}

export async function sendInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof SendInvoiceInput>,
): Promise<Invoice> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices/${input.invoice_id}`;
  const invoice: Record<string, unknown> = { action_email: true };
  if (input.recipients && input.recipients.length > 0) {
    invoice.email_recipients = input.recipients;
  }
  if (input.subject) invoice.email_subject = input.subject;
  if (input.body) invoice.email_body = input.body;
  return client.accounting<Invoice>("PUT", path, "invoice", {
    body: { invoice },
  });
}

/**
 * FreshBooks soft-deletes invoices: vis_state=1 (deleted), 2 (archived), 0 (active).
 */
export async function deleteInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof DeleteInvoiceInput>,
): Promise<Invoice> {
  const path = `/accounting/account/${client.accountId}/invoices/invoices/${input.invoice_id}`;
  return client.accounting<Invoice>("PUT", path, "invoice", {
    body: { invoice: { vis_state: 1 } },
  });
}
