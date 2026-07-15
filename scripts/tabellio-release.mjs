#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertAllowedOptions,
  parseOptionPairs,
  positiveNumberOption,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { planRelease } from "./lib/release-planner.mjs";
import { ReleaseExecutor } from "./lib/release-workflow.mjs";

const OPTIONS = {
  plan: ["repo", "repoId", "owner", "remoteRepo", "number", "version", "notes", "title", "controlRemote", "manifest", "runnerId", "tokenFile", "apiUrl", "ghBinary", "out"],
  execute: ["repo", "intent", "approval", "stateRoot", "ghBinary"],
};

main().catch(reportCliError);

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(OPTIONS, command)) throw new Error("Expected command: plan or execute.");
  const options = parseOptionPairs(process.argv.slice(3), command);
  assertAllowedOptions(options, OPTIONS[command]);
  if (command === "plan") await plan(options);
  else await execute(options);
}

async function plan(options) {
  requireOptions(options, ["owner", "remoteRepo", "number", "version", "notes", "out"], "plan");
  const {
    repo = process.cwd(),
    repoId,
    owner,
    remoteRepo,
    number,
    version,
    notes,
    title = `Tabellio v${version}`,
    controlRemote = "control",
    manifest = "tabellio.validation.json",
    runnerId = "tabellio-release",
    tokenFile,
    apiUrl = process.env.GITHUB_API_URL,
    ghBinary = "gh",
    out: outputPath,
  } = options;
  const token = await releaseToken(tokenFile);
  const intent = await planRelease({
    repoPath: resolve(repo),
    repositoryId: repoId,
    owner,
    repo: remoteRepo,
    number: positiveNumberOption(number, "--number"),
    version,
    notesPath: notes,
    title,
    controlRemote,
    manifestPath: manifest,
    runnerId,
    token,
    apiUrl,
    ghBinary,
  });
  const out = resolve(outputPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ ok: true, intent, out }, null, 2));
}

async function releaseToken(tokenFile) {
  if (tokenFile) return (await readFile(resolve(tokenFile), "utf8")).trim();
  const environmentToken = process.env.GITHUB_TOKEN;
  return typeof environmentToken === "string" ? environmentToken.trim() : undefined;
}

async function execute(options) {
  requireOptions(options, ["intent", "approval"], "execute");
  const [intent, approval] = await Promise.all([
    readJson(options.intent),
    readJson(options.approval),
  ]);
  const executor = await ReleaseExecutor.open({
    repoPath: resolve(options.repo ?? process.cwd()),
    stateRoot: options.stateRoot,
    ghBinary: options.ghBinary ?? "gh",
  });
  const receipt = await executor.execute({ intent, approval });
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
