import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { runPreflight, validatePreflightResult } from "../scripts/lib/preflight.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";
import { platformFixture } from "./helpers/platform-fixture.mjs";

test("preflight proves GitHub and Entire readiness without exposing credentials", async (t) => {
  const fixture = await preparedFixture(t);
  const result = await runPreparedPreflight(fixture, {
    profile: "agent",
    commandRunner: fakeCommands(),
    now: new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
  assert.equal(JSON.stringify(result).includes("gho_secret"), false);
  assert.equal(validatePreflightResult(result), result);
});

test("preflight fails early with exact Codex hook approval remedy", async (t) => {
  const fixture = await preparedFixture(t);
  await writeCodexTrust(fixture, ["session_start", "user_prompt_submit", "stop"]);
  const result = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(result.status, "blocked");
  const trust = result.checks.find((check) => check.id === "codex-hook-trust");
  assert.equal(trust.status, "blocked");
  assert.match(trust.resolution, /Open \/hooks in Codex/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { digest: "sha256:" + "a".repeat(64) });
  const stale = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(stale.checks.find((check) => check.id === "codex-hook-trust").detail, /stale/);
});

test("preflight requires active hooks and a trusted project layer", async (t) => {
  const fixture = await preparedFixture(t);
  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { hooksEnabled: false, hooksComment: true });
  const disabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(disabled.checks.find((check) => check.id === "codex-hook-trust").detail, /disabled/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES));
  await writeFile(join(fixture.seed, ".codex", "config.toml"), "[features]\nhooks = false # project override\n");
  const projectDisabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(projectDisabled.checks.find((check) => check.id === "codex-hook-trust").detail, /project \.codex/);
  await rm(join(fixture.seed, ".codex", "config.toml"));

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { disabledEvent: "stop" });
  const handlerDisabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(handlerDisabled.checks.find((check) => check.id === "codex-hook-trust").detail, /stop/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { projectTrusted: false });
  const untrusted = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(untrusted.checks.find((check) => check.id === "codex-hook-trust").detail, /project layer/);

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { encodeKeys: true });
  const escaped = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(escaped.checks.find((check) => check.id === "codex-hook-trust").status, "passed");

  await writeCodexTrust(fixture, Object.keys(FIXTURE_HOOK_HASHES), { literalKeys: true });
  const literal = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(literal.checks.find((check) => check.id === "codex-hook-trust").status, "passed");

  const hooksPath = join(fixture.seed, ".codex", "hooks.json");
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  hooks.hooks.Stop[0].hooks[0].additionalContextLimit = 999;
  await writeFile(hooksPath, JSON.stringify(hooks));
  const stopContext = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(stopContext.checks.find((check) => check.id === "codex-hook-trust").status, "passed");
});

test("preflight verifies Entire metadata ancestry without repairing it", async (t) => {
  const fixture = await preparedFixture(t);
  const remoteRef = "refs/remotes/control/entire/checkpoints/v1";
  await runGit({ args: ["update-ref", "-d", remoteRef], cwd: fixture.seed });
  const missing = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(missing.checks.find((check) => check.id === "entire-metadata").detail, /missing/);

  const tree = (await runGit({ args: ["rev-parse", "HEAD^{tree}"], cwd: fixture.seed })).stdout.trim();
  const isolated = (await runGit({
    args: ["commit-tree", tree, "-m", "Disconnected checkpoint metadata"],
    cwd: fixture.seed,
    env: identityEnv(),
  })).stdout.trim();
  await runGit({ args: ["update-ref", remoteRef, isolated], cwd: fixture.seed });
  const disconnected = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(disconnected.checks.find((check) => check.id === "entire-metadata").detail, /disconnected/);

  const remoteAhead = (await runGit({
    args: ["commit-tree", tree, "-p", "HEAD", "-m", "Remote checkpoint metadata"],
    cwd: fixture.seed,
    env: identityEnv(),
  })).stdout.trim();
  await runGit({ args: ["update-ref", remoteRef, remoteAhead], cwd: fixture.seed });
  const ahead = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(ahead.checks.find((check) => check.id === "entire-metadata").detail, /ahead/);
});

