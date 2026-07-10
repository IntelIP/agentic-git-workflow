#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateReviewCycle } from "./lib/review-cycle.mjs";

const path = process.argv[2] === "--cycle" ? process.argv[3] : null;
const blockers = [];
let cycle = null;
try {
  if (!path || process.argv.length !== 4) throw new Error("Usage: check-tabellio-review-cycle --cycle <path>.");
  cycle = JSON.parse(await readFile(resolve(path), "utf8"));
  validateReviewCycle(cycle);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}
const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "review_cycle_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  cyclePath: path,
  summary: cycle ? {
    schemaVersion: cycle.schemaVersion,
    id: cycle.id,
    status: cycle.status,
    feedbackCount: Array.isArray(cycle.feedback) ? cycle.feedback.length : null,
    fixCount: Array.isArray(cycle.fixes) ? cycle.fixes.length : null,
  } : null,
  blockers,
};
if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));
