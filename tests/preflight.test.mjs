import assert from "node:assert/strict";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
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

  await writeCodexTrust(fixture, ["session_start", "user_prompt_submit", "stop", "post_tool_use"], "not-a-digest");
  const malformed = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(malformed.checks.find((check) => check.id === "codex-hook-trust").status, "blocked");

  await writeFile(fixture.codexConfigPath, [
    `[hooks.state."${join(await realpath(fixture.seed), ".codex", "hooks.json")}:post_tool_use:0:0"]`,
    "[unrelated]",
    `trusted_hash = "sha256:${"a".repeat(64)}"`,
  ].join("\n"));
  const unrelated = await runPreparedPreflight(fixture, { commandRunner: fakeCommands() });
  assert.equal(unrelated.checks.find((check) => check.id === "codex-hook-trust").status, "blocked");
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
  return fixture;
}

async function runPreparedPreflight(fixture, options = {}) {
  return runPreflight({
    repoPath: fixture.seed,
    codexConfigPath: fixture.codexConfigPath,
    ...options,
  });
}

async function writeCodexTrust(fixture, events, digest = "sha256:" + "a".repeat(64)) {
  const hooksPath = join(await realpath(fixture.seed), ".codex", "hooks.json");
  const sections = events.map((event) => [
    `[hooks.state."${hooksPath}:${event}:0:0"]`,
    `trusted_hash = "${digest}"`,
  ].join("\n"));
  await writeFile(fixture.codexConfigPath, sections.join("\n\n") + "\n");
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

function fakeCommands({ privateControl = true } = {}) {
  const commands = new Map([
    ["entire:--version", () => result("Entire CLI 0.7.7\n")],
    ["entire:status", () => result('{"enabled":true,"agents":["Codex"],"active_sessions":[]}\n')],
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
