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

  async write(path, value, { expectedVersion }) {
    validateLedgerPath(path);
    if (expectedVersion !== null && !isOid(expectedVersion)) {
      throw new TypeError("expectedVersion must be null or a Git object ID.");
    }
    const currentVersion = await this.version();
    if (currentVersion !== expectedVersion) {
      throw new LedgerConflictError({ ref: this.ref, expected: expectedVersion, actual: currentVersion });
    }
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new TypeError("ledger value must be JSON-serializable.");

    const common = await runGit({ args: ["rev-parse", "--git-common-dir"], cwd: this.repoPath });
    const temporaryRoot = resolve(this.repoPath, common.stdout.trim(), "tabellio", "tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const nonce = randomUUID();
    const indexPath = resolve(temporaryRoot, `${nonce}.index`);
    const valuePath = resolve(temporaryRoot, `${nonce}.json`);
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await writeFile(valuePath, `${serialized}\n`, { flag: "wx" });
      await runGit({
        args: currentVersion === null ? ["read-tree", "--empty"] : ["read-tree", currentVersion],
        cwd: this.repoPath,
        env,
      });
      const blob = await runGit({ args: ["hash-object", "-w", "--", valuePath], cwd: this.repoPath });
      await runGit({
        args: ["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${path}`],
        cwd: this.repoPath,
        env,
      });
      const tree = await runGit({ args: ["write-tree"], cwd: this.repoPath, env });
      const commitArgs = ["commit-tree", tree.stdout.trim(), "-m", `tabellio ledger: ${path}`];
      if (currentVersion !== null) commitArgs.push("-p", currentVersion);
      const commit = await runGit({
        args: commitArgs,
        cwd: this.repoPath,
        env: {
          GIT_AUTHOR_NAME: "Tabellio",
          GIT_AUTHOR_EMAIL: "tabellio@example.invalid",
          GIT_COMMITTER_NAME: "Tabellio",
          GIT_COMMITTER_EMAIL: "tabellio@example.invalid",
        },
      });
      const newVersion = commit.stdout.trim();
      const expected = currentVersion ?? "0".repeat(newVersion.length);
      try {
        await runGit({ args: ["update-ref", this.ref, newVersion, expected], cwd: this.repoPath });
      } catch (error) {
        const actual = await this.version();
        throw new LedgerConflictError({ ref: this.ref, expected: currentVersion, actual });
      }
      return { path, version: newVersion, previousVersion: currentVersion };
    } finally {
      await Promise.all([
        rm(indexPath, { force: true }),
        rm(valuePath, { force: true }),
      ]);
    }
  }
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
