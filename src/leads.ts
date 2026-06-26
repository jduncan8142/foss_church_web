// Durable, append-only log of every contact submission. Stored as JSONL in the
// bind-mounted data dir so leads survive even if an email send fails.
//
// Privacy (WEB-004): each line is one Lead and holds PII — name, email, phone,
// IP address, and user-agent. The dir is never web-served. We retain entries
// only as long as needed to follow up on an inquiry: pruneLeads() drops records
// older than config.leadRetentionDays (default ~18 months; 0 disables), and the
// server runs it at startup and daily. This is the implemented half of the
// OPS-G retention posture for FC Web leads.

import { mkdir, appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Lead } from "./validate.ts";

let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(config.dataDir, { recursive: true });
  dirReady = true;
}

export async function storeLead(lead: Lead): Promise<void> {
  await ensureDir();
  await appendFile(join(config.dataDir, "leads.jsonl"), JSON.stringify(lead) + "\n", "utf8");
}

export interface PruneResult {
  kept: number;
  removed: number;
}

// Remove lead records older than the retention window. Conservative: it drops
// only lines it can confidently date (valid JSON with a parseable receivedAt)
// as older than the cutoff; blank/unparseable/undated lines are kept rather
// than risk losing data. The rewrite is atomic (temp file + rename in the same
// dir). A retention of 0 means "keep forever" and short-circuits. `now` is
// injectable for tests.
export async function pruneLeads(now: number = Date.now()): Promise<PruneResult> {
  if (config.leadRetentionDays <= 0) return { kept: 0, removed: 0 };

  const file = join(config.dataDir, "leads.jsonl");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kept: 0, removed: 0 };
    throw err;
  }

  const cutoff = now - config.leadRetentionDays * 86_400_000;
  const kept: string[] = [];
  let removed = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ts = NaN;
    try {
      ts = Date.parse((JSON.parse(line) as Lead).receivedAt);
    } catch {
      ts = NaN;
    }
    if (Number.isFinite(ts) && ts < cutoff) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  if (removed === 0) return { kept: kept.length, removed: 0 };

  const tmp = join(config.dataDir, `leads.jsonl.tmp-${process.pid}`);
  await writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  await rename(tmp, file);
  return { kept: kept.length, removed };
}
