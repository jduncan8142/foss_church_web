#!/usr/bin/env bun
// FC Web lead-store operator tool (WEB-003).
//
//   bun run scripts/leads-tool.ts backup [--keep-days N] [--keep-min N]
//   bun run scripts/leads-tool.ts export [--out PATH | --stdout]
//
// `backup` takes a gzip snapshot of leads.jsonl into <data>/backups/ and prunes
// old snapshots (age window with a count floor). `export` renders the JSONL log
// to a CSV (defaults to <data>/exports/leads-<ts>.csv) for follow-up / CRM import.
//
// Why a CLI and not an HTTP route: the marketing site is unauthenticated, so a
// web export endpoint would expose lead PII to the world. This runs on the host
// (cron / manual op), beside the data dir — same posture as the planavl backup
// tool (AVL-005). It never emails or transmits anything; artifacts stay local.
//
// The lead log holds PII (name/email/phone/IP/UA). Snapshots and exports are
// written 0600 and live under the same bind-mounted data dir; copy them off-box
// for a real off-host backup (see README "Operating the lead store").

import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { leadsToCsv, parseLeadsJsonl } from "../src/leadsExport.ts";

const SNAPSHOT_RE = /^leads-(\d{8}-\d{6})\.jsonl\.gz$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function intArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} must be a non-negative integer, got: ${v}`);
    process.exit(2);
  }
  return n;
}

// Compact local timestamp YYYYMMDD-HHMMSS for artifact filenames.
function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const dataDir = arg("--data-dir") ?? config.dataDir;
const leadsFile = join(dataDir, "leads.jsonl");

function readLeadsRaw(): string {
  try {
    return readFileSync(leadsFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`No lead log at ${leadsFile} — nothing to do.`);
      process.exit(0);
    }
    throw err;
  }
}

function doBackup(): void {
  const keepDays = intArg("--keep-days", 14);
  const keepMin = intArg("--keep-min", 7);

  const raw = readLeadsRaw();
  const dir = join(dataDir, "backups");
  mkdirSync(dir, { recursive: true });

  const out = join(dir, `leads-${stamp(new Date())}.jsonl.gz`);
  writeFileSync(out, gzipSync(Buffer.from(raw, "utf8")), { mode: 0o600 });
  console.log(`backup: wrote ${out} (${raw.length} bytes raw)`);

  // Retention: keep every snapshot newer than keepDays, but never drop below
  // keepMin most-recent snapshots (so a quiet period can't prune the history).
  const snaps = readdirSync(dir)
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort(); // lexicographic == chronological for this name format
  const cutoff = Date.now() - keepDays * 86_400_000;
  const removable = snaps.slice(0, Math.max(0, snaps.length - keepMin));
  let pruned = 0;
  for (const f of removable) {
    const p = join(dir, f);
    if (keepDays > 0 && statSync(p).mtimeMs >= cutoff) continue;
    unlinkSync(p);
    pruned++;
  }
  if (pruned) console.log(`backup: pruned ${pruned} snapshot(s) older than ${keepDays}d (floor ${keepMin})`);
}

function doExport(): void {
  const raw = readLeadsRaw();
  const { leads, skipped } = parseLeadsJsonl(raw);
  const csv = leadsToCsv(leads);

  if (flag("--stdout")) {
    process.stdout.write(csv);
    if (skipped) console.error(`export: ${leads.length} lead(s), skipped ${skipped} unparseable line(s)`);
    return;
  }

  let out = arg("--out");
  if (!out) {
    const dir = join(dataDir, "exports");
    mkdirSync(dir, { recursive: true });
    out = join(dir, `leads-${stamp(new Date())}.csv`);
  }
  writeFileSync(out, csv, { mode: 0o600 });
  console.log(
    `export: wrote ${out} — ${leads.length} lead(s)` + (skipped ? `, skipped ${skipped} unparseable line(s)` : ""),
  );
}

function usage(): never {
  console.error("usage: bun run scripts/leads-tool.ts <backup|export> [options]");
  console.error("  backup [--keep-days N=14] [--keep-min N=7]");
  console.error("  export [--out PATH | --stdout]");
  console.error("  [--data-dir DIR]  (default: FC_DATA_DIR or ./data)");
  process.exit(2);
}

const cmd = process.argv[2];
if (cmd === "backup") doBackup();
else if (cmd === "export") doExport();
else usage();
