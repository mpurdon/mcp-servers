/**
 * generate_invoice tool — fetches FreshBooks time entries for a date range,
 * groups them by project + service, looks up the billable rate for each
 * service, and creates a draft invoice for the Trajector client.
 *
 * The line-item format exactly matches the Python fb.py script:
 *   name        → service name (e.g. "Principal Engineer")
 *   description → "(Project Name) Matthew Purdon – Apr 16, 2026 - Apr 30, 2026"
 *   qty         → total hours for that service (decimal)
 *   unit_cost   → billable rate from the FreshBooks project service record
 *   type        → 0 (item/service)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";
import type { Invoice } from "../freshbooks/types.js";

// ── Timesheet path helper ─────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(
  os.homedir(),
  "Documents",
  "trajector",
  "timesheets",
);

/** Returns the expected timesheet path for a given end_date (end_date + 1 day). */
function timesheetPathForPeriod(endDate: string): string {
  const dt = new Date(`${endDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  const sendDate = dt.toISOString().slice(0, 10);
  return path.join(
    OUTPUT_DIR,
    `Consultant-Bi-Weekly-Timesheet ${sendDate}.xlsx`,
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRAJECTOR_CLIENT_ID = 688912;

// ── Input schema ──────────────────────────────────────────────────────────────

export const GenerateInvoiceInput = z
  .object({
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD — start of billing period"),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD — end of billing period"),
    invoice_number: z
      .string()
      .max(50)
      .optional()
      .describe("Override the auto-assigned invoice number"),
    create_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Invoice date (YYYY-MM-DD). Defaults to today."),
    due_offset_days: z
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .default(0)
      .describe("Days after create_date when the invoice is due."),
    draft: z
      .boolean()
      .optional()
      .default(true)
      .describe("Create as draft (true) or immediately mark as sent (false)."),
  })
  .strict();

// ── Internal types ────────────────────────────────────────────────────────────

interface ServiceInfo {
  name: string;
  rate: number | null; // null → rate not configured in FreshBooks
}

interface ProjectInfo {
  title: string;
  services: Map<number, ServiceInfo>;
}

interface EntryGroup {
  projectTitle: string;
  serviceName: string;
  serviceId: number;
  totalSeconds: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a YYYY-MM-DD date as "Apr 16, 2026" */
function formatDate(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Round to 2 decimal places, returning as a number */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── FreshBooks data layer ─────────────────────────────────────────────────────

async function fetchProjectsWithRates(
  client: FreshBooksClient,
): Promise<Map<number, ProjectInfo>> {
  const data = await client.request<{
    projects: Array<{
      id: number;
      title: string;
      services: Array<{
        id: number;
        name: string;
        rate?: string | number | null;
        unit_cost?: string | number | null;
        hourly_rate?: string | number | null;
        price?: string | number | null;
      }>;
    }>;
  }>("GET", `/projects/business/${client.businessId}/projects`, {
    query: { active: "true", client_id: TRAJECTOR_CLIENT_ID },
  });

  const map = new Map<number, ProjectInfo>();
  for (const p of data.projects ?? []) {
    const svcMap = new Map<number, ServiceInfo>();
    for (const s of p.services ?? []) {
      const rawRate = s.rate ?? s.unit_cost ?? s.hourly_rate ?? s.price ?? null;
      const rate = rawRate !== null ? Number(rawRate) : null;
      svcMap.set(s.id, {
        name: s.name,
        rate: Number.isFinite(rate) ? rate : null,
      });
    }
    map.set(p.id, { title: p.title, services: svcMap });
  }
  return map;
}

async function fetchTimeEntries(
  client: FreshBooksClient,
  startDate: string,
  endDate: string,
): Promise<Array<{ projectId: number; serviceId: number; duration: number }>> {
  const data = await client.request<{
    time_entries: Array<{
      id: number;
      active: boolean;
      started_at: string;
      duration: number;
      project_id: number;
      service_id: number;
    }>;
  }>("GET", `/timetracking/business/${client.businessId}/time_entries`, {
    query: {
      client_id: TRAJECTOR_CLIENT_ID,
      started_from: `${startDate}T00:00:00Z`,
      started_to: `${endDate}T23:59:59Z`,
      per_page: 100,
    },
  });

  return (data.time_entries ?? [])
    .filter((e) => e.active !== false)
    .map((e) => ({
      projectId: e.project_id,
      serviceId: e.service_id,
      duration: e.duration,
    }));
}

// ── Core logic ────────────────────────────────────────────────────────────────

function groupEntries(
  entries: Array<{ projectId: number; serviceId: number; duration: number }>,
  projects: Map<number, ProjectInfo>,
): EntryGroup[] {
  const groups = new Map<string, EntryGroup>();

  for (const e of entries) {
    const project = projects.get(e.projectId);
    const projectTitle = project?.title ?? `Project ${e.projectId}`;
    const service = project?.services.get(e.serviceId);
    const serviceName = service?.name ?? `Service ${e.serviceId}`;
    const key = `${e.projectId}::${e.serviceId}`;

    const existing = groups.get(key);
    if (existing) {
      existing.totalSeconds += e.duration;
    } else {
      groups.set(key, {
        projectTitle,
        serviceName,
        serviceId: e.serviceId,
        totalSeconds: e.duration,
      });
    }
  }

  return Array.from(groups.values());
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function generateInvoice(
  client: FreshBooksClient,
  input: z.infer<typeof GenerateInvoiceInput>,
): Promise<{
  invoiceId: number;
  invoiceNumber: string;
  totalAmount: string;
  currency: string;
  lineItems: Array<{
    service: string;
    project: string;
    hours: number;
    rate: number | null;
    amount: number | null;
  }>;
  timesheetAttached: boolean;
  timesheetPath: string | null;
  warnings: string[];
}> {
  const [projects, rawEntries] = await Promise.all([
    fetchProjectsWithRates(client),
    fetchTimeEntries(client, input.start_date, input.end_date),
  ]);

  if (rawEntries.length === 0) {
    throw new Error(
      `No time entries found for ${input.start_date} – ${input.end_date} (client ${TRAJECTOR_CLIENT_ID}).`,
    );
  }

  const groups = groupEntries(rawEntries, projects);
  const warnings: string[] = [];

  // Build line items
  const startLabel = formatDate(input.start_date);
  const endLabel = formatDate(input.end_date);

  const lines = groups.map((g) => {
    const project = projects.get(
      [...projects.entries()].find(
        ([, p]) => p.title === g.projectTitle,
      )?.[0] ?? -1,
    );
    const rate = project?.services.get(g.serviceId)?.rate ?? null;
    const hours = round2(g.totalSeconds / 3600);

    if (rate === null) {
      warnings.push(
        `No rate found for service "${g.serviceName}" (id ${g.serviceId}) in project "${g.projectTitle}". Line item will have unit_cost of 0.`,
      );
    }

    return {
      name: g.serviceName,
      description: `(${g.projectTitle}) Matthew Purdon – ${startLabel} - ${endLabel}`,
      qty: String(hours),
      unit_cost: { amount: rate !== null ? String(rate) : "0", code: "USD" },
      type: 0,
    };
  });

  // Invoice notes (top-level description) mirrors the Python script
  const projectTitle = groups[0]?.projectTitle ?? "Unknown Project";
  const notes = `(${projectTitle}) Matthew Purdon – ${startLabel} - ${endLabel}`;

  const invoicePayload: Record<string, unknown> = {
    customerid: TRAJECTOR_CLIENT_ID,
    notes,
    lines,
    status: 1, // draft
  };
  if (input.create_date) invoicePayload.create_date = input.create_date;
  if (input.due_offset_days !== undefined)
    invoicePayload.due_offset_days = input.due_offset_days;
  if (input.invoice_number)
    invoicePayload.invoice_number = input.invoice_number;

  const path = `/accounting/account/${client.accountId}/invoices/invoices`;
  const created = await client.accounting<Invoice>("POST", path, "invoice", {
    body: { invoice: invoicePayload },
  });

  const invoiceId = created.invoiceid ?? created.id ?? 0;
  const invoiceNumber = created.invoice_number ?? "";
  const totalAmount = created.amount?.amount ?? "0";
  const currency = created.amount?.code ?? "USD";

  // Summarize line items for the return value
  const lineItemSummary = groups.map((g) => {
    const project = projects.get(
      [...projects.entries()].find(
        ([, p]) => p.title === g.projectTitle,
      )?.[0] ?? -1,
    );
    const rate = project?.services.get(g.serviceId)?.rate ?? null;
    const hours = round2(g.totalSeconds / 3600);
    return {
      service: g.serviceName,
      project: g.projectTitle,
      hours,
      rate,
      amount: rate !== null ? round2(hours * rate) : null,
    };
  });

  // ── Attach timesheet if it exists ─────────────────────────────────────────
  let timesheetAttached = false;
  let timesheetPath: string | null = null;

  if (invoiceId) {
    const expectedPath = timesheetPathForPeriod(input.end_date);
    try {
      await fs.access(expectedPath);
      // File exists — attach it
      timesheetPath = expectedPath;
      await client.attachFileToInvoice(invoiceId, expectedPath);
      timesheetAttached = true;
    } catch {
      // File doesn't exist (generate_timesheet hasn't been run yet, or different path)
      timesheetPath = null;
      warnings.push(
        `Timesheet not attached: no file found at ${expectedPath}. ` +
          "Run generate_timesheet first, then the attachment will be added automatically.",
      );
    }
  }

  return {
    invoiceId,
    invoiceNumber,
    totalAmount,
    currency,
    lineItems: lineItemSummary,
    timesheetAttached,
    timesheetPath,
    warnings,
  };
}
