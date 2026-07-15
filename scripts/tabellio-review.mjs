#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertAllowedOptions,
  parseOptionPairs,
  positiveNumberOption,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { GitJsonLedger } from "./lib/git-json-ledger.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { ReviewCycleManager } from "./lib/review-cycle.mjs";
import { GitHubProvider } from "./providers/github-provider.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

const COMMANDS = new Set(["sync", "status", "triage", "fix", "import", "migrate"]);
const COMMON_OPTIONS = ["repo", "repoId", "owner", "remoteRepo", "number", "actor", "ledgerRef", "validationLedgerRef"];
const ALLOWED_OPTIONS = {
  sync: [...COMMON_OPTIONS, "apiUrl", "tokenFile"],
  status: COMMON_OPTIONS,
  triage: [...COMMON_OPTIONS, "feedbackId", "disposition", "reason"],
  fix: [...COMMON_OPTIONS, "feedbackIds", "commit", "checkpoint", "summary"],
  import: [...COMMON_OPTIONS, "input"],
  migrate: [...COMMON_OPTIONS, "apply", "targetNumber", "remapCurrent", "legacyRepoId", "legacyOwner", "legacyRemoteRepo"],
};
const REQUIRED_OPTIONS = {
  sync: [],
  status: [],
  triage: ["feedbackId", "disposition", "reason"],
  fix: ["feedbackIds", "commit", "checkpoint", "summary"],
  import: ["input"],
  migrate: [],
};
const COMMAND_HANDLERS = {
  sync: syncReview,
  status: reviewStatus,
  triage: triageReview,
  fix: recordReviewFix,
  import: importAgentReview,
  migrate: migrateReview,
};

main().catch(reportCliError);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const store = await NativeGitStore.open(resolve(options.repo ?? process.cwd()));
  const repositoryId = await repositoryIdentity(store, options.repoId);
  const ledger = await openLedger(store.repoPath, options.ledgerRef ?? "refs/tabellio/reviews");
  const validationLedger = await openLedger(store.repoPath, options.validationLedgerRef ?? "refs/tabellio/validations");
  const manager = new ReviewCycleManager({
    store,
    ledger,
    validationLedger,
    provider: await githubClient(options),
    repositoryId,
    owner: options.owner,
    repo: options.remoteRepo,
  });
  const result = await COMMAND_HANDLERS[options.command](manager, options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function openLedger(repoPath, ref) {
  return GitJsonLedger.open({ repoPath, ref });
}

async function githubClient(options) {
  if (options.command !== "sync") return null;
  const token = await githubToken(options.tokenFile);
  if (!token) throw new Error("--token-file or GITHUB_TOKEN is required for sync.");
  return new GitHubProvider({
    baseUrl: options.apiUrl ?? process.env.GITHUB_API_URL,
    token,
  });
}

async function githubToken(tokenFile) {
  if (tokenFile) return (await readFile(resolve(tokenFile), "utf8")).trim();
  return process.env.GITHUB_TOKEN?.trim();
}

function syncReview(manager, options) {
  return manager.sync({ number: options.number, actor: options.actor });
}

function reviewStatus(manager, options) {
  return manager.status({ number: options.number });
}

function triageReview(manager, options) {
  return manager.triage({
    number: options.number,
    feedbackId: options.feedbackId,
    disposition: options.disposition,
    reason: options.reason,
    actor: options.actor,
  });
}

function recordReviewFix(manager, options) {
  return manager.recordFix({
    number: options.number,
    feedbackIds: options.feedbackIds.split(",").map((value) => value.trim()).filter(Boolean),
    commit: options.commit,
    checkpointId: options.checkpoint,
    summary: options.summary,
    actor: options.actor,
  });
}

async function importAgentReview(manager, options) {
  return manager.importAgentReview({
    number: options.number,
    input: JSON.parse(await readFile(resolve(options.input), "utf8")),
    actor: options.actor,
  });
}

function migrateReview(manager, options) {
  return manager.migrate({
    number: options.number,
    targetNumber: options.targetNumber,
    remapCurrent: options.remapCurrent,
    apply: options.apply,
    legacyRepositoryId: options.legacyRepoId,
    legacyOwner: options.legacyOwner,
    legacyRepo: options.legacyRemoteRepo,
  });
}

function parseArgs(args) {
  const command = args[0];
  requireCommand(command);
  const values = parseOptionPairs(args.slice(1), command);
  assertAllowedOptions(values, ALLOWED_OPTIONS[command]);
  requireOptions(values, ["owner", "remoteRepo", "number"]);
  requireOptions(values, REQUIRED_OPTIONS[command], command);
  return {
    command,
    ...values,
    number: positiveNumberOption(values.number, "--number"),
    actor: defaultActor(values.actor),
    ...migrationOptions(command, values),
  };
}

function requireCommand(command) {
  if (!COMMANDS.has(command)) throw new Error("Expected command: sync, status, triage, fix, import, or migrate.");
}

function defaultActor(actor) {
  return actor ?? process.env.USER ?? "local-agent";
}

function migrationOptions(command, values) {
  if (command !== "migrate") return {};
  return {
    apply: optionalBooleanOption(values.apply, "--apply"),
    remapCurrent: optionalBooleanOption(values.remapCurrent, "--remap-current"),
    targetNumber: migrationTargetNumber(values),
  };
}

function optionalBooleanOption(value, flag) {
  return booleanOption(value === undefined ? "false" : value, flag);
}

function migrationTargetNumber(values) {
  if (values.targetNumber === undefined) return positiveNumberOption(values.number, "--number");
  return positiveNumberOption(values.targetNumber, "--target-number");
}

function booleanOption(value, flag) {
  if (!["true", "false"].includes(value)) throw new Error(`${flag} must be true or false.`);
  return value === "true";
}
