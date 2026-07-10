#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateAgentReview } from "./lib/review-cycle.mjs";

const path = process.argv[2] === "--review" ? process.argv[3] : null;
const blockers = [];
let review = null;
try {
  if (!path || process.argv.length !== 4) throw new Error("Usage: check-tabellio-agent-review --review <path>.");
  review = JSON.parse(await readFile(resolve(path), "utf8"));
  validateAgentReview(review);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}
const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "agent_review_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  reviewPath: path,
  summary: review ? {
    schemaVersion: review.schemaVersion,
    reviewId: review.reviewId,
    reviewer: review.reviewer?.id ?? null,
    findingCount: Array.isArray(review.findings) ? review.findings.length : null,
  } : null,
  blockers,
};
if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));
