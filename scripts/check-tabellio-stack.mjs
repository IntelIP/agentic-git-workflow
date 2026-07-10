#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateStackSnapshot } from "./lib/stack-manager.mjs";

const args = parseArgs(process.argv.slice(2));
const stackPath = resolve(args.stack ?? "tabellio-stack.json");
const blockers = [];
let snapshot = null;

try {
  snapshot = JSON.parse(await readFile(stackPath, "utf8"));
  validateStackSnapshot(snapshot);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}

const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "tabellio_stack_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  stackPath,
  schemaPath: "schemas/stack-snapshot.schema.json",
  summary: snapshot ? {
    schemaVersion: snapshot.schemaVersion ?? null,
    provider: snapshot.provider?.id ?? null,
    branchCount: Array.isArray(snapshot.branches) ? snapshot.branches.length : null,
    currentBranch: snapshot.currentBranch ?? null,
  } : null,
  blockers,
};

if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--stack") throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error("--stack requires a value.");
    parsed.stack = value;
  }
  return parsed;
}
