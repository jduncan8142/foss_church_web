// Durable, append-only log of every contact submission. Stored as JSONL in the
// bind-mounted data dir so leads survive even if an email send fails.

import { mkdir, appendFile } from "node:fs/promises";
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
