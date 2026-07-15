import { realpath } from "node:fs/promises";

import { ExternalCommandError, runExternalCommand } from "../lib/external-command.mjs";
import { runGit } from "../lib/git-process.mjs";
import { STACK_SCHEMA_VERSION, StackManager, validateStackSnapshot } from "../lib/stack-manager.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitSpiceStackManager extends StackManager {
  constructor({ repoPath, binary = "git-spice", timeoutMs = DEFAULT_TIMEOUT_MS }) {
    super();
    requiredString(repoPath, "repoPath");
    requiredString(binary, "binary");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer.");
    this.repoPath = repoPath;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }

  static async open(repoPath, options = {}) {
    const result = await runGit({ args: ["rev-parse", "--show-toplevel"], cwd: repoPath });
    return new GitSpiceStackManager({
      ...options,
      repoPath: await realpath(result.stdout.trim()),
    });
  }

  async toolVersion() {
    const result = await this.#run(["version", "--short"]);
    const version = result.stdout.trim();
    requiredString(version, "git-spice version");
    const normalized = version.replace(/^v/, "");
    requireMinimumVersion(normalized, [0, 18, 0]);
    return normalized;
  }

  async snapshot({ repositoryId, capturedAt = new Date().toISOString() }) {
    requiredString(repositoryId, "repositoryId");
    const version = await this.toolVersion();
    const result = await this.#run([
      "--no-prompt",
      "log",
      "short",
      "--all",
      "--json",
      "--cr-status=false",
      "--cr-comments=false",
    ]);
    const rawBranches = parseJsonLines(result.stdout);
    const branches = rawBranches.map(normalizeBranch).sort((left, right) => left.name.localeCompare(right.name));
    const currentBranch = branches.find((branch) => branch.current)?.name ?? null;
    const snapshot = {
      schemaVersion: STACK_SCHEMA_VERSION,
      repository: { id: repositoryId },
      provider: { id: "git-spice", version },
      capturedAt,
      currentBranch,
      roots: branches.filter((branch) => branch.parent === null).map((branch) => branch.name).sort(),
      branches,
    };
    return validateStackSnapshot(snapshot);
  }

  #run(args) {
    return runGitSpice({
      binary: this.binary,
      args,
      cwd: this.repoPath,
      timeoutMs: this.timeoutMs,
    });
  }
}

export class GitSpiceCommandError extends ExternalCommandError {
  constructor(result) {
    super(result);
    this.name = "GitSpiceCommandError";
  }
}

export function runGitSpice({
  binary = "git-spice",
  args,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = {},
}) {
  return runExternalCommand({
    binary,
    args,
    cwd,
    timeoutMs,
    env,
    ErrorType: GitSpiceCommandError,
    argumentLabel: "git-spice",
  });
}

function parseJsonLines(value) {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!isObject(parsed)) throw new Error("expected object");
      return parsed;
    } catch (error) {
      throw new Error(`git-spice JSON line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

function normalizeBranch(value, index) {
  requiredString(value.name, `git-spice branch ${index}.name`);
  if (value.current !== undefined && typeof value.current !== "boolean") {
    throw new Error(`git-spice branch ${value.name}.current must be a boolean.`);
  }
  if (value.worktree !== undefined && typeof value.worktree !== "string") {
    throw new Error(`git-spice branch ${value.name}.worktree must be a string.`);
  }
  if (value.ups !== undefined && !Array.isArray(value.ups)) {
    throw new Error(`git-spice branch ${value.name}.ups must be an array.`);
  }
  if (value.down !== undefined && !isObject(value.down)) {
    throw new Error(`git-spice branch ${value.name}.down must be an object.`);
  }
  if (value.down?.needsRestack !== undefined && typeof value.down.needsRestack !== "boolean") {
    throw new Error(`git-spice branch ${value.name}.down.needsRestack must be a boolean.`);
  }
  if (value.change !== undefined && !isObject(value.change)) {
    throw new Error(`git-spice branch ${value.name}.change must be an object.`);
  }
  if (value.push !== undefined && !isObject(value.push)) {
    throw new Error(`git-spice branch ${value.name}.push must be an object.`);
  }
  if (value.push?.needsPush !== undefined && typeof value.push.needsPush !== "boolean") {
    throw new Error(`git-spice branch ${value.name}.push.needsPush must be a boolean.`);
  }
  const children = value.ups !== undefined
    ? value.ups.map((branch, childIndex) => {
      requiredString(branch?.name, `git-spice branch ${value.name}.ups[${childIndex}].name`);
      return branch.name;
    }).sort()
    : [];
  const parent = value.down === undefined ? null : value.down?.name;
  if (parent !== null) requiredString(parent, `git-spice branch ${value.name}.down.name`);
  return {
    name: value.name,
    current: value.current === true,
    parent,
    children,
    needsRestack: value.down?.needsRestack === true,
    checkedOutElsewhere: typeof value.worktree === "string" && value.worktree.length > 0,
    changeRequest: value.change === undefined ? null : {
      id: value.change.id,
      url: value.change.url,
      status: value.change.status ?? null,
    },
    push: value.push === undefined ? null : {
      ahead: value.push.ahead,
      behind: value.push.behind,
      needsPush: value.push.needsPush === true,
    },
  };
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMinimumVersion(value, minimum) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`git-spice version has unsupported format: ${value}.`);
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`git-spice ${minimum.join(".")} or later is required; found ${value}.`);
    }
  }
}
