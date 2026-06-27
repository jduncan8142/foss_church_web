import { test, expect } from "bun:test";
import { csvCell, leadsToCsv, parseLeadsJsonl, LEAD_CSV_COLUMNS } from "./leadsExport.ts";
import type { Lead } from "./validate.ts";

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "abc12345",
    receivedAt: "2026-06-27T10:00:00.000Z",
    name: "Pat Jones",
    email: "pat@example.org",
    organization: "Grace Church",
    orgType: "Church",
    phone: "555-1234",
    services: ["ChMS Software", "Plan AVL"],
    message: "Hi there",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    ...over,
  };
}

test("csvCell quotes only when needed and doubles embedded quotes", () => {
  expect(csvCell("plain")).toBe("plain");
  expect(csvCell("a,b")).toBe('"a,b"');
  expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
  expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  expect(csvCell("has\rcr")).toBe('"has\rcr"'); // interior CR → RFC-quoted (leader char is 'h')
  expect(csvCell(null)).toBe("");
  expect(csvCell(undefined)).toBe("");
});

test("csvCell neutralises spreadsheet formula injection", () => {
  // Leading =,+,-,@ get a single-quote prefix so Excel/Sheets treat them as text.
  expect(csvCell("=HYPERLINK(http://evil)")).toBe("'=HYPERLINK(http://evil)");
  expect(csvCell("+1555")).toBe("'+1555");
  expect(csvCell("-2")).toBe("'-2");
  expect(csvCell("@cmd")).toBe("'@cmd");
  // A formula leader plus a comma is both prefixed AND RFC-quoted.
  expect(csvCell("=a,b")).toBe("\"'=a,b\"");
  // A formula leader plus an embedded quote: prefixed, then quoted with doubling.
  expect(csvCell('=x"y')).toBe("\"'=x\"\"y\"");
  // Interior special chars don't trigger the formula prefix.
  expect(csvCell("a=b")).toBe("a=b");
});

test("leadsToCsv emits a header and joins services into one cell", () => {
  const csv = leadsToCsv([lead()]);
  const lines = csv.split("\r\n");
  expect(lines[0]).toBe(LEAD_CSV_COLUMNS.join(","));
  expect(lines[1]).toBe(
    "abc12345,2026-06-27T10:00:00.000Z,Pat Jones,pat@example.org,Grace Church,Church,555-1234,ChMS Software; Plan AVL,Hi there,203.0.113.7,Mozilla/5.0",
  );
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(lines[2]).toBe(""); // trailing CRLF produces a final empty element
});

test("leadsToCsv escapes commas/newlines/quotes in real fields", () => {
  const csv = leadsToCsv([
    lead({ organization: "Smith, Jones & Co", message: 'multi\nline "quote"' }),
  ]);
  expect(csv).toContain('"Smith, Jones & Co"');
  expect(csv).toContain('"multi\nline ""quote"""');
});

test("leadsToCsv with no leads is just the header row", () => {
  expect(leadsToCsv([])).toBe(LEAD_CSV_COLUMNS.join(",") + "\r\n");
});

test("parseLeadsJsonl skips blank/garbage/non-object lines and counts them", () => {
  const text = [
    JSON.stringify(lead({ id: "one" })),
    "",
    "   ",
    "{not json",
    "[1,2,3]", // valid JSON but an array, not a lead object
    "42", // valid JSON but a scalar
    JSON.stringify(lead({ id: "two" })),
  ].join("\n");
  const { leads, skipped } = parseLeadsJsonl(text);
  expect(leads.map((l) => l.id)).toEqual(["one", "two"]);
  expect(skipped).toBe(3); // {not json + [array] + 42
});

test("parse → csv round-trips the lead set", () => {
  const text = [lead({ id: "a" }), lead({ id: "b" })].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const { leads } = parseLeadsJsonl(text);
  const csv = leadsToCsv(leads);
  const dataRows = csv.trimEnd().split("\r\n").slice(1);
  expect(dataRows).toHaveLength(2);
  expect(dataRows[0]!.startsWith("a,")).toBe(true);
  expect(dataRows[1]!.startsWith("b,")).toBe(true);
});
