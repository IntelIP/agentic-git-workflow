#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reportCliError } from "./lib/cli-options.mjs";
import { runGit } from "./lib/git-process.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import {
  createStackOperationIntent,
  STACK_OPERATIONS,
} from "./lib/stack-operation.mjs";
import {
  ApprovedGitSpiceOperations,
  readStackOperationFile,
  repositoryRefsDigest,
} from "./providers/git-spice-operations.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

const askpassPath = fileURLToPath(new URL("./lib/git-askpass.mjs", import.meta.url));

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "plan") await plan(options);
  else await execute(options);
} catch (error) {
  reportCliError(error);
}

async function plan(options) {
  const store = await NativeGitStore.open(resolve(options.repo ?? process.cwd()));
  const branch = options.branch ?? await currentBranch(store.repoPath);
  const headCommit = await store.resolveRef(`refs/heads/${branch}`);
  const parameters = await operationParameters(options);
  const intent = createStackOperationIntent({
    operation: options.operation,
    repositoryId: await repositoryIdentity(store, options.repoId),
    headCommit,
    refsDigest: await repositoryRefsDigest(store.repoPath),
    branch,
    parameters,
  });
  const output = `${JSON.stringify(intent, null, 2)}\n`;
  if (options.out) {
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, output, { flag: "wx" });
  }
  process.stdout.write(output);
}

async function execute(options) {
  const [intent, approval] = await Promise.all([
    readStackOperationFile(resolve(options.intent)),
    readStackOperationFile(resolve(options.approval)),
  ]);
  const env = {};
  if (options.tokenFile) {
    const tokenFile = resolve(options.tokenFile);
    env.GITHUB_TOKEN = (await readFile(tokenFile, "utf8")).trim();
    if (!env.GITHUB_TOKEN) throw new Error("--token-file is empty.");
    if (options.gitUsername) {
      env.GIT_ASKPASS = askpassPath;
      env.GIT_ASKPASS_REQUIRE = "force";
      env.TABELLIO_GIT_USERNAME = options.gitUsername;
      env.TABELLIO_GIT_TOKEN_FILE = tokenFile;
    }
  }
  const operations = await ApprovedGitSpiceOperations.open({
    repoPath: resolve(options.repo ?? process.cwd()),
    stateRoot: options.stateRoot ? resolve(options.stateRoot) : null,
    binary: options.binary ?? process.env.TABELLIO_GIT_SPICE_BIN ?? "git-spice",
    env,
  });
  const result = await operations.execute({
    intent,
    approval,
    repositoryId: options.repoId,
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

async function operationParameters(options) {
  if (options.operation === "submit") {
    if (!options.title) throw new Error("submit planning requires --title.");
    if (!options.bodyFile) throw new Error("submit planning requires --body-file.");
    return {
      draft: booleanOption(options.draft, true, "--draft"),
      title: options.title,
      body: await readFile(resolve(options.bodyFile), "utf8"),
    };
  }
  if (options.operation === "update") {
    return { draft: options.draft === undefined ? null : booleanOption(options.draft, null, "--draft") };
  }
  if (options.operation === "sync") {
    const restack = options.restack ?? "none";
    if (!["none", "aboves", "upstack"].includes(restack)) throw new Error("--restack must be none, aboves, or upstack.");
    return { restack };
  }
  if (options.operation === "restack") return {};
  const method = options.method ?? "squash";
  if (!["merge", "squash", "rebase"].includes(method)) throw new Error("--method must be merge, squash, or rebase.");
  return {
    method,
    readyTimeout: options.readyTimeout ?? "0",
    mergeTimeout: options.mergeTimeout ?? "2m",
  };
}

async function currentBranch(cwd) {
  const branch = await runGit({ args: ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd });
  return branch.stdout.trim();
}

function parseArgs(args) {
  const command = args[0];
  if (!["plan", "execute"].includes(command)) throw new Error("Expected command: plan or execute.");
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected a value after ${flag ?? command}.`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
    values[key] = value;
  }
  const allowed = command === "plan"
    ? ["operation", "repo", "repoId", "branch", "out", "title", "bodyFile", "draft", "restack", "method", "readyTimeout", "mergeTimeout"]
    : ["repo", "repoId", "intent", "approval", "stateRoot", "binary", "tokenFile", "gitUsername"];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unsupported option: --${key}.`);
  if (command === "plan" && !STACK_OPERATIONS.includes(values.operation)) {
    throw new Error(`--operation must be one of: ${STACK_OPERATIONS.join(", ")}.`);
  }
  if (command === "execute") {
    if (!values.intent) throw new Error("execute requires --intent.");
    if (!values.approval) throw new Error("execute requires --approval.");
  }
  return { command, ...values };
}

function booleanOption(value, defaultValue, path) {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${path} must be true or false.`);
}
