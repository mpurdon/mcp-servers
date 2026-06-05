/**
 * Time entry tools: list and create.
 *
 * list_time_entries — returns a day-by-day breakdown of what's tracked for a
 * period, including which weekdays have no entries yet.
 *
 * create_time_entry — adds a single time entry for a given date, project,
 * service, and duration. Uses Toronto (America/Toronto) as the local timezone
 * since that's where PurdonMoi Inc operates.
 */

import { z } from "zod";
import type { FreshBooksClient } from "../freshbooks/client.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRAJECTOR_CLIENT_ID = 688912;

// ── Input schemas ─────────────────────────────────────────────────────────────

export const ListTimeEntriesInput = z
  .object({
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD"),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD"),
    client_id: z
      .number()
      .int()
      .positive()
      .optional()
      .default(TRAJECTOR_CLIENT_ID)
      .describe("FreshBooks client ID (defaults to Trajector 688912)"),
  })
  .strict();

export const CreateTimeEntryInput = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD — the day the work was done"),
    duration_hours: z
      .number()
      .positive()
      .max(24)
      .describe("Hours worked, e.g. 8 or 8.5"),
    project_id: z
      .number()
      .int()
      .positive()
      .describe("FreshBooks project ID (visible in list_time_entries output)"),
    service_id: z
      .number()
      .int()
      .positive()
      .describe("FreshBooks service ID (visible in list_time_entries output)"),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe("Optional work note / activity description"),
    start_hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .default(9)
      .describe(
        "Local hour to start (24-hour, Toronto time). Defaults to 9 (9 AM).",
      ),
    client_id: z
      .number()
      .int()
      .positive()
      .optional()
      .default(TRAJECTOR_CLIENT_ID)
      .describe("FreshBooks client ID (defaults to Trajector 688912)"),
  })
  .strict();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the UTC offset for Toronto (America/Toronto) on a given YYYY-MM-DD date.
 * EDT = UTC−4 (approx. 2nd Sunday in March → 1st Sunday in November)
 * EST = UTC−5 (rest of year)
 */
function torontoUtcOffsetHours(ymd: string): number {
  const [year, month, day] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));

  // 2nd Sunday in March (DST starts at 2:00 AM local)
  const marchDst = new Date(Date.UTC(year, 2, 8)); // earliest possible: Mar 8
  marchDst.setUTCDate(8 + ((7 - marchDst.getUTCDay()) % 7));

  // 1st Sunday in November (DST ends at 2:00 AM local)
  const novDst = new Date(Date.UTC(year, 10, 1)); // earliest possible: Nov 1
  novDst.setUTCDate(1 + ((7 - novDst.getUTCDay()) % 7));

  return d >= marchDst && d < novDst ? -4 : -5;
}

/** Returns all weekdays (Mon–Fri) between startDate and endDate inclusive. */
function weekdaysBetween(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));

  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      const y = cur.getUTCFullYear();
      const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
      const d = String(cur.getUTCDate()).padStart(2, "0");
      result.push(`${y}-${m}-${d}`);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

// ── FreshBooks data layer ─────────────────────────────────────────────────────

