#!/usr/bin/env node

import { resolve } from "node:path";

import { assertAllowedOptions, parseOptionPairs, reportCliError } from "./lib/cli-options.mjs";
import { runPreflight } from "./lib/preflight.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseOptionPairs(process.argv.slice(2), "tabellio-preflight");
  assertAllowedOptions(options, ["repo", "profile", "entireBinary", "ghBinary", "codexBinary"]);
  const {
    repo = process.cwd(),
    profile = "agent",
    entireBinary = "entire",
    ghBinary = "gh",
    codexBinary = "codex",
  } = options;
  const result = await runPreflight({
    repoPath: resolve(repo),
    profile,
    entireBinary,
    ghBinary,
    codexBinary,
  });
  console.log(JSON.stringify({ ok: result.status === "ready", result }, null, 2));
  if (result.status !== "ready") process.exitCode = 1;
}
