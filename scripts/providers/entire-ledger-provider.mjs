import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { canonicalJson } from "../lib/context-packet.mjs";
import { ExternalCommandError, runExternalCommand } from "../lib/external-command.mjs";
import { runGit } from "../lib/git-process.mjs";
import { LEDGER_SCHEMA_VERSION, LedgerProvider, validateLedgerSnapshot } from "../lib/ledger-provider.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const CHECKPOINT_REF = "entire/checkpoints/v1";

export class EntireLedgerProvider extends LedgerProvider {
  constructor({ repoPath, binary = "entire", timeoutMs = DEFAULT_TIMEOUT_MS }) {
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
    return new EntireLedgerProvider({ ...options, repoPath: await realpath(result.stdout.trim()) });
  }

  async toolVersion() {
    const result = await this.#run(["version"]);
    const match = result.stdout.match(/^Entire CLI\s+v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/m);
    if (!match) throw new Error("Entire CLI returned an unsupported version format.");
    requireMinimumVersion(match[1], [0, 7, 7]);
    return match[1];
  }

  async snapshot({ repositoryId, baseRevision, headRevision, capturedAt = new Date().toISOString() }) {
    requiredString(repositoryId, "repositoryId");
    const [version, baseCommit, headCommit] = await Promise.all([
      this.toolVersion(),
      this.#resolveCommit(baseRevision),
      this.#resolveCommit(headRevision),
    ]);
    const commits = await this.#commitsBetween(baseCommit, headCommit);
    const checkpointCommits = new Map();
    for (const commit of commits) {
      const message = await this.#git(["show", "-s", "--format=%B", commit, "--"]);
      for (const id of checkpointIdsFromMessage(message.stdout)) {
        const existing = checkpointCommits.get(id) ?? [];
        existing.push(commit);
        checkpointCommits.set(id, existing);
      }
    }

    const checkpoints = [];
    for (const [id, linkedCommits] of checkpointCommits) {
      const envelope = await this.checkpoint(id);
      checkpoints.push(normalizeCheckpoint(envelope, linkedCommits));
    }
    checkpoints.sort((left, right) => left.id.localeCompare(right.id));

    return validateLedgerSnapshot({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      repository: { id: repositoryId },
      provider: { id: "entire", version },
      capturedAt,
      range: { baseCommit, headCommit },
      checkpoints,
    });
  }

  async checkpoint(checkpointId) {
    validateCheckpointId(checkpointId);
    const result = await this.#run([
      "checkpoint", "explain", "--json", "--checkpoint", checkpointId, "--no-pager",
    ]);
    let envelope;
    try {
      envelope = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Entire checkpoint ${checkpointId} returned invalid JSON: ${error.message}`);
    }
    if (!isObject(envelope)) throw new Error(`Entire checkpoint ${checkpointId} must return a JSON object.`);
    if (envelope.checkpoint_id !== checkpointId) {
      throw new Error(`Entire checkpoint response id mismatch: expected ${checkpointId}, found ${envelope.checkpoint_id ?? "missing"}.`);
    }
    if (envelope.partial === true) throw new Error(`Entire checkpoint ${checkpointId} metadata is partial.`);
    return envelope;
  }

  contextReferences(snapshot) {
    return checkpointReferences(snapshot);
  }

  async #resolveCommit(revision) {
    requiredString(revision, "revision");
    const result = await this.#git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
    return result.stdout.trim();
  }

  async #commitsBetween(baseCommit, headCommit) {
    const result = await this.#git(["rev-list", "--reverse", `${baseCommit}..${headCommit}`, "--"]);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  #git(args) {
    return runGit({ args, cwd: this.repoPath });
  }

  #run(args) {
    return runEntire({
      binary: this.binary,
      args,
      cwd: this.repoPath,
      timeoutMs: this.timeoutMs,
    });
  }
}

class EntireCommandError extends ExternalCommandError {
  constructor(result) {
    super(result);
    this.name = "EntireCommandError";
  }
}

function runEntire({
  binary = "entire",
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
    ErrorType: EntireCommandError,
    argumentLabel: "Entire",
  });
}

function checkpointReferences(snapshot) {
  validateLedgerSnapshot(snapshot);
  return snapshot.checkpoints.flatMap((checkpoint) => checkpoint.commits.map((commit) => ({
    provider: "entire",
    id: checkpoint.id,
    ref: CHECKPOINT_REF,
    commit,
    digest: checkpoint.digest,
    ...(checkpoint.summary ? { summary: checkpoint.summary } : {}),
  })));
}

function normalizeCheckpoint(envelope, commits) {
  requiredString(envelope.checkpoint_id, "Entire checkpoint_id");
  if (!Array.isArray(envelope.sessions)) throw new Error(`Entire checkpoint ${envelope.checkpoint_id} sessions must be an array.`);
  const sessions = envelope.sessions.map((session, index) => normalizeSession(session, index));
  const summary = [...sessions].reverse()
    .map((session) => session.summary?.outcome ?? session.summary?.intent ?? null)
    .find((value) => typeof value === "string" && value.trim() !== "") ?? null;
  const normalized = {
    id: envelope.checkpoint_id,
    commits: [...new Set(commits)],
    branch: optionalString(envelope.branch),
    filesTouched: normalizedStrings(envelope.files_touched),
    hasReview: envelope.has_review === true,
    hasInvestigation: envelope.has_investigation === true,
    sessionCount: envelope.session_count,
    sessions,
    partial: envelope.partial === true,
    digest: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
    summary: summary ? summary.trim().slice(0, 500) : null,
  };
  return normalized;
}

function normalizeSession(session, fallbackIndex) {
  if (!isObject(session)) throw new Error("Entire session metadata must be an object.");
  return {
    index: Number.isInteger(session.index) ? session.index : fallbackIndex,
    id: optionalString(session.session_id),
    agent: optionalString(session.agent),
    model: optionalString(session.model),
    kind: optionalString(session.kind),
    createdAt: optionalString(session.created_at),
    filesTouched: normalizedStrings(session.files_touched),
    tokenUsage: session.token_usage == null ? null : {
      input: session.token_usage.input_tokens ?? 0,
      output: session.token_usage.output_tokens ?? 0,
      cacheRead: session.token_usage.cache_read_tokens ?? 0,
      cacheCreation: session.token_usage.cache_creation_tokens ?? 0,
    },
    summary: session.summary == null ? null : {
      intent: optionalString(session.summary.intent),
      outcome: optionalString(session.summary.outcome),
    },
    error: optionalString(session.error),
  };
}

function checkpointIdsFromMessage(message) {
  return [...message.matchAll(/^Entire-Checkpoint:\s*([0-9a-f]{12})\s*$/gim)].map((match) => match[1].toLowerCase());
}

function normalizedStrings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Entire metadata string collection must be an array.");
  return [...new Set(value.map((item) => {
    requiredString(item, "Entire metadata array item");
    return item;
  }))].sort();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function validateCheckpointId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{12}$/.test(value)) {
    throw new Error("checkpointId must be a 12-character hexadecimal Entire checkpoint ID.");
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMinimumVersion(value, minimum) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`Entire version has unsupported format: ${value}.`);
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`Entire ${minimum.join(".")} or later is required; found ${value}.`);
    }
  }
}
