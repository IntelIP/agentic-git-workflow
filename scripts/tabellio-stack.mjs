#!/usr/bin/env node

import { assertAllowedOptions, parseOptionPairs, reportCliError } from "./lib/cli-options.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { runSnapshotCommand } from "./lib/snapshot-command.mjs";
import { GitSpiceStackManager } from "./providers/git-spice-stack-manager.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  await runSnapshotCommand({
    repo: options.repo,
    out: options.out,
    capture: async (store) => {
      const manager = await GitSpiceStackManager.open(store.repoPath, {
        binary: options.binary ?? process.env.TABELLIO_GIT_SPICE_BIN ?? "git-spice",
      });
      return manager.snapshot({
        repositoryId: await repositoryIdentity(store, options.repoId),
      });
    },
  });
} catch (error) {
  reportCliError(error);
}

function parseArgs(argv) {
  const values = parseOptionPairs(argv, "tabellio-stack");
  assertAllowedOptions(values, ["repo", "repoId", "out", "binary"]);
  return values;
}
