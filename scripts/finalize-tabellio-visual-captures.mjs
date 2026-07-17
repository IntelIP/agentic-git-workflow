#!/usr/bin/env node

import { finalizeVisualCaptures } from "./lib/design-memory.mjs";

const options = parseArgs(process.argv.slice(2));
const result = await finalizeVisualCaptures(options);
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--repo", "--profile", "--captures-dir", "--artifact-base-uri", "--source-commit", "--out"].includes(flag)) {
      throw new Error("Usage: tabellio-design-captures [--repo <path>] [--profile <path>] --captures-dir <path> --artifact-base-uri <uri> --source-commit <oid> --out <path>.");
    }
    result[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}
