#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

import { assertAllowedOptions, parseOptionPairs, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { mergedPullRequestForCommit } from "./lib/merged-pull-request.mjs";

try {
  const options = parseOptionPairs(process.argv.slice(2), "resolve-merged-checkpoint");
  assertAllowedOptions(options, ["commit", "githubOutput"]);
  requireOptions(options, ["commit", "githubOutput"], "resolve-merged-checkpoint");
  const response = JSON.parse(await readStandardInput());
  const pullRequest = mergedPullRequestForCommit(response, options.commit);
  const outputs = pullRequest === null
    ? { found: "false" }
    : {
        found: "true",
        number: String(pullRequest.number),
        head: pullRequest.headCommit,
        fetch_ref: pullRequest.fetchRef,
        local_ref: pullRequest.localRef,
      };
  await appendFile(options.githubOutput, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, ...outputs }, null, 2));
} catch (error) {
  reportCliError(error);
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
