#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { reportCliError } from "./lib/cli-options.mjs";
import { validateReleaseIntent } from "./lib/release-operation.mjs";

main().catch(reportCliError);

async function main() {
  const index = process.argv.indexOf("--intent");
  const path = index >= 0 ? process.argv[index + 1] : null;
  if (!path || process.argv.length !== 4) throw new Error("Usage: check-tabellio-release --intent <path>.");
  const intent = validateReleaseIntent(JSON.parse(await readFile(resolve(path), "utf8")));
  console.log(JSON.stringify({
    ok: true,
    status: "release_intent_ready",
    path,
    summary: {
      version: intent.version,
      tag: intent.tag,
      commit: intent.revision.commit,
      pullRequest: intent.pullRequest.number,
      controlRefCount: intent.control.intent.refs.length,
    },
  }, null, 2));
}
