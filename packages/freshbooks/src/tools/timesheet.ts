/**
 * generate_timesheet tool — fetches FreshBooks time entries for a date range
 * and writes a Consultant-Bi-Weekly-Timesheet Excel file to
 * ~/Documents/trajector/timesheets/, matching the existing file format exactly.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { z } from "zod";
import ExcelJS from "exceljs";
import type { FreshBooksClient } from "../freshbooks/client.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRAJECTOR_CLIENT_ID = 688912;
const OUTPUT_DIR = path.join(
  os.homedir(),
  "Documents",
  "trajector",
  "timesheets",
);
const SIGNATURE_PATH = path.join(
  os.homedir(),
  "Projects",
  "python",
  "freshbooks",
  "signature.png",
);
const DEFAULT_NOTE =
  "Core Services: Architecture, Planning, Development, Continous Improvement, Documentation";

// ── Input schema ──────────────────────────────────────────────────────────────

export const GenerateTimesheetInput = z
  .object({
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD"),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("YYYY-MM-DD"),
  })
  .strict();

// ── Internal types ────────────────────────────────────────────────────────────

interface TimesheetRow {
  dateRecorded: string; // YYYY-MM-DD
  startTime: string; // "09:00 AM"
  endTime: string; // "05:00 PM"
  duration: number; // seconds
  service: string; // column C
  activity: string; // column D
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secondsToHHMM(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

/** Convert minutes-from-midnight to "HH:MM AM/PM" */
function minutesToTimeStr(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// ── FreshBooks data layer ─────────────────────────────────────────────────────

async function fetchProjects(
  client: FreshBooksClient,
): Promise<Map<number, { title: string; services: Map<number, string> }>> {
  const data = await client.request<{
    projects: Array<{
      id: number;
      title: string;
      services: Array<{ id: number; name: string }>;
    }>;
  }>("GET", `/projects/business/${client.businessId}/projects`, {
    query: { active: "true", client_id: TRAJECTOR_CLIENT_ID },
  });

  const map = new Map<
    number,
    { title: string; services: Map<number, string> }
  >();
  for (const p of data.projects ?? []) {
    const svcMap = new Map<number, string>();
    for (const s of p.services ?? []) svcMap.set(s.id, s.name);
    map.set(p.id, { title: p.title, services: svcMap });
  }
  return map;
}

async function buildRows(
  client: FreshBooksClient,
  startDate: string,
  endDate: string,
): Promise<TimesheetRow[]> {
  const data = await client.request<{
    time_entries: Array<{
      id: number;
      active: boolean;
      local_started_at: string; // "2026-04-16T12:00:00" — already local (Toronto)
      started_at: string; // UTC, used for sort
      duration: number; // seconds
      project_id: number;
      service_id: number;
      note: string | null;
    }>;
  }>("GET", `/timetracking/business/${client.businessId}/time_entries`, {
    query: {
      client_id: TRAJECTOR_CLIENT_ID,
      started_from: `${startDate}T00:00:00Z`,
      started_to: `${endDate}T23:59:59Z`,
      per_page: 100,
    },
  });

  const projects = await fetchProjects(client);

  // Sort by UTC start then id — matches the Python script
  const raw = (data.time_entries ?? [])
    .filter((e) => e.active !== false)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id);

  const rows: TimesheetRow[] = [];
  let currentDay = "";
  let currentMinutes = 0; // minutes from midnight

  for (const entry of raw) {
    // Use the local date (Toronto) so the day grouping is correct
    const day = entry.local_started_at.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      currentMinutes = 9 * 60; // 9:00 AM — same as Python script
    }

    const durationMins = Math.floor(entry.duration / 60);
    const endMinutes = currentMinutes + durationMins;

    const project = projects.get(entry.project_id);
    const service =
      project?.services.get(entry.service_id) ?? "Unknown Service";

    rows.push({
      dateRecorded: day,
      startTime: minutesToTimeStr(currentMinutes),
      endTime: minutesToTimeStr(endMinutes),
      duration: entry.duration,
      service,
      activity: entry.note ?? DEFAULT_NOTE,
    });

    currentMinutes = endMinutes;
  }

  return rows;
}

// ── Excel generation ──────────────────────────────────────────────────────────

