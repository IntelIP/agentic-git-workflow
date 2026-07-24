#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import {
  MergeReadyStatusExecutor,
  planMergeReadyStatus,
  readMergeReadyStatusFile,
} from "./lib/merge-ready-status-workflow.mjs";

const OPTIONS = {
  plan: ["repo", "repoId", "commit", "manifest", "ledgerRef", "targetUrl", "out"],
  execute: ["repo", "intent", "approval", "ledgerRef", "stateRoot", "tokenFile", "apiUrl"],
};

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), OPTIONS);
  if (options.command === "plan") await plan(options);
  else await execute(options);
}

async function plan(options) {
  requireOptions(options, ["out"], "plan");
  const resolved = planOptions(options);
  const intent = await planMergeReadyStatus({
    repoPath: resolved.repo,
    repositoryId: resolved.repoId,
    commit: resolved.commit,
    manifestPath: resolved.manifest,
    ledgerRef: resolved.ledgerRef,
    targetUrl: resolved.targetUrl,
  });
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, intent, out }, null, 2));
}

async function execute(options) {
  requireOptions(options, ["intent", "approval"], "execute");
  const resolved = executeOptions(options);
  const token = await githubToken(options.tokenFile);
  if (!token) throw new Error("GitHub status publication requires --token-file or GITHUB_TOKEN.");
  const [intent, approval] = await Promise.all([
    readMergeReadyStatusFile(options.intent),
    readMergeReadyStatusFile(options.approval),
  ]);
  const executor = await MergeReadyStatusExecutor.open({
    repoPath: resolved.repo,
    ledgerRef: resolved.ledgerRef,
    stateRoot: resolved.stateRoot,
    token,
    apiUrl: resolved.apiUrl,
  });
  const result = await executor.execute({ intent, approval });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function planOptions({
  repo = process.cwd(),
  repoId = null,
  commit = "HEAD",
  manifest = "tabellio.validation.json",
  ledgerRef = "refs/tabellio/validations",
  targetUrl = null,
}) {
  return { repo: resolve(repo), repoId, commit, manifest, ledgerRef, targetUrl };
}

function executeOptions({
  repo = process.cwd(),
  ledgerRef = "refs/tabellio/validations",
  stateRoot,
  apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
}) {
  return { repo: resolve(repo), ledgerRef, stateRoot, apiUrl };
}

async function githubToken(tokenFile) {
  if (tokenFile) return (await readFile(resolve(tokenFile), "utf8")).trim();
  const value = process.env.GITHUB_TOKEN;
  return typeof value === "string" ? value.trim() : "";
}
