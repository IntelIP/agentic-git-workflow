#!/usr/bin/env node

import { resolve } from "node:path";

import { parseCommandOptions, reportCliError } from "./lib/cli-options.mjs";
import { GitJsonLedger } from "./lib/git-json-ledger.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { latestValidationResult, ValidationRunner } from "./lib/validation-runner.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const store = await NativeGitStore.open(resolve(options.repo ?? process.cwd()));
  const ledger = await GitJsonLedger.open({
    repoPath: store.repoPath,
    ref: options.ledgerRef ?? "refs/tabellio/validations",
  });
  if (["run", "gate"].includes(options.command)) {
    const runner = new ValidationRunner({
      store,
      ledger,
      workspaceRoot: options.workspaceRoot ? resolve(options.workspaceRoot) : null,
    });
    const result = await runner.run({
      repositoryId: await repositoryIdentity(store, options.repoId),
      commit: options.commit ?? "HEAD",
      base: options.base ?? "main",
      checkpointHead: options.checkpointHead ?? null,
      checkpointBase: options.checkpointBase ?? null,
      manifestPath: options.manifest ?? "tabellio.validation.json",
      runnerId: options.runnerId ?? "local",
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    if (options.command === "gate" && result.result.status !== "passed") process.exitCode = 1;
  } else {
    const commit = await store.resolveRef(options.commit ?? "HEAD");
    const result = await latestValidationResult(ledger, commit);
    console.log(JSON.stringify({ ok: result !== null, commit, result }, null, 2));
    if (result === null) process.exitCode = 1;
  }
} catch (error) {
  reportCliError(error);
}

function parseArgs(args) {
  return parseCommandOptions(args, {
    run: ["repo", "repoId", "commit", "base", "checkpointHead", "checkpointBase", "manifest", "runnerId", "ledgerRef", "workspaceRoot"],
    gate: ["repo", "repoId", "commit", "base", "checkpointHead", "checkpointBase", "manifest", "runnerId", "ledgerRef", "workspaceRoot"],
    latest: ["repo", "commit", "ledgerRef"],
  });
}
