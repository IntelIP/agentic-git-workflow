#!/usr/bin/env node

import { resolve } from "node:path";

import { reportCliError } from "./lib/cli-options.mjs";
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
  if (options.command === "run") {
    const runner = new ValidationRunner({ store, ledger });
    const result = await runner.run({
      repositoryId: await repositoryIdentity(store, options.repoId),
      commit: options.commit ?? "HEAD",
      base: options.base ?? "main",
      manifestPath: options.manifest ?? "tabellio.validation.json",
      runnerId: options.runnerId ?? "local",
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
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
  const command = args[0];
  if (!["run", "latest"].includes(command)) throw new Error("Expected command: run or latest.");
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected a value after ${flag ?? command}.`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
    values[key] = value;
  }
  const allowed = command === "run"
    ? ["repo", "repoId", "commit", "base", "manifest", "runnerId", "ledgerRef"]
    : ["repo", "commit", "ledgerRef"];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unsupported option: --${key}.`);
  return { command, ...values };
}