async function buildWorkbook(
  rows: TimesheetRow[],
  startDate: string,
  endDate: string,
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Timesheet - Consultant");
  ws.views = [{ showGridLines: false }];

  // Column widths B–G (1-indexed columns 2–7)
  [11, 22, 81, 14, 14, 36].forEach((w, i) => {
    ws.getColumn(i + 2).width = w;
  });

  // Row heights for header block
  const headerHeights: Record<number, number> = {
    2: 26,
    3: 13,
    4: 26,
    5: 26,
    6: 13,
    7: 13,
    8: 26,
  };
  for (const [r, h] of Object.entries(headerHeights)) {
    ws.getRow(Number(r)).height = h;
  }

  // ── Style constants ────────────────────────────────────────────────────────
  const thin = { style: "thin" as const, color: { argb: "FF000000" } };
  const thick = { style: "medium" as const, color: { argb: "FF000000" } };

  // Border combos
  const thinAll: Partial<ExcelJS.Borders> = {
    top: thin,
    left: thin,
    right: thin,
    bottom: thin,
  };
  const thickL: Partial<ExcelJS.Borders> = { left: thick };
  const thickR: Partial<ExcelJS.Borders> = { right: thick };
  const thickLT: Partial<ExcelJS.Borders> = {
    top: thin,
    left: thick,
    right: thin,
    bottom: thin,
  };
  const thickRT: Partial<ExcelJS.Borders> = {
    top: thin,
    left: thin,
    right: thick,
    bottom: thin,
  };
  const thickBL: Partial<ExcelJS.Borders> = { left: thick, bottom: thick };
  const thickBR: Partial<ExcelJS.Borders> = { right: thick, bottom: thick };
  const thickBot: Partial<ExcelJS.Borders> = { bottom: thick };

  // Fonts
  const fVerdana: Partial<ExcelJS.Font> = { name: "Verdana", size: 10 };
  const fVerdanaBold: Partial<ExcelJS.Font> = {
    name: "Verdana",
    size: 10,
    bold: true,
  };
  const fWarning: Partial<ExcelJS.Font> = {
    name: "Arial",
    size: 10,
    bold: true,
    color: { argb: "FFFF0000" },
  };
  const fLarge: Partial<ExcelJS.Font> = { name: "Verdana", size: 11 };
  const fLargeBold: Partial<ExcelJS.Font> = {
    name: "Verdana",
    size: 11,
    bold: true,
  };
  const fTitle: Partial<ExcelJS.Font> = {
    name: "Verdana",
    size: 14,
    bold: true,
  };

  // Alignments (exceljs uses "middle" where openpyxl uses "center" for vertical)
  const aCenter: Partial<ExcelJS.Alignment> = {
    horizontal: "center",
    vertical: "middle",
  };
  const aGeneral: Partial<ExcelJS.Alignment> = {
    horizontal: "left",
    vertical: "middle",
  };
  const aRight: Partial<ExcelJS.Alignment> = {
    horizontal: "right",
    vertical: "middle",
  };
  const aRBot: Partial<ExcelJS.Alignment> = {
    horizontal: "right",
    vertical: "bottom",
  };
  const aMidH: Partial<ExcelJS.Alignment> = { horizontal: "center" };

  // Fills
  const blueFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "0099CCFF" },
  };
  const greyFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "00F0F0F0" },
  };

  // Helper: apply styles to a cell
  function style(
    ref: string | ExcelJS.Cell,
    opts: {
      value?: ExcelJS.CellValue;
      font?: Partial<ExcelJS.Font>;
      alignment?: Partial<ExcelJS.Alignment>;
      fill?: ExcelJS.Fill;
      border?: Partial<ExcelJS.Borders>;
    },
  ): ExcelJS.Cell {
    const cell = typeof ref === "string" ? ws.getCell(ref) : ref;
    if (opts.value !== undefined) cell.value = opts.value;
    if (opts.font) cell.font = opts.font as ExcelJS.Font;
    if (opts.alignment) cell.alignment = opts.alignment as ExcelJS.Alignment;
    if (opts.fill) cell.fill = opts.fill;
    if (opts.border) cell.border = opts.border as ExcelJS.Borders;
    return cell;
  }

  // ── Title ─────────────────────────────────────────────────────────────────
  ws.mergeCells("B2:G2");
  style("B2", {
    value: "CONTRACTOR TIME SHEET",
    font: fTitle,
    alignment: aCenter,
    fill: blueFill,
  });

  // ── Info block ────────────────────────────────────────────────────────────
  style("C4", {
    value: "Contractor Name:",
    font: fLargeBold,
    alignment: aMidH,
    border: thinAll,
  });
  style("D4", { value: "Matthew Purdon", font: fLarge, border: thinAll });
  style("C5", {
    value: "Client Name:",
    font: fLargeBold,
    alignment: aMidH,
    border: thinAll,
  });
  style("D5", { value: "Trajector Medical", font: fLarge, border: thinAll });

  ws.mergeCells("E5:F5");
  style("E5", {
    value: "Time Card Date Range",
    font: fLargeBold,
    alignment: aRBot,
  });
  style("G5", {
    value: `${startDate} - ${endDate}`,
    font: fLarge,
    fill: greyFill,
  });
  style("E7", {
    value:
      "NOTE: Place a space between Start Time / End Time   ie. 8 AM = 8:00 AM",
    font: fWarning,
  });

  // Thick left/right borders for header rows 1–7
  for (let r = 1; r <= 7; r++) {
    const lc = ws.getCell(r, 2);
    const rc = ws.getCell(r, 7);
    lc.border = { ...lc.border, left: thick } as ExcelJS.Borders;
    rc.border = { ...rc.border, right: thick } as ExcelJS.Borders;
  }

  // ── Column headers (row 8) ────────────────────────────────────────────────
  const headers = [
    "Date",
    "Task/Project",
    "Description",
    "Start Time",
    "End Time",
    "Total Hours",
  ];
  headers.forEach((h, i) => {
    const col = i + 2;
    const cell = ws.getCell(8, col);
    cell.value = h;
    cell.font = fLargeBold as ExcelJS.Font;
    cell.alignment = aCenter as ExcelJS.Alignment;
    cell.border = thinAll as ExcelJS.Borders;
    if (col === 4) cell.fill = greyFill; // Description column gets grey
  });
  ws.getCell(8, 2).border = thickLT as ExcelJS.Borders;
  ws.getCell(8, 7).border = thickRT as ExcelJS.Borders;

  // ── Data rows ─────────────────────────────────────────────────────────────
  let totalDuration = 0;
  let prevDate = "";
  let rowNum = 9;

  for (const [i, row] of rows.entries()) {
    rowNum = 9 + i;
    ws.getRow(rowNum).height = 21;

    if (row.dateRecorded !== prevDate) {
      style(ws.getCell(rowNum, 2), {
        value: row.dateRecorded,
        font: fVerdana,
        alignment: aRight,
      });
      prevDate = row.dateRecorded;
    }
    ws.getCell(rowNum, 2).border = thickLT as ExcelJS.Borders;

    style(ws.getCell(rowNum, 3), {
      value: row.service,
      font: fVerdana,
      alignment: aGeneral,
      border: thinAll,
    });
    style(ws.getCell(rowNum, 4), {
      value: row.activity,
      font: fVerdana,
      alignment: aGeneral,
      border: thinAll,
      fill: greyFill,
    });
    style(ws.getCell(rowNum, 5), {
      value: row.startTime,
      font: fVerdana,
      alignment: aCenter,
      border: thinAll,
    });
    style(ws.getCell(rowNum, 6), {
      value: row.endTime,
      font: fVerdana,
      alignment: aCenter,
      border: thinAll,
    });
    style(ws.getCell(rowNum, 7), {
      value: secondsToHHMM(row.duration),
      font: fVerdana,
      alignment: aCenter,
      border: thickRT,
    });

    totalDuration += row.duration;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  rowNum += 1;
  ws.getCell(rowNum, 2).border = thickL as ExcelJS.Borders;
  ws.getCell(rowNum, 7).border = thickR as ExcelJS.Borders;

  rowNum += 1;
  const sigRow = rowNum;
  style(ws.getCell(rowNum, 6), {
    value: "Total Hours",
    font: fLargeBold,
    alignment: aRight,
  });
  style(ws.getCell(rowNum, 7), {
    value: secondsToHHMM(totalDuration),
    font: fVerdanaBold,
    alignment: aCenter,
    fill: blueFill,
  });
  style(ws.getCell(rowNum, 3), {
    value: "Contractor Signature:",
    font: fLargeBold,
    alignment: aRight,
  });
  ws.getCell(rowNum, 2).border = thickL as ExcelJS.Borders;
  ws.getCell(rowNum, 7).border = thickR as ExcelJS.Borders;

  // Signature image — placed at column D, one row above the signature label
  const sigExists = await fs
    .access(SIGNATURE_PATH)
    .then(() => true)
    .catch(() => false);
  if (sigExists) {
    const imgId = wb.addImage({ filename: SIGNATURE_PATH, extension: "png" });
    ws.addImage(imgId, {
      tl: { col: 3, row: sigRow - 2 }, // col D (0-based: D=3), row above
      ext: { width: 112, height: 48 },
    } as unknown as ExcelJS.ImageRange);
  }

  rowNum += 1;
  ws.getCell(rowNum, 2).border = thickBL as ExcelJS.Borders;
  ws.getCell(rowNum, 7).border = thickBR as ExcelJS.Borders;
  for (let c = 3; c <= 6; c++) {
    ws.getCell(rowNum, c).border = thickBot as ExcelJS.Borders;
  }

  return wb;
}

// ── Tool handler ──────────────────────────────────────────────────────────────

export async function generateTimesheet(
  client: FreshBooksClient,
  input: z.infer<typeof GenerateTimesheetInput>,
): Promise<{ file: string; entries: number; total_hours: string }> {
  const rows = await buildRows(client, input.start_date, input.end_date);

  if (rows.length === 0) {
    throw new Error(
      `No time entries found for ${input.start_date} – ${input.end_date}.`,
    );
  }

  const wb = await buildWorkbook(rows, input.start_date, input.end_date);

  // Filename convention: end_date + 1 day (matches the Python script)
  const endDt = new Date(`${input.end_date}T12:00:00Z`);
  endDt.setUTCDate(endDt.getUTCDate() + 1);
  const sendDate = endDt.toISOString().slice(0, 10);
  const filename = `Consultant-Bi-Weekly-Timesheet ${sendDate}.xlsx`;

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, filename);
  await wb.xlsx.writeFile(outPath);

  const totalSec = rows.reduce((s, r) => s + r.duration, 0);

  return {
    file: outPath,
    entries: rows.length,
    total_hours: secondsToHHMM(totalSec),
  };
}