test("preflight uses the repository root and rejects invalid Codex configuration", async (t) => {
  const fixture = await preparedFixture(t);
  const nested = join(fixture.seed, "nested", "path");
  await mkdir(nested, { recursive: true });
  const rooted = await runPreparedPreflight(fixture, { repoPath: nested, commandRunner: fakeCommands() });
  assert.equal(rooted.status, "ready");

  await writeFile(fixture.codexConfigPath, "[features]\nhooks = true\n[features]\nhooks = true\n");
  const invalid = await runPreparedPreflight(fixture, { commandRunner: fakeCommands({ invalidCodexConfig: true }) });
  assert.equal(invalid.checks.find((check) => check.id === "codex-config").status, "blocked");
  assert.match(invalid.checks.find((check) => check.id === "codex-hook-trust").detail, /unproven/);
});

test("release preflight requires clean main equal to origin main", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, "DIRTY.md"), "dirty\n");
  const result = await runPreparedPreflight(fixture, {
    profile: "release",
    commandRunner: fakeCommands(),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.checks.find((check) => check.id === "clean-main").detail, /not clean/);
});

test("preflight requires executable Entire hook commands, not empty event keys", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, ".codex", "hooks.json"), JSON.stringify({
    hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [], PostToolUse: [] },
  }));
  const result = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  const hooks = result.checks.find((check) => check.id === "codex-hooks");
  assert.equal(hooks.status, "blocked");
  assert.match(hooks.detail, /sessionstart/);

  await writeEntireHooks(fixture.seed, (command) => `false && entire hooks codex ${command}`);
  const disabled = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(disabled.checks.find((check) => check.id === "codex-hooks").status, "blocked");
});

test("preflight normalizes GitHub remote identities and requires private control storage", async (t) => {
  const fixture = await preparedFixture(t);
  await runGit({ args: ["remote", "set-url", "control", "ssh://git@github.com/example/repository-control.git"], cwd: fixture.seed });
  const sshUrl = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(sshUrl.checks.find((check) => check.id === "github-remotes").status, "passed");

  await runGit({ args: ["remote", "set-url", "--add", "--push", "origin", "https://github.com/example/redirected.git"], cwd: fixture.seed });
  const pushUrl = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(pushUrl.checks.find((check) => check.id === "github-remotes").detail, /effective fetch and push URLs target different/);
  await runGit({ args: ["config", "--unset-all", "remote.origin.pushurl"], cwd: fixture.seed });

  await runGit({ args: ["config", "url.https://github.com/example/rewritten.git.pushInsteadOf", "https://github.com/example/repository.git"], cwd: fixture.seed });
  const rewritten = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(rewritten.checks.find((check) => check.id === "github-remotes").detail, /effective fetch and push URLs target different/);
  await runGit({ args: ["config", "--unset-all", "url.https://github.com/example/rewritten.git.pushInsteadOf"], cwd: fixture.seed });

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:EXAMPLE/REPOSITORY.git"], cwd: fixture.seed });
  const same = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.match(same.checks.find((check) => check.id === "github-remotes").detail, /same GitHub repository/);

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:example/repository-control.git"], cwd: fixture.seed });
  const publicControl = await runPreparedPreflight(fixture, {
    commandRunner: fakeCommands({ privateControl: false }),
  });
  assert.match(publicControl.checks.find((check) => check.id === "github-remotes").detail, /public/);
});

