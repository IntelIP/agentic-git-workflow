#!/usr/bin/env node

import { assertAllowedOptions, parseOptionPairs, reportCliError } from "./lib/cli-options.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { runSnapshotCommand } from "./lib/snapshot-command.mjs";
import { EntireLedgerProvider } from "./providers/entire-ledger-provider.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  await runSnapshotCommand({
    repo: options.repo,
    out: options.out,
    capture: (store) => captureLedgerSnapshot(store, options),
  });
} catch (error) {
  reportCliError(error);
}

async function captureLedgerSnapshot(store, options) {
  const provider = await EntireLedgerProvider.open(store.repoPath, {
    binary: entireBinary(options.binary),
  });
  return provider.snapshot({
    repositoryId: await repositoryIdentity(store, options.repoId),
    baseRevision: defaultValue(options.base, "main"),
    headRevision: defaultValue(options.head, "HEAD"),
  });
}

function entireBinary(binary) {
  return binary ?? process.env.TABELLIO_ENTIRE_BIN ?? "entire";
}

function defaultValue(value, fallback) {
  return value ?? fallback;
}

function parseArgs(argv) {
  const values = parseOptionPairs(argv, "tabellio-ledger");
  assertAllowedOptions(values, ["repo", "repoId", "base", "head", "out", "binary"]);
  return values;
}
