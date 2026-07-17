#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovedControlRefTransport,
  CONTROL_REFS,
  createControlRefIntent,
  readControlRefFile,
  snapshotControlRefs,
} from "./lib/control-ref-transport.mjs";
import { parseCommandOptions } from "./lib/cli-options.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

const askpassPath = fileURLToPath(new URL("./lib/git-askpass.mjs", import.meta.url));

try {
  const options = parse(process.argv.slice(2));
  if (options.command === "plan") await plan(options);
  else await execute(options);
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
}

async function plan(options) {
  const repoPath = resolve(options.repo ?? process.cwd());
  const store = await NativeGitStore.open(repoPath);
  const env = credentialEnv(options);
  const refs = options.refs ? options.refs.split(",") : CONTROL_REFS;
  if (!options.remote) throw new Error("plan requires --remote for an external control-state destination.");
  const intent = createControlRefIntent({
    operation: options.operation,
    repositoryId: await repositoryIdentity(store, options.repoId),
    remote: options.remote,
    refs: await snapshotControlRefs({ repoPath, remote: options.remote, refs, env }),
  });
  await output(intent, options.out);
}

async function execute(options) {
  const repoPath = resolve(options.repo ?? process.cwd());
  const store = await NativeGitStore.open(repoPath);
  const [intent, approval] = await Promise.all([
    readControlRefFile(resolve(options.intent)),
    readControlRefFile(resolve(options.approval)),
  ]);
  const transport = await ApprovedControlRefTransport.open({ repoPath, stateRoot: options.stateRoot, env: credentialEnv(options) });
  const result = await transport.execute({ intent, approval, repositoryId: await repositoryIdentity(store, options.repoId) });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

function credentialEnv(options) {
  if (!options.tokenFile) return {};
  const tokenFile = resolve(options.tokenFile);
  return {
    GIT_ASKPASS: askpassPath,
    GIT_ASKPASS_REQUIRE: "force",
    TABELLIO_GIT_USERNAME: options.gitUsername ?? "git",
    TABELLIO_GIT_TOKEN_FILE: tokenFile,
  };
}

async function output(value, path) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) return process.stdout.write(text);
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, { flag: "wx" });
}

function parse(args) {
  const values = parseCommandOptions(args, {
    plan: ["operation", "repo", "repoId", "remote", "refs", "out", "tokenFile", "gitUsername"],
    execute: ["repo", "repoId", "intent", "approval", "stateRoot", "tokenFile", "gitUsername"],
  });
  const { command } = values;
  if (command === "plan" && !["publish", "fetch"].includes(values.operation)) throw new Error("plan requires --operation publish or fetch.");
  if (command === "execute" && (!values.intent || !values.approval)) throw new Error("execute requires --intent and --approval.");
  if (values.tokenFile && !values.gitUsername) values.gitUsername = "git";
  return values;
}
