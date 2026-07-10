import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateAgentRunState } from "./lib/agent-run.mjs";

const args = parseArgs(process.argv.slice(2));
const statePath = resolve(args.state ?? "tabellio-run.json");
const blockers = [];
let state = null;

try {
  state = JSON.parse(await readFile(statePath, "utf8"));
  validateAgentRunState(state);
} catch (error) {
  blockers.push(error instanceof Error ? error.message : String(error));
}

const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "tabellio_run_state_ready" : "blocked",
  checkedAt: new Date().toISOString(),
  statePath,
  schemaPath: "schemas/agent-run-state.schema.json",
  summary: state ? {
    schemaVersion: state.schemaVersion ?? null,
    runId: state.runId ?? null,
    lifecycleStatus: state.status ?? null,
    checkpointCount: Array.isArray(state.checkpoints) ? state.checkpoints.length : null,
  } : null,
  blockers,
};

if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--state") throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error("--state requires a value.");
    parsed.state = value;
  }
  return parsed;
}
