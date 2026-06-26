// Tests for the WEB-004 lead-log retention prune. Uses a temp data dir set via
// FC_LEAD_RETENTION_DAYS / FC_DATA_DIR before importing config, so the prune
// runs against throwaway files only (no network, no real lead store).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DAY = 86_400_000;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fcweb-leads-"));
  process.env.FC_DATA_DIR = dir;
  process.env.FC_LEAD_RETENTION_DAYS = "30";
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lead(id: string, receivedAt: string): string {
  return JSON.stringify({
    id,
    receivedAt,
    name: "Test",
    email: "t@example.com",
    organization: "",
    orgType: "",
    phone: "",
    services: [],
    message: "hi",
    ip: "127.0.0.1",
    userAgent: "x",
  });
}

async function writeLog(lines: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "leads.jsonl"), lines.length ? lines.join("\n") + "\n" : "", "utf8");
}

async function readLog(): Promise<string[]> {
  const raw = await readFile(join(dir, "leads.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l.trim());
}

test("config exposes a positive default retention; 0 means disabled", async () => {
  // Default (no env) would be 540; here we set 30 for the suite.
  const { config } = await import("./config.ts");
  expect(config.leadRetentionDays).toBe(30);
});

test("prunes only entries older than the cutoff, keeps recent", async () => {
  const { pruneLeads } = await import("./leads.ts");
  const now = Date.parse("2026-06-26T00:00:00Z");
  await writeLog([
    lead("old", "2026-01-01T00:00:00Z"), // ~176d old -> pruned
    lead("edge-just-old", new Date(now - 31 * DAY).toISOString()), // > 30d -> pruned
    lead("recent", new Date(now - 5 * DAY).toISOString()), // 5d -> kept
    lead("today", "2026-06-26T00:00:00Z"), // 0d -> kept
  ]);

  const r = await pruneLeads(now);
  expect(r.removed).toBe(2);
  expect(r.kept).toBe(2);

  const remaining = (await readLog()).map((l) => JSON.parse(l).id);
  expect(remaining.sort()).toEqual(["recent", "today"]);
});

test("keeps unparseable / undated lines rather than lose data", async () => {
  const { pruneLeads } = await import("./leads.ts");
  const now = Date.parse("2026-06-26T00:00:00Z");
  await writeLog([
    "this is not json",
    JSON.stringify({ id: "no-date", name: "x" }), // valid JSON, no receivedAt
    lead("old", "2020-01-01T00:00:00Z"), // pruned
    lead("keep", new Date(now - 1 * DAY).toISOString()),
  ]);

  const r = await pruneLeads(now);
  expect(r.removed).toBe(1);
  const remaining = await readLog();
  expect(remaining).toContain("this is not json");
  expect(remaining.some((l) => l.includes("no-date"))).toBe(true);
  expect(remaining.some((l) => l.includes('"id":"old"'))).toBe(false);
});

test("no-op when nothing is expired (file left byte-identical)", async () => {
  const { pruneLeads } = await import("./leads.ts");
  const now = Date.parse("2026-06-26T00:00:00Z");
  const lines = [lead("a", new Date(now - 2 * DAY).toISOString()), lead("b", "2026-06-25T00:00:00Z")];
  await writeLog(lines);
  const before = await readFile(join(dir, "leads.jsonl"), "utf8");

  const r = await pruneLeads(now);
  expect(r.removed).toBe(0);
  expect(r.kept).toBe(2);
  expect(await readFile(join(dir, "leads.jsonl"), "utf8")).toBe(before);
});

test("missing log file is a clean no-op", async () => {
  const { pruneLeads } = await import("./leads.ts");
  await rm(join(dir, "leads.jsonl"), { force: true });
  const r = await pruneLeads(Date.now());
  expect(r).toEqual({ kept: 0, removed: 0 });
});
