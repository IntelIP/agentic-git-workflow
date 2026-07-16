#!/usr/bin/env node

import { inspectDesignMemory } from "./lib/design-memory.mjs";

const options = parseArgs(process.argv.slice(2));
const result = await inspectDesignMemory(options);
if (!result.ok) process.exitCode = 1;
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--repo", "--profile", "--baselines"].includes(flag)) {
      throw new Error("Usage: check-tabellio-design-memory [--repo <path>] [--profile <path>] [--baselines <path>].");
    }
    result[flag.slice(2)] = value;
  }
  return result;
}
