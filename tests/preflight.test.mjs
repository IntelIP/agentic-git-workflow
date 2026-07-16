import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../scripts/lib/git-process.mjs";
import { runPreflight, validatePreflightResult } from "../scripts/lib/preflight.mjs";
import { createFixture, identityEnv } from "./helpers/git-fixture.mjs";
import { platformFixture } from "./helpers/platform-fixture.mjs";

test("preflight proves GitHub and Entire readiness without exposing credentials", async (t) => {
  const fixture = await preparedFixture(t);
  const result = await runPreflight({
    repoPath: fixture.seed,
    profile: "agent",
    commandRunner: fakeCommands({ trusted: true }),
    now: new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
  assert.equal(JSON.stringify(result).includes("gho_secret"), false);
  assert.equal(validatePreflightResult(result), result);
});

test("preflight fails early with exact Codex hook approval remedy", async (t) => {
  const fixture = await preparedFixture(t);
  const result = await runPreflight({
    repoPath: fixture.seed,
    commandRunner: fakeCommands({ trusted: false }),
  });
  assert.equal(result.status, "blocked");
  const trust = result.checks.find((check) => check.id === "entire-doctor");
  assert.equal(trust.status, "blocked");
  assert.match(trust.resolution, /Open \/hooks in Codex/);
});

test("release preflight requires clean main equal to origin main", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, "DIRTY.md"), "dirty\n");
  const result = await runPreflight({
    repoPath: fixture.seed,
    profile: "release",
    commandRunner: fakeCommands({ trusted: true }),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.checks.find((check) => check.id === "clean-main").detail, /not clean/);
});

test("preflight requires executable Entire hook commands, not empty event keys", async (t) => {
  const fixture = await preparedFixture(t);
  await writeFile(join(fixture.seed, ".codex", "hooks.json"), JSON.stringify({
    hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [], PostToolUse: [] },
  }));
  const result = await runPreflight({ repoPath: fixture.seed, commandRunner: fakeCommands({ trusted: true }) });
  const hooks = result.checks.find((check) => check.id === "codex-hooks");
  assert.equal(hooks.status, "blocked");
  assert.match(hooks.detail, /sessionstart/);

  await writeEntireHooks(fixture.seed, (command) => `false && entire hooks codex ${command}`);
  const disabled = await runPreflight({ repoPath: fixture.seed, commandRunner: fakeCommands({ trusted: true }) });
  assert.equal(disabled.checks.find((check) => check.id === "codex-hooks").status, "blocked");
});

test("preflight normalizes GitHub remote identities and requires private control storage", async (t) => {
  const fixture = await preparedFixture(t);
  await runGit({ args: ["remote", "set-url", "control", "ssh://git@github.com/example/repository-control.git"], cwd: fixture.seed });
  const sshUrl = await runPreflight({ repoPath: fixture.seed, commandRunner: fakeCommands({ trusted: true }) });
  assert.equal(sshUrl.checks.find((check) => check.id === "github-remotes").status, "passed");

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:EXAMPLE/REPOSITORY.git"], cwd: fixture.seed });
  const same = await runPreflight({ repoPath: fixture.seed, commandRunner: fakeCommands({ trusted: true }) });
  assert.match(same.checks.find((check) => check.id === "github-remotes").detail, /same GitHub repository/);

  await runGit({ args: ["remote", "set-url", "control", "git@github.com:example/repository-control.git"], cwd: fixture.seed });
  const publicControl = await runPreflight({
    repoPath: fixture.seed,
    commandRunner: fakeCommands({ trusted: true, privateControl: false }),
  });
  assert.match(publicControl.checks.find((check) => check.id === "github-remotes").detail, /public/);
});

test("release preflight binds configured control remote and live origin main", async (t) => {
  const fixture = await preparedFixture(t);
  const wrongControl = await runPreflight({
    repoPath: fixture.seed,
    profile: "release",
    controlRemote: "backup",
    commandRunner: fakeCommands({ trusted: true }),
  });
  assert.match(wrongControl.checks.find((check) => check.id === "github-remotes").detail, /does not match platform remote/);

  await runGit({ args: ["add", ".codex/hooks.json", "tabellio.platform.json"], cwd: fixture.seed });
  await runGit({ args: ["commit", "-m", "Add preflight contract"], cwd: fixture.seed, env: identityEnv() });
  await runGit({ args: ["update-ref", "refs/remotes/origin/main", "HEAD"], cwd: fixture.seed });
  const stale = await runPreflight({
    repoPath: fixture.seed,
    profile: "release",
    commandRunner: fakeCommands({ trusted: true }),
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
  await writeFile(join(fixture.seed, "tabellio.platform.json"), JSON.stringify(platformFixture()));
  return fixture;
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

function fakeCommands({ trusted, privateControl = true }) {
  const commands = new Map([
    ["entire:--version", () => result("Entire CLI 0.7.7\n")],
    ["entire:status", () => result('{"enabled":true,"agents":["Codex"],"active_sessions":[]}\n')],
    ["entire:doctor", () => result(`Metadata branches: OK\nCodex hook trust: ${trusted ? "OK" : "REVIEW NEEDED"}\n`)],
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
