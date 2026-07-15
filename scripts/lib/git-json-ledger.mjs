import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runGit } from "./git-process.mjs";

export class GitJsonLedger {
  constructor({ repoPath, ref }) {
    this.repoPath = repoPath;
    this.ref = ref;
  }

  static async open({ repoPath = process.cwd(), ref }) {
    requiredString(ref, "ref");
    if (!ref.startsWith("refs/tabellio/")) throw new Error("ledger ref must start with refs/tabellio/.");
    const bare = await runGit({ args: ["rev-parse", "--is-bare-repository"], cwd: repoPath });
    const normalized = bare.stdout.trim() === "true"
      ? await realpath(resolve(repoPath))
      : (await runGit({ args: ["rev-parse", "--show-toplevel"], cwd: repoPath })).stdout.trim();
    await runGit({ args: ["check-ref-format", ref], cwd: normalized });
    return new GitJsonLedger({ repoPath: normalized, ref });
  }

  async version() {
    const result = await runGit({
      args: ["rev-parse", "--verify", "--end-of-options", `${this.ref}^{commit}`],
      cwd: this.repoPath,
      acceptableExitCodes: [0, 1, 128],
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async read(path) {
    validateLedgerPath(path);
    const version = await this.version();
    if (version === null) return { value: null, version: null };
    const result = await runGit({
      args: ["show", `${version}:${path}`],
      cwd: this.repoPath,
      acceptableExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) {
      if (result.stderr.includes("does not exist") || result.stderr.includes("exists on disk, but not in")) {
        return { value: null, version };
      }
      throw new Error(`Unable to read ledger entry ${path}: ${result.stderr.trim()}`);
    }
    try {
      return { value: JSON.parse(result.stdout), version };
    } catch {
      throw new Error(`Ledger entry ${path} is not valid JSON.`);
    }
  }

  async list(prefix = "") {
    if (prefix !== "") validateLedgerPath(prefix.replace(/\/$/, ""));
    const version = await this.version();
    if (version === null) return { paths: [], version: null };
    const args = ["ls-tree", "-rz", "--name-only", version];
    if (prefix !== "") args.push("--", prefix);
    const result = await runGit({ args, cwd: this.repoPath });
    return {
      paths: result.stdout.split("\0").filter(Boolean).sort(),
      version,
    };
  }

  async write(path, value, { expectedVersion, replacePath = null }) {
    validateLedgerPath(path);
    if (replacePath !== null) {
      validateLedgerPath(replacePath);
      if (replacePath === path) throw new Error("ledger replacement and destination paths must differ.");
    }
    return this.#commit({ path, value, expectedVersion, sourcePath: replacePath });
  }

  async #commit({ path, value, expectedVersion, sourcePath = null }) {
    validateExpectedVersion(expectedVersion);
    const currentVersion = await this.version();
    assertExpectedVersion(this.ref, expectedVersion, currentVersion);
    const serialized = serializeLedgerValue(value);
    await validateReplacement(this.repoPath, currentVersion, sourcePath, path);
    const { indexPath, valuePath } = await temporaryLedgerPaths(this.repoPath);
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await writeFile(valuePath, `${serialized}\n`, { flag: "wx" });
      await initializeLedgerIndex(this.repoPath, currentVersion, env);
      await removeLedgerSource(this.repoPath, sourcePath, env);
      const blob = await runGit({ args: ["hash-object", "-w", "--", valuePath], cwd: this.repoPath });
      await runGit({
        args: ["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${path}`],
        cwd: this.repoPath,
        env,
      });
      const tree = await runGit({ args: ["write-tree"], cwd: this.repoPath, env });
      const commit = await createLedgerCommit(this.repoPath, tree.stdout.trim(), currentVersion, sourcePath, path);
      const newVersion = commit.stdout.trim();
      await updateLedgerRef(this, currentVersion, newVersion);
      return { path, sourcePath, version: newVersion, previousVersion: currentVersion };
    } finally {
      await Promise.all([
        rm(indexPath, { force: true }),
        rm(valuePath, { force: true }),
      ]);
    }
  }
}

function validateExpectedVersion(expectedVersion) {
  if (expectedVersion !== null && !isOid(expectedVersion)) {
    throw new TypeError("expectedVersion must be null or a Git object ID.");
  }
}

function assertExpectedVersion(ref, expectedVersion, currentVersion) {
  if (currentVersion !== expectedVersion) {
    throw new LedgerConflictError({ ref, expected: expectedVersion, actual: currentVersion });
  }
}

function serializeLedgerValue(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("ledger value must be JSON-serializable.");
  return serialized;
}

async function validateReplacement(repoPath, currentVersion, sourcePath, path) {
  if (sourcePath === null) return;
  if (currentVersion === null) throw new Error(`Ledger entry ${sourcePath} does not exist.`);
  await requireTreeEntry(repoPath, currentVersion, sourcePath);
  await requireMissingTreeEntry(repoPath, currentVersion, path);
}

async function requireTreeEntry(repoPath, version, path) {
  if (!(await treeEntryExists(repoPath, version, path))) throw new Error(`Ledger entry ${path} does not exist.`);
}

async function requireMissingTreeEntry(repoPath, version, path) {
  if (await treeEntryExists(repoPath, version, path)) throw new Error(`Ledger entry ${path} already exists.`);
}

async function temporaryLedgerPaths(repoPath) {
  const common = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: repoPath });
  const root = resolve(repoPath, common.stdout.trim(), "tabellio", "tmp");
  await mkdir(root, { recursive: true });
  const nonce = randomUUID();
  return {
    indexPath: resolve(root, `${nonce}.index`),
    valuePath: resolve(root, `${nonce}.json`),
  };
}

function initializeLedgerIndex(repoPath, currentVersion, env) {
  const args = currentVersion === null ? ["read-tree", "--empty"] : ["read-tree", currentVersion];
  return runGit({ args, cwd: repoPath, env });
}

function removeLedgerSource(repoPath, sourcePath, env) {
  if (sourcePath === null) return Promise.resolve();
  return runGit({ args: ["update-index", "--force-remove", "--", sourcePath], cwd: repoPath, env });
}

function createLedgerCommit(repoPath, tree, currentVersion, sourcePath, path) {
  const detail = sourcePath === null ? path : `${sourcePath} -> ${path}`;
  const args = ["commit-tree", tree, "-m", `tabellio ledger: ${detail}`];
  if (currentVersion !== null) args.push("-p", currentVersion);
  return runGit({
    args,
    cwd: repoPath,
    env: {
      GIT_AUTHOR_NAME: "Tabellio",
      GIT_AUTHOR_EMAIL: "tabellio@example.invalid",
      GIT_COMMITTER_NAME: "Tabellio",
      GIT_COMMITTER_EMAIL: "tabellio@example.invalid",
    },
  });
}

async function updateLedgerRef(ledger, currentVersion, newVersion) {
  const expected = currentVersion ?? "0".repeat(newVersion.length);
  try {
    await runGit({ args: ["update-ref", ledger.ref, newVersion, expected], cwd: ledger.repoPath });
  } catch {
    const actual = await ledger.version();
    throw new LedgerConflictError({ ref: ledger.ref, expected: currentVersion, actual });
  }
}

async function treeEntryExists(repoPath, version, path) {
  const result = await runGit({
    args: ["cat-file", "-e", `${version}:${path}`],
    cwd: repoPath,
    acceptableExitCodes: [0, 128],
  });
  return result.exitCode === 0;
}

export class LedgerConflictError extends Error {
  constructor({ ref, expected, actual }) {
    super(`Ledger ${ref} changed concurrently; expected ${expected ?? "missing"}, found ${actual ?? "missing"}.`);
    this.name = "LedgerConflictError";
    this.ref = ref;
    this.expected = expected;
    this.actual = actual;
  }
}

function validateLedgerPath(path) {
  requiredString(path, "path");
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || /[\0-\x1f]/.test(path)) {
    throw new Error("ledger path must be a safe relative path.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("ledger path contains an unsupported segment.");
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
}

function isOid(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