test("release preflight binds configured control remote and live origin main", async (t) => {
  const fixture = await preparedFixture(t);
  const wrongControl = await runPreparedPreflight(fixture, {
    profile: "release",
    controlRemote: "backup",
    commandRunner: fakeCommands(),
  });
  assert.match(wrongControl.checks.find((check) => check.id === "github-remotes").detail, /does not match platform remote/);

  await runGit({ args: ["add", ".codex/hooks.json", "tabellio.platform.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Add preflight contract"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", "refs/remotes/origin/main", "HEAD"], cwd: fixture.seed });
  const stale = await runPreparedPreflight(fixture, {
    profile: "release",
    commandRunner: fakeCommands(),
    remoteRefReader: async () => "f".repeat(40),
  });
  assert.match(stale.checks.find((check) => check.id === "clean-main").detail, /live origin\/main/);
});

async function preparedFixture(t) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await runGit({ args: ["remote", "set-url", "origin", "https://github.com/example/repository.git"], cwd: fixture.seed });
  await runGit({ args: ["remote", "add", "control", "git@github.com:example/repository-control.git"], cwd: fixture.seed });
  await mkdir(join(fixture.seed, ".codex"), { recursive: true });
  await writeEntireHooks(fixture.seed, (command) => `entire hooks codex ${command}`);
  fixture.codexConfigPath = join(fixture.root, "codex-config.toml");
  await writeCodexTrust(fixture, ["session_start", "user_prompt_submit", "stop", "post_tool_use"]);
  await writeFile(join(fixture.seed, "tabellio.platform.json"), JSON.stringify(platformFixture()));
  await runGit({ args: ["update-ref", "refs/heads/entire/checkpoints/v1", "HEAD"], cwd: fixture.seed });
  await runGit({ args: ["update-ref", "refs/remotes/control/entire/checkpoints/v1", "HEAD"], cwd: fixture.seed });
  return fixture;
}

async function runPreparedPreflight(fixture, options = {}) {
  return runPreflight({
    repoPath: fixture.seed,
    codexConfigPath: fixture.codexConfigPath,
    ...options,
  });
}

const FIXTURE_HOOK_HASHES = {
  session_start: "sha256:a6399ffe129edf2146be06d4ee584e8cb8a7fbb40da326d8ff1c2deb22876ca5",
  user_prompt_submit: "sha256:9c424e2158a618f360a1ae34341d492b8a09a42e920d0bde75da7850c54dd3ef",
  stop: "sha256:edd6678b7563e9c0a42fa2fecbd802d9e228ecb62c8eda3ea033d16cc1f66b54",
  post_tool_use: "sha256:17eefa5e04078c56f71cc43407b870a4590c2b8ed5d9a8b3b70f07e825cd1b8a",
};

async function writeCodexTrust(fixture, events, {
  digest = null,
  hooksEnabled = true,
  projectTrusted = true,
  encodeKeys = false,
  literalKeys = false,
  hooksComment = false,
  disabledEvent = null,
} = {}) {
  const repoPath = await realpath(fixture.seed);
  const hooksPath = join(repoPath, ".codex", "hooks.json");
  const sections = events.map((event) => [
    tomlTable("hooks.state", `${hooksPath}:${event}:0:0`, { encode: encodeKeys, literal: literalKeys }),
    `trusted_hash = "${digest ?? FIXTURE_HOOK_HASHES[event]}"`,
    ...(event === disabledEvent ? ["enabled = false"] : []),
  ].join("\n"));
  const config = [
    "[features]",
    `hooks = ${hooksEnabled}${hooksComment ? " # intentionally disabled" : ""}`,
    "",
    tomlTable("projects", repoPath, { literal: literalKeys }),
    `trust_level = "${projectTrusted ? "trusted" : "untrusted"}"`,
    "",
    ...sections,
  ].join("\n\n");
  await writeFile(fixture.codexConfigPath, config + "\n");
}

function tomlKey(value, encode) {
  const escaped = JSON.stringify(value).slice(1, -1);
  return encode ? escaped.replaceAll("/", "\\u002f") : escaped;
}

function tomlTable(prefix, value, { encode = false, literal = false } = {}) {
  if (literal) return `[${prefix}.'${value}']`;
  return `[${prefix}."${tomlKey(value, encode)}"]`;
}

async function writeEntireHooks(repoPath, commandFor) {
  const commands = [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "user-prompt-submit"],
    ["Stop", "stop"],
    ["PostToolUse", "post-tool-use"],
  ];
  const hooks = Object.fromEntries(commands.map(([event, command]) => [
    event,
    [{ hooks: [{ type: "command", command: commandFor(command) }] }],
  ]));
  await writeFile(join(repoPath, ".codex", "hooks.json"), JSON.stringify({ hooks }));
}

function fakeCommands({ privateControl = true, invalidCodexConfig = false } = {}) {
  const commands = new Map([
    ["entire:--version", () => result("Entire CLI 0.7.7\n")],
    ["entire:status", () => result('{"enabled":true,"agents":["Codex"],"active_sessions":[]}\n')],
    ["codex:features", () => {
      if (invalidCodexConfig) throw new Error("Codex config.toml contains a duplicate table.");
      return result("hooks stable true\n");
    }],
    ["gh:auth", () => result("", "Logged in with gho_secret\n")],
    ["gh:repo", () => result(`${JSON.stringify({ nameWithOwner: "example/repository-control", isPrivate: privateControl })}\n`)],
  ]);
  return async ({ binary, args }) => {
    const handler = commands.get(`${binary}:${args[0]}`);
    if (handler) return handler();
    throw new Error(`Unexpected command: ${binary} ${args.join(" ")}`);
  };
}

function result(stdout, stderr = "") {
  return { stdout, stderr, exitCode: 0, signal: null };
}
