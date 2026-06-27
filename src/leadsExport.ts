// Pure helpers for reading and exporting the durable lead log (WEB-003).
//
// The lead store is an append-only JSONL file of contact submissions (see
// leads.ts). These helpers turn it into operator-friendly artifacts — a CSV
// export and a tolerant parse — with no I/O of their own so they're trivially
// unit-testable. The CLI in scripts/leads-tool.ts wires them to the filesystem.

import type { Lead } from "./validate.ts";

// CSV columns, in order. Kept explicit (not Object.keys) so the export schema is
// stable regardless of object key order and so `services` gets joined, not
// JSON-stringified.
export const LEAD_CSV_COLUMNS = [
  "id",
  "receivedAt",
  "name",
  "email",
  "organization",
  "orgType",
  "phone",
  "services",
  "message",
  "ip",
  "userAgent",
] as const;

// Characters that make a spreadsheet treat a cell as a formula. Lead fields are
// attacker-controlled (name/message/organization come straight from the public
// form), so a value like `=HYPERLINK(...)` or `+cmd|...` would execute when an
// operator opens the CSV in Excel/Sheets. We neutralise by prefixing a single
// quote — the classic CSV-injection defense — before RFC-4180 quoting.
const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

// Render one value as a safe RFC-4180 CSV cell: formula-guard, then quote if the
// value contains a comma, quote, CR, or LF (doubling any embedded quote).
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (s.length > 0 && FORMULA_LEADERS.has(s[0]!)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Serialize leads to a CSV document (header row + one row per lead). `services`
// (a string[]) is joined with "; " so it stays a single cell. Trailing CRLF per
// RFC 4180; CRLF line endings so Excel imports cleanly across platforms.
export function leadsToCsv(leads: Lead[]): string {
  const rows: string[] = [LEAD_CSV_COLUMNS.map(csvCell).join(",")];
  for (const lead of leads) {
    const cells = LEAD_CSV_COLUMNS.map((col) => {
      const v = (lead as unknown as Record<string, unknown>)[col];
      return csvCell(Array.isArray(v) ? v.join("; ") : v);
    });
    rows.push(cells.join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

export interface ParsedLeads {
  leads: Lead[];
  skipped: number; // non-blank lines that didn't parse as a JSON object
}

// Tolerantly parse the JSONL lead log. Blank lines are ignored; a line that
// isn't valid JSON, or parses to a non-object, is counted in `skipped` rather
// than aborting the whole export — one corrupt append must not lose the rest.
export function parseLeadsJsonl(text: string): ParsedLeads {
  const leads: Lead[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        leads.push(obj as Lead);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { leads, skipped };
}
