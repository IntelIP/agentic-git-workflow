#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { ForgejoProvider } from "./providers/forgejo-provider.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const token = await loadToken(options.tokenFile);
  const provider = new ForgejoProvider({
    baseUrl: options.baseUrl,
    token,
    timeoutMs: options.timeoutMs,
  });
  const target = { owner: options.owner, repo: options.repo };
  let result;
  if (options.command === "version") result = { provider: "forgejo", version: await provider.version() };
  else if (options.command === "repository") result = await provider.repository(target);
  else if (options.command === "pulls") result = await provider.listChangeRequests({ ...target, state: options.state });
  else if (options.command === "pull") result = await provider.changeRequest({ ...target, number: options.number });
  else if (options.command === "reviews") result = await provider.listReviews({ ...target, number: options.number });
  else if (options.command === "review-comments") result = await provider.listReviewComments({ ...target, number: options.number });
  else if (options.command === "issue-comments") result = await provider.listIssueComments({ ...target, number: options.number });
  else result = await provider.commitStatus({ ...target, commit: options.commit });
  console.log(JSON.stringify(result, null, 2));
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
  const commands = new Set([
    "version",
    "repository",
    "pulls",
    "pull",
    "reviews",
    "review-comments",
    "issue-comments",
    "status",
  ]);
  if (!commands.has(command)) {
    throw new Error("Expected command: version, repository, pulls, pull, reviews, review-comments, issue-comments, or status.");
  }
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected a value after ${flag ?? "command"}.`);
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}.`);
    values.set(flag, value);
  }
  const allowed = new Set(["--base-url", "--owner", "--repo", "--token-file", "--timeout-ms", "--state", "--number", "--commit"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unsupported option: ${flag}.`);
  const baseUrl = values.get("--base-url") ?? process.env.TABELLIO_FORGE_URL;
  requiredString(baseUrl, "--base-url or TABELLIO_FORGE_URL");
  const needsRepository = command !== "version";
  const owner = values.get("--owner") ?? process.env.TABELLIO_FORGE_OWNER;
  const repo = values.get("--repo") ?? process.env.TABELLIO_FORGE_REPO;
  if (needsRepository) {
    requiredString(owner, "--owner or TABELLIO_FORGE_OWNER");
    requiredString(repo, "--repo or TABELLIO_FORGE_REPO");
  }
  const number = values.has("--number") ? Number(values.get("--number")) : null;
  if (["pull", "reviews", "review-comments", "issue-comments"].includes(command) && (!Number.isInteger(number) || number <= 0)) {
    throw new Error(`${command} requires a positive --number.`);
  }
  const commit = values.get("--commit") ?? null;
  if (command === "status") requiredString(commit, "--commit");
  const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer.");
  const state = values.get("--state") ?? "open";
  if (!["open", "closed", "all"].includes(state)) throw new Error("--state must be open, closed, or all.");
  return {
    command,
    baseUrl,
    owner,
    repo,
    tokenFile: values.get("--token-file") ?? process.env.TABELLIO_FORGE_TOKEN_FILE ?? null,
    timeoutMs,
    state,
    number,
    commit,
  };
}

async function loadToken(tokenFile) {
  const token = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : process.env.TABELLIO_FORGE_TOKEN?.trim();
  requiredString(token, "--token-file, TABELLIO_FORGE_TOKEN_FILE, or TABELLIO_FORGE_TOKEN");
  return token;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}
