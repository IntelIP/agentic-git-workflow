import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { runGit } from "../lib/git-process.mjs";
import { RepositoryStore } from "../lib/repository-store.mjs";

export class NativeGitStore extends RepositoryStore {
  constructor({ repoPath, gitDir = null, isBare = false, workspaceRoot = null }) {
    super();
    this.repoPath = repoPath;
    this.gitDir = gitDir;
    this.isBare = isBare;
    this.workspaceRoot = workspaceRoot;
  }

  static async open(repoPath, { workspaceRoot = null } = {}) {
    const absolutePath = resolve(repoPath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Repository path is not a directory: ${absolutePath}`);

    const bareResult = await runGit({
      args: ["rev-parse", "--is-bare-repository"],
      cwd: absolutePath,
    });
    const isBare = bareResult.stdout.trim() === "true";

    let normalizedRepoPath = absolutePath;
    let gitDir = null;
    if (isBare) {
      normalizedRepoPath = await realpath(absolutePath);
      gitDir = normalizedRepoPath;
    } else {
      const root = await runGit({ args: ["rev-parse", "--show-toplevel"], cwd: absolutePath });
      normalizedRepoPath = await realpath(root.stdout.trim());
    }

    return new NativeGitStore({
      repoPath: normalizedRepoPath,
      gitDir,
      isBare,
      workspaceRoot: workspaceRoot ? await realpath(resolve(workspaceRoot)) : null,
    });
  }

  static async createBare(repoPath, { initialBranch = "main", workspaceRoot = null } = {}) {
    validateBranchName(initialBranch);
    await runGit({ args: ["check-ref-format", "--branch", initialBranch] });
    const absolutePath = resolve(repoPath);
    await runGit({ args: ["init", "--bare", `--initial-branch=${initialBranch}`, absolutePath] });
    return NativeGitStore.open(absolutePath, { workspaceRoot });
  }

  async resolveRef(revision) {
    requiredString(revision, "revision");
    const result = await this.#git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
    return result.stdout.trim();
  }

  async gitConfig(key) {
    requiredString(key, "config key");
    const result = await this.#git(["config", "--get", key], [0, 1]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async listFiles(revision) {
    const commit = await this.resolveRef(revision);
    const result = await this.#git(["ls-tree", "-rz", "--name-only", commit, "--"]);
    return splitNulls(result.stdout).sort();
  }

  async getDiff(baseRevision, headRevision) {
    const [baseCommit, headCommit] = await Promise.all([
      this.resolveRef(baseRevision),
      this.resolveRef(headRevision),
    ]);
    const result = await this.#git([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      baseCommit,
      headCommit,
      "--",
    ]);
    return {
      baseCommit,
      headCommit,
      files: parseNameStatus(result.stdout),
    };
  }

  async createWorkspace({ path, branch, startPoint }) {
    requiredString(branch, "branch");
    validateBranchName(branch);
    await this.#git(["check-ref-format", "--branch", branch]);
    const workspacePath = await this.#validateWorkspacePath(path);
    const startCommit = await this.resolveRef(startPoint);
    await this.#git(["worktree", "add", "--no-track", "-b", branch, workspacePath, startCommit]);
    return { path: workspacePath, branch, startCommit };
  }

  async removeWorkspace({ path, force = false }) {
    const workspacePath = await this.#validateWorkspacePath(path);
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(workspacePath);
    await this.#git(args);
    return { path: workspacePath, removed: true };
  }

  async readNote(revision, { notesRef = "refs/notes/tabellio/context" } = {}) {
    validateFullRef(notesRef, "notesRef", "refs/notes/");
    await this.#git(["check-ref-format", notesRef]);
    const commit = await this.resolveRef(revision);
    const result = await this.#git(
      ["notes", `--ref=${notesRef.slice("refs/notes/".length)}`, "show", commit],
      [0, 1],
    );
    if (result.exitCode === 0) return result.stdout.trimEnd();
    if (result.stderr.includes("no note found")) return null;
    throw new Error(`Unable to read Git note from ${notesRef}: ${result.stderr.trim()}`);
  }

  async previewMerge({ base, head }) {
    const [baseCommit, headCommit] = await Promise.all([this.resolveRef(base), this.resolveRef(head)]);
    const mergeBaseResult = await this.#git(["merge-base", baseCommit, headCommit]);
    const mergeBase = mergeBaseResult.stdout.trim();
    const result = await this.#git(
      ["merge-tree", "-z", "--write-tree", "--name-only", "--messages", baseCommit, headCommit],
      [0, 1],
    );
    const parsed = parseMergeTree(result.stdout);

    return {
      baseCommit,
      headCommit,
      mergeBase,
      clean: result.exitCode === 0,
      tree: parsed.tree,
      conflictFiles: parsed.conflictFiles,
      messages: result.stderr.trim() || parsed.messages.join("\n"),
    };
  }

  async compareAndSwapRef({ ref, newRevision, expectedOldCommit = null }) {
    validateFullRef(ref, "ref", "refs/");
    await this.#git(["check-ref-format", ref]);
    const newCommit = await this.resolveRef(newRevision);
    if (expectedOldCommit !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedOldCommit)) {
      throw new TypeError("expectedOldCommit must be an immutable Git object ID.");
    }
    if (expectedOldCommit !== null && expectedOldCommit.length !== newCommit.length) {
      throw new TypeError("expectedOldCommit must use the repository object format.");
    }
    const expected = expectedOldCommit ?? "0".repeat(newCommit.length);

    try {
      await this.#git(["update-ref", ref, newCommit, expected]);
    } catch (error) {
      if (error?.stderr?.includes("cannot lock ref") || error?.stderr?.includes("reference already exists")) {
        const current = await this.#git(["rev-parse", "--verify", "--end-of-options", ref], [0, 1]);
        const actual = current.exitCode === 0 ? current.stdout.trim() : null;
        throw new RefConflictError({ ref, expected: expectedOldCommit, actual });
      }
      throw error;
    }

    return { ref, oldCommit: expectedOldCommit, newCommit };
  }

  async #git(args, acceptableExitCodes = [0]) {
    return runGit({
      args,
      cwd: this.repoPath,
      gitDir: this.gitDir,
      acceptableExitCodes,
    });
  }

  async #validateWorkspacePath(path) {
    requiredString(path, "workspace path");
    if (!this.workspaceRoot) throw new Error("workspaceRoot is required for worktree operations.");
    const requestedPath = resolve(path);
    const existingPath = await nearestExistingPath(requestedPath);
    const absolutePath = resolve(await realpath(existingPath), relative(existingPath, requestedPath));
    const relation = relative(this.workspaceRoot, absolutePath);
    if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error(`Workspace path must be a child of ${this.workspaceRoot}.`);
    }
    return absolutePath;
  }
}

export class RefConflictError extends Error {
  constructor({ ref, expected, actual }) {
    super(`Ref ${ref} changed; expected ${expected ?? "missing"}, found ${actual ?? "missing"}.`);
    this.name = "RefConflictError";
    this.ref = ref;
    this.expected = expected;
    this.actual = actual;
  }
}

function parseNameStatus(value) {
  const fields = splitNulls(value);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!status || firstPath === undefined) throw new Error("Unexpected git diff --name-status output.");
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = fields[index++];
      if (path === undefined) throw new Error("Rename or copy output is missing its destination path.");
      files.push({ status, path, previousPath: firstPath });
    } else {
      files.push({ status, path: firstPath });
    }
  }
  return files;
}

function validateBranchName(value) {
  requiredString(value, "branch");
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\s~^:?*[\\]/.test(value)
  ) {
    throw new Error(`Invalid branch name: ${value}`);
  }
}

function validateFullRef(value, name, prefix) {
  requiredString(value, name);
  if (!value.startsWith(prefix) || value.includes("..") || value.includes("@{") || /[\s~^:?*[\\]/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string.`);
}

function splitNulls(value) {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function parseMergeTree(value) {
  const fields = value.split("\0");
  const tree = fields.shift() || null;
  const conflictFiles = [];
  while (fields.length > 0 && fields[0] !== "") conflictFiles.push(fields.shift());
  if (fields[0] === "") fields.shift();

  const messages = [];
  while (fields.length > 0 && fields[0] !== "") {
    const pathCount = Number.parseInt(fields.shift(), 10);
    if (!Number.isInteger(pathCount) || pathCount < 0 || fields.length < pathCount + 2) {
      throw new Error("Unexpected git merge-tree message output.");
    }
    fields.splice(0, pathCount);
    fields.shift();
    messages.push(fields.shift().trimEnd());
  }

  return {
    tree: tree && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) ? tree : null,
    conflictFiles: [...new Set(conflictFiles)].sort(),
    messages,
  };
}

async function nearestExistingPath(path) {
  let candidate = path;
  while (!(await stat(candidate).catch(() => null))) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) throw new Error(`No existing parent found for workspace path: ${path}`);
    candidate = parent;
  }
  return candidate;
}
