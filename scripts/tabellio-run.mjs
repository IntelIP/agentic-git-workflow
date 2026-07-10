#!/usr/bin/env node

import { resolve } from "node:path";

import { AgentRunManager } from "./lib/agent-run.mjs";

try {
  const { command, options, trailing } = parseCommand(process.argv.slice(2));
  const manager = await AgentRunManager.open({
    repoPath: resolve(options.repo ?? process.cwd()),
    runRoot: options.runRoot ? resolve(options.runRoot) : null,
  });
  const common = { runId: options.runId };
  let result;

  if (command === "start") {
    assertNoTrailing(command, trailing);
    result = await manager.start({
      ...common,
      baseRef: options.base ?? "main",
      branch: options.branch ?? `agent/${options.runId}`,
      repositoryId: options.repoId ?? null,
      actor: {
        type: options.actorType ?? "agent",
        id: options.actor ?? process.env.USER ?? "local-agent",
      },
      taskSummary: options.taskSummary,
      notesRef: options.notesRef,
    });
  } else if (command === "checkpoint") {
    assertNoTrailing(command, trailing);
    result = await manager.checkpoint({ ...common, summary: options.summary });
  } else if (command === "finish") {
    result = await manager.finish({
      ...common,
      validationCommand: trailing,
      onValidationOutput: ({ stdout, stderr }) => {
        if (stdout) process.stderr.write(stdout);
        if (stderr) process.stderr.write(stderr);
      },
    });
  } else if (command === "promote") {
    assertNoTrailing(command, trailing);
    result = await manager.promote(common);
  } else if (command === "status") {
    assertNoTrailing(command, trailing);
    result = await manager.status(common);
  } else {
    throw new Error(`Unknown command: ${command ?? "missing"}. Expected start, checkpoint, finish, promote, or status.`);
  }

  if (!result.ok) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  }, null, 2));
}

function parseCommand(argv) {
  const command = argv[0];
  const separator = argv.indexOf("--");
  const optionArgs = separator === -1 ? argv.slice(1) : argv.slice(1, separator);
  const trailing = separator === -1 ? [] : argv.slice(separator + 1);
  const options = {};
  const aliases = new Map([
    ["--repo", "repo"],
    ["--run-root", "runRoot"],
    ["--run-id", "runId"],
    ["--repo-id", "repoId"],
    ["--base", "base"],
    ["--branch", "branch"],
    ["--task-summary", "taskSummary"],
    ["--summary", "summary"],
    ["--actor", "actor"],
    ["--actor-type", "actorType"],
    ["--notes-ref", "notesRef"],
  ]);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const key = aliases.get(optionArgs[index]);
    if (!key) throw new Error(`Unknown argument: ${optionArgs[index]}`);
    const value = optionArgs[++index];
    if (!value) throw new Error(`${optionArgs[index - 1]} requires a value.`);
    options[key] = value;
  }
  if (!options.runId) throw new Error("--run-id is required.");
  return { command, options, trailing };
}

function assertNoTrailing(command, trailing) {
  if (trailing.length > 0) throw new Error(`${command} does not accept a command after --.`);
}
