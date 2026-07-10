#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateStackOperationApproval,
  validateStackOperationIntent,
} from "./lib/stack-operation.mjs";

const blockers = [];
let intent = null;
let approval = null;
let options = null;
try {
  options = parseArgs(process.argv.slice(2));
  intent = JSON.parse(await readFile(resolve(options.intent), "utf8"));
  validateStackOperationIntent(intent);
  if (options.approval) {
    approval = JSON.parse(await readFile(resolve(options.approval), "utf8"));
    validateStackOperationApproval(approval, intent, {
      now: options.at ? new Date(options.at) : new Date(),
    });
  }
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}

const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "stack_operation_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  intentPath: options?.intent ?? null,
  approvalPath: options?.approval ?? null,
  summary: intent ? {
    schemaVersion: intent.schemaVersion,
    operation: intent.operation,
    repository: intent.repository?.id ?? null,
    branch: intent.branch ?? null,
    approvalId: approval?.id ?? null,
  } : null,
  blockers,
};
if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--intent", "--approval", "--at"].includes(flag) || value === undefined) throw new Error(`Unsupported or incomplete option: ${flag}.`);
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
    values[key] = value;
  }
  if (!values.intent) throw new Error("--intent is required.");
  if (values.at && Number.isNaN(Date.parse(values.at))) throw new Error("--at must be an ISO date-time.");
  return values;
}
