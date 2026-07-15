#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GitJsonLedger } from "./lib/git-json-ledger.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { ReviewCycleManager } from "./lib/review-cycle.mjs";
import { GitHubProvider } from "./providers/github-provider.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const store = await NativeGitStore.open(resolve(options.repo ?? process.cwd()));
  const repositoryId = await repositoryIdentity(store, options.repoId);
  const ledger = await GitJsonLedger.open({
    repoPath: store.repoPath,
    ref: options.ledgerRef ?? "refs/tabellio/reviews",
  });
  const validationLedger = await GitJsonLedger.open({
    repoPath: store.repoPath,
    ref: options.validationLedgerRef ?? "refs/tabellio/validations",
  });
  let provider = null;
  if (options.command === "sync") {
    const token = options.tokenFile
      ? (await readFile(resolve(options.tokenFile), "utf8")).trim()
      : process.env.GITHUB_TOKEN?.trim();
    if (!token) throw new Error("--token-file or GITHUB_TOKEN is required for sync.");
    provider = new GitHubProvider({
      baseUrl: options.apiUrl ?? process.env.GITHUB_API_URL,
      token,
    });
  }
  const manager = new ReviewCycleManager({
    store,
    ledger,
    validationLedger,
    provider,
    repositoryId,
    owner: options.owner,
    repo: options.remoteRepo,
  });
  let result;
  if (options.command === "sync") {
    result = await manager.sync({ number: options.number, actor: options.actor });
  } else if (options.command === "status") {
    result = await manager.status({ number: options.number });
  } else if (options.command === "triage") {
    result = await manager.triage({
      number: options.number,
      feedbackId: options.feedbackId,
      disposition: options.disposition,
      reason: options.reason,
      actor: options.actor,
    });
  } else if (options.command === "fix") {
    result = await manager.recordFix({
      number: options.number,
      feedbackIds: options.feedbackIds.split(",").map((value) => value.trim()).filter(Boolean),
      commit: options.commit,
      checkpointId: options.checkpoint,
      summary: options.summary,
      actor: options.actor,
    });
  } else {
    result = await manager.importAgentReview({
      number: options.number,
      input: JSON.parse(await readFile(resolve(options.input), "utf8")),
      actor: options.actor,
    });
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  }, null, 2));
}

function parseArgs(args) {
  const command = args[0];
  if (!["sync", "status", "triage", "fix", "import"].includes(command)) {
    throw new Error("Expected command: sync, status, triage, fix, or import.");
  }
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected a value after ${flag ?? command}.`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
    values[key] = value;
  }
  const common = ["repo", "repoId", "owner", "remoteRepo", "number", "actor", "ledgerRef", "validationLedgerRef"];
  const allowed = {
    sync: [...common, "apiUrl", "tokenFile"],
    status: common,
    triage: [...common, "feedbackId", "disposition", "reason"],
    fix: [...common, "feedbackIds", "commit", "checkpoint", "summary"],
    import: [...common, "input"],
  }[command];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unsupported option: --${key}.`);
  for (const key of ["owner", "remoteRepo", "number"]) if (!values[key]) throw new Error(`--${key} is required.`);
  const number = Number(values.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error("--number must be a positive integer.");
  const actor = values.actor ?? process.env.USER ?? "local-agent";
  if (command === "triage") for (const key of ["feedbackId", "disposition", "reason"]) if (!values[key]) throw new Error(`--${key} is required for triage.`);
  if (command === "fix") for (const key of ["feedbackIds", "commit", "checkpoint", "summary"]) if (!values[key]) throw new Error(`--${key} is required for fix.`);
  if (command === "import" && !values.input) throw new Error("--input is required for import.");
  return { command, ...values, number, actor };
}