async function fetchProjectNames(
  client: FreshBooksClient,
): Promise<{ projects: Map<number, string>; services: Map<number, string> }> {
  const data = await client.request<{
    projects: Array<{
      id: number;
      title: string;
      services: Array<{ id: number; name: string }>;
    }>;
  }>("GET", `/projects/business/${client.businessId}/projects`, {
    query: { active: "true", client_id: TRAJECTOR_CLIENT_ID },
  });

  const projects = new Map<number, string>();
  const services = new Map<number, string>();
  for (const p of data.projects ?? []) {
    projects.set(p.id, p.title);
    for (const s of p.services ?? []) {
      services.set(s.id, s.name);
    }
  }
  return { projects, services };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export interface TimeEntryRow {
  id: number;
  date: string; // YYYY-MM-DD (Toronto local)
  duration_hours: number;
  project_id: number;
  project_name: string;
  service_id: number;
  service_name: string;
  note: string | null;
}

export interface ListTimeEntriesResult {
  entries: TimeEntryRow[];
  by_date: Record<string, { hours: number; entry_count: number }>;
  total_hours: number;
  missing_weekdays: string[];
  period: { start: string; end: string };
}

export async function listTimeEntries(
  client: FreshBooksClient,
  input: z.infer<typeof ListTimeEntriesInput>,
): Promise<ListTimeEntriesResult> {
  const [raw, names] = await Promise.all([
    client.request<{
      time_entries: Array<{
        id: number;
        active: boolean;
        local_started_at: string;
        started_at: string;
        duration: number;
        project_id: number;
        service_id: number;
        note: string | null;
      }>;
    }>("GET", `/timetracking/business/${client.businessId}/time_entries`, {
      query: {
        client_id: input.client_id,
        started_from: `${input.start_date}T00:00:00Z`,
        started_to: `${input.end_date}T23:59:59Z`,
        per_page: 100,
      },
    }),
    fetchProjectNames(client),
  ]);

  const entries = (raw.time_entries ?? [])
    .filter((e) => e.active !== false)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id)
    .map(
      (e): TimeEntryRow => ({
        id: e.id,
        date: e.local_started_at.slice(0, 10),
        duration_hours: Math.round((e.duration / 3600) * 100) / 100,
        project_id: e.project_id,
        project_name:
          names.projects.get(e.project_id) ?? `Project ${e.project_id}`,
        service_id: e.service_id,
        service_name:
          names.services.get(e.service_id) ?? `Service ${e.service_id}`,
        note: e.note ?? null,
      }),
    );

  // Aggregate by date
  const byDate: Record<string, { hours: number; entry_count: number }> = {};
  let totalHours = 0;
  for (const e of entries) {
    if (!byDate[e.date]) byDate[e.date] = { hours: 0, entry_count: 0 };
    byDate[e.date].hours += e.duration_hours;
    byDate[e.date].entry_count += 1;
    totalHours += e.duration_hours;
  }

  const daysWithEntries = new Set(entries.map((e) => e.date));
  const allWeekdays = weekdaysBetween(input.start_date, input.end_date);
  const missingWeekdays = allWeekdays.filter((d) => !daysWithEntries.has(d));

  return {
    entries,
    by_date: byDate,
    total_hours: Math.round(totalHours * 100) / 100,
    missing_weekdays: missingWeekdays,
    period: { start: input.start_date, end: input.end_date },
  };
}

export async function createTimeEntry(
  client: FreshBooksClient,
  input: z.infer<typeof CreateTimeEntryInput>,
): Promise<{
  id: number;
  date: string;
  duration_hours: number;
  project_id: number;
  service_id: number;
  local_started_at: string;
  started_at: string;
}> {
  const durationSeconds = Math.round(input.duration_hours * 3600);
  const startHour = input.start_hour ?? 9;
  const offset = torontoUtcOffsetHours(input.date);
  const utcHour = startHour - offset; // e.g. 9 AM EDT → 13:00 UTC

  const localStartedAt = `${input.date}T${String(startHour).padStart(2, "0")}:00:00`;
  const startedAt = `${input.date}T${String(utcHour).padStart(2, "0")}:00:00Z`;

  const body = {
    time_entry: {
      client_id: input.client_id,
      project_id: input.project_id,
      service_id: input.service_id,
      duration: durationSeconds,
      local_started_at: localStartedAt,
      started_at: startedAt,
      note: input.note ?? null,
      is_logged: true,
    },
  };

  const raw = await client.request<{ time_entry: { id: number } }>(
    "POST",
    `/timetracking/business/${client.businessId}/time_entries`,
    { body },
  );

  return {
    id: raw.time_entry.id,
    date: input.date,
    duration_hours: input.duration_hours,
    project_id: input.project_id,
    service_id: input.service_id,
    local_started_at: localStartedAt,
    started_at: startedAt,
  };
}
