import { createHash, randomUUID } from "node:crypto";

import { runGit } from "./git-process.mjs";
import { digestObject } from "./stack-operation.mjs";
import { latestValidationResult } from "./validation-runner.mjs";

const REVIEW_CYCLE_SCHEMA_VERSION = "tabellio-review-cycle/v0.2";
const AGENT_REVIEW_SCHEMA_VERSION = "tabellio-agent-review/v0.1";
const LEGACY_REVIEW_CYCLE_SCHEMA_VERSION = "tabellio-review-cycle/v0.1";
const MAX_FEEDBACK_ITEMS = 5_000;
const MAX_AGENT_FINDINGS = 1_000;
const MAX_TEXT_BODY = 64 * 1024;

export class ReviewCycleManager {
  constructor({ store, ledger, validationLedger = null, provider, repositoryId, owner, repo }) {
    this.store = store;
    this.ledger = ledger;
    this.validationLedger = validationLedger;
    this.provider = provider;
    this.repositoryId = repositoryId;
    this.owner = owner;
    this.repo = repo;
  }

  async sync({ number, actor = "tabellio", now = new Date() }) {
    this.#requireProvider();
    positiveInteger(number, "number");
    const [changeRequest, reviews, issueComments] = await Promise.all([
      this.provider.changeRequest({ owner: this.owner, repo: this.repo, number }),
      this.provider.listReviews({ owner: this.owner, repo: this.repo, number }),
      this.provider.listIssueComments({ owner: this.owner, repo: this.repo, number }),
    ]);
    const [reviewComments, providerChecks, localValidation] = await Promise.all([
      this.provider.listReviewComments({ owner: this.owner, repo: this.repo, number, reviews }),
      this.provider.commitStatus({
        owner: this.owner,
        repo: this.repo,
        commit: changeRequest.source.commit,
      }),
      this.validationLedger
        ? latestValidationResult(this.validationLedger, changeRequest.source.commit, this.repositoryId)
        : null,
    ]);
    const checks = mergeChecks(providerChecks, localValidation);
    const record = await this.#read(number);
    const existing = record.value;
    if (existing) validateReviewCycle(existing);
    const timestamp = now.toISOString();
    const feedback = mergeProviderFeedback(existing?.feedback ?? [], [
      ...reviews.map((value) => reviewFeedback(value, timestamp)),
      ...reviewComments.map(reviewCommentFeedback),
      ...issueComments.map(issueCommentFeedback),
      ...checks.statuses.filter((status) => ["error", "failure", "failed"].includes(status.state)).map((value) => checkFeedback(value, timestamp)),
    ], timestamp);
    const fixes = await Promise.all((existing?.fixes ?? []).map((fix) => this.#reconcileFix(
      fix,
      changeRequest.target.commit,
      changeRequest.source.commit,
    )));
    const headChanged = existing && existing.changeRequest.headCommit !== changeRequest.source.commit;
    const cycle = {
      schemaVersion: REVIEW_CYCLE_SCHEMA_VERSION,
      id: existing?.id ?? cycleId(this.repositoryId, this.owner, this.repo, number),
      repository: { id: this.repositoryId },
      provider: { id: "github", owner: this.owner, repo: this.repo },
      changeRequest: {
        id: changeRequest.id,
        number: changeRequest.number,
        url: changeRequest.webUrl,
        title: changeRequest.title,
        state: changeRequest.state,
        draft: changeRequest.draft,
        mergeable: changeRequest.mergeable,
        headBranch: changeRequest.source.branch,
        headCommit: changeRequest.source.commit,
        baseBranch: changeRequest.target.branch,
        baseCommit: changeRequest.target.commit,
        updatedAt: changeRequest.updatedAt,
      },
      status: "needs_triage",
      round: existing ? existing.round + (headChanged ? 1 : 0) : 1,
      feedback,
      fixes,
      checks,
      events: appendEvent(existing?.events ?? [], event("synced", actor, timestamp, `Synced ${feedback.length} feedback items at ${changeRequest.source.commit}.`)),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    };
    return this.#save(cycle, record.version);
  }

  async triage({ number, feedbackId, disposition, reason, actor, now = new Date() }) {
    member(disposition, ["actionable", "informational", "wont-fix"], "disposition");
    requiredString(reason, "reason");
    requiredString(actor, "actor");
    const record = await this.#required(number);
    const feedback = record.value.feedback.find((item) => item.id === feedbackId);
    if (!feedback) throw new Error(`Feedback ${feedbackId} was not found.`);
    if (feedback.resolution === "fixed") throw new Error(`Feedback ${feedbackId} already has a recorded fix and cannot be retriaged.`);
    feedback.disposition = disposition;
    feedback.resolution = disposition === "actionable" ? "open" : "dismissed";
    feedback.fixId = null;
    const timestamp = now.toISOString();
    record.value.events = appendEvent(record.value.events, event("triaged", actor, timestamp, `${feedbackId}: ${disposition}. ${reason}`));
    record.value.updatedAt = timestamp;
    return this.#save(record.value, record.version);
  }

  async recordFix({ number, feedbackIds, commit, checkpointId, summary, actor, now = new Date() }) {
    if (!Array.isArray(feedbackIds) || feedbackIds.length === 0 || new Set(feedbackIds).size !== feedbackIds.length) {
      throw new Error("feedbackIds must be a non-empty unique array.");
    }
    requiredString(checkpointId, "checkpointId");
    requiredString(summary, "summary");
    requiredString(actor, "actor");
    const record = await this.#required(number);
    const resolvedCommit = await this.store.resolveRef(commit);
    if (!(await this.store.isAncestor(record.value.changeRequest.headCommit, resolvedCommit))) {
      throw new Error("Fix commit must descend from the synchronized change-request head.");
    }
    await this.#requireCheckpoint(record.value.changeRequest.headCommit, resolvedCommit, checkpointId);
    const selected = feedbackIds.map((id) => {
      const item = record.value.feedback.find((feedback) => feedback.id === id);
      if (!item) throw new Error(`Feedback ${id} was not found.`);
      if (item.disposition !== "actionable") throw new Error(`Feedback ${id} must be actionable before recording a fix.`);
      if (item.resolution === "fixed") throw new Error(`Feedback ${id} already has a recorded fix.`);
      return item;
    });
    const timestamp = now.toISOString();
    const fix = {
      id: `fix-${randomUUID()}`,
      feedbackIds: [...feedbackIds].sort(),
      originalCommit: resolvedCommit,
      commit: resolvedCommit,
      checkpointId,
      summary: summary.trim(),
      actor,
      published: false,
      createdAt: timestamp,
    };
    for (const item of selected) {
      item.resolution = "fixed";
      item.fixId = fix.id;
    }
    record.value.fixes.push(fix);
    record.value.events = appendEvent(record.value.events, event("fix-recorded", actor, timestamp, `${fix.id}: ${feedbackIds.join(", ")}.`));
    record.value.updatedAt = timestamp;
    return this.#save(record.value, record.version);
  }

  async importAgentReview({ number, input, actor, now = new Date() }) {
    validateAgentReview(input);
    requiredString(actor, "actor");
    const record = await this.#required(number);
    if (input.repository.id !== record.value.repository.id) throw new Error("Agent review repository does not match the cycle.");
    if (input.changeRequest.number !== number) throw new Error("Agent review change-request number does not match the cycle.");
    if (input.changeRequest.headCommit !== record.value.changeRequest.headCommit) {
      throw new Error("Agent review head commit is stale.");
    }
    const existingIds = new Set(record.value.feedback.map((item) => item.id));
    const timestamp = now.toISOString();
    for (const finding of input.findings) {
      const id = `agent:${input.reviewId}:${finding.id}`;
      if (existingIds.has(id)) continue;
      record.value.feedback.push({
        id,
        source: "agent",
        providerId: finding.id,
        kind: "agent-finding",
        author: input.reviewer.id,
        title: finding.title,
        body: finding.body,
        path: finding.path,
        line: finding.line,
        commit: input.changeRequest.headCommit,
        severity: finding.severity,
        providerState: "open",
        disposition: finding.actionable ? "actionable" : "informational",
        resolution: finding.actionable ? "open" : "dismissed",
        fixId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
    }
    record.value.feedback.sort((left, right) => left.id.localeCompare(right.id));
    record.value.events = appendEvent(record.value.events, event("agent-review-imported", actor, timestamp, `${input.reviewId}: ${input.findings.length} findings.`));
    record.value.updatedAt = timestamp;
    return this.#save(record.value, record.version);
  }

  async status({ number }) {
    return this.#required(number);
  }

  async migrate({
    number,
    targetNumber = number,
    remapCurrent = false,
    apply = false,
    legacyRepositoryId = null,
    legacyOwner = null,
    legacyRepo = null,
  }) {
    positiveInteger(number, "number");
    positiveInteger(targetNumber, "targetNumber");
    boolean(remapCurrent, "remapCurrent");
    boolean(apply, "apply");
    const target = {
      repositoryId: this.repositoryId,
      owner: this.owner,
      repo: this.repo,
      number: targetNumber,
    };
    const source = legacyCycleIdentity({ ...target, number }, { legacyRepositoryId, legacyOwner, legacyRepo });
    const currentSource = { ...target, number };
    const paths = {
      legacy: reviewCyclePaths(source).legacy,
      sourceCurrent: reviewCyclePaths(currentSource).current,
      current: reviewCyclePaths(target).current,
    };
    const { legacy, current, migratedSource } = await readMigrationState(this.ledger, paths);
    assertStableMigrationRead(legacy, current, migratedSource);
    if (current.value) return currentMigrationResult({ legacy, migratedSource, current, paths, identity: target });
    const selected = selectMigrationSource({ legacy, migratedSource, paths, source, currentSource, remapCurrent });
    return migrationResult({
      ledger: this.ledger,
      record: selected.record,
      sourcePath: selected.path,
      targetPath: paths.current,
      source: selected.identity,
      target,
      apply,
    });
  }

  async #read(number) {
    positiveInteger(number, "number");
    return this.ledger.read(cyclePath(this.repositoryId, this.owner, this.repo, number));
  }

  async #required(number) {
    const record = await this.#read(number);
    if (!record.value) throw new Error(`Review cycle ${number} does not exist; sync it first.`);
    validateReviewCycle(record.value);
    return record;
  }

  async #save(cycle, expectedVersion) {
    cycle.status = deriveStatus(cycle);
    cycle.integrity = { algorithm: "sha256", digest: cycleDigest(cycle) };
    validateReviewCycle(cycle);
    const path = cyclePath(this.repositoryId, this.owner, this.repo, cycle.changeRequest.number);
    const written = await this.ledger.write(path, cycle, { expectedVersion });
    return { cycle, path, version: written.version };
  }

  #requireProvider() {
    if (!this.provider) throw new Error("Review sync requires a change-request provider.");
  }

  async #requireCheckpoint(baseCommit, fixCommit, checkpointId) {
    const trailers = await runGit({
      args: [
        "log",
        "--format=%(trailers:key=Entire-Checkpoint,valueonly)",
        "--no-merges",
        `${baseCommit}..${fixCommit}`,
      ],
      cwd: this.store.repoPath,
    });
    const ids = trailers.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (ids.filter((id) => id === checkpointId).length !== 1) {
      throw new Error(`Fix range must contain exactly one Entire-Checkpoint: ${checkpointId}.`);
    }
  }

  async #reconcileFix(fix, baseCommit, remoteHead) {
    if (await this.store.isAncestor(fix.commit, remoteHead).catch(() => false)) {
      return { ...fix, published: true };
    }
    const history = await runGit({
      args: [
        "log",
        "--format=%x1e%H%x00%(trailers:key=Entire-Checkpoint,valueonly)",
        "--no-merges",
        `${baseCommit}..${remoteHead}`,
      ],
      cwd: this.store.repoPath,
    }).catch(() => null);
    if (!history) return { ...fix, published: false };
    const matches = history.stdout.split("\x1e").filter(Boolean).flatMap((record) => {
      const [commit, trailerText = ""] = record.trim().split("\0", 2);
      const checkpoints = trailerText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      return checkpoints.includes(fix.checkpointId) ? [commit] : [];
    });
    return matches.length === 1 ? { ...fix, commit: matches[0], published: true } : { ...fix, published: false };
  }
}

export function validateReviewCycle(value) {
  object(value, "review cycle");
  exactKeys(value, ["schemaVersion", "id", "repository", "provider", "changeRequest", "status", "round", "feedback", "fixes", "checks", "events", "createdAt", "updatedAt", "integrity"], "review cycle");
  equals(value.schemaVersion, REVIEW_CYCLE_SCHEMA_VERSION, "schemaVersion");
  requiredString(value.id, "id");
  object(value.repository, "repository");
  exactKeys(value.repository, ["id"], "repository");
  requiredString(value.repository.id, "repository.id");
  object(value.provider, "provider");
  exactKeys(value.provider, ["id", "owner", "repo"], "provider");
  equals(value.provider.id, "github", "provider.id");
  requiredString(value.provider.owner, "provider.owner");
  requiredString(value.provider.repo, "provider.repo");
  validateChangeRequest(value.changeRequest);
  member(value.status, ["draft", "needs_triage", "changes_requested", "update_required", "blocked", "validating", "ready", "merged", "closed"], "status");
  positiveInteger(value.round, "round");
  if (!Array.isArray(value.feedback)) throw new Error("feedback must be an array.");
  if (value.feedback.length > MAX_FEEDBACK_ITEMS) throw new Error(`feedback must contain at most ${MAX_FEEDBACK_ITEMS} entries.`);
  const feedbackIds = new Set();
  for (const [index, item] of value.feedback.entries()) {
    validateFeedback(item, `feedback[${index}]`);
    if (feedbackIds.has(item.id)) throw new Error(`feedback contains duplicate id ${item.id}.`);
    feedbackIds.add(item.id);
  }
  if (!Array.isArray(value.fixes)) throw new Error("fixes must be an array.");
  if (value.fixes.length > MAX_FEEDBACK_ITEMS) throw new Error(`fixes must contain at most ${MAX_FEEDBACK_ITEMS} entries.`);
  const fixIds = new Set();
  for (const [index, fix] of value.fixes.entries()) {
    validateFix(fix, `fixes[${index}]`);
    if (fixIds.has(fix.id)) throw new Error(`fixes contains duplicate id ${fix.id}.`);
    fixIds.add(fix.id);
    for (const feedbackId of fix.feedbackIds) if (!feedbackIds.has(feedbackId)) throw new Error(`Fix ${fix.id} references missing feedback ${feedbackId}.`);
  }
  for (const item of value.feedback) {
    if (item.fixId !== null && !fixIds.has(item.fixId)) throw new Error(`Feedback ${item.id} references missing fix ${item.fixId}.`);
  }
  validateChecks(value.checks);
  if (!Array.isArray(value.events)) throw new Error("events must be an array.");
  if (value.events.length > 100) throw new Error("events must contain at most 100 entries.");
  value.events.forEach((item, index) => validateEvent(item, `events[${index}]`));
  date(value.createdAt, "createdAt");
  date(value.updatedAt, "updatedAt");
  object(value.integrity, "integrity");
  exactKeys(value.integrity, ["algorithm", "digest"], "integrity");
  equals(value.integrity.algorithm, "sha256", "integrity.algorithm");
  if (!/^[0-9a-f]{64}$/.test(value.integrity.digest)) throw new Error("integrity.digest must be a SHA-256 digest.");
  if (cycleDigest(value) !== value.integrity.digest) throw new Error("integrity.digest does not match the review cycle.");
  if (deriveStatus(value) !== value.status) throw new Error("status does not match feedback and checks.");
  return value;
}

export function validateAgentReview(value) {
  object(value, "agent review");
  exactKeys(value, ["schemaVersion", "reviewId", "reviewer", "repository", "changeRequest", "findings", "createdAt"], "agent review");
  equals(value.schemaVersion, AGENT_REVIEW_SCHEMA_VERSION, "agent review.schemaVersion");
  requiredString(value.reviewId, "agent review.reviewId");
  object(value.reviewer, "agent review.reviewer");
  exactKeys(value.reviewer, ["id", "runtime"], "agent review.reviewer");
  requiredString(value.reviewer.id, "agent review.reviewer.id");
  requiredString(value.reviewer.runtime, "agent review.reviewer.runtime");
  object(value.repository, "agent review.repository");
  exactKeys(value.repository, ["id"], "agent review.repository");
  requiredString(value.repository.id, "agent review.repository.id");
  object(value.changeRequest, "agent review.changeRequest");
  exactKeys(value.changeRequest, ["number", "headCommit"], "agent review.changeRequest");
  positiveInteger(value.changeRequest.number, "agent review.changeRequest.number");
  oid(value.changeRequest.headCommit, "agent review.changeRequest.headCommit");
  if (!Array.isArray(value.findings)) throw new Error("agent review.findings must be an array.");
  if (value.findings.length > MAX_AGENT_FINDINGS) throw new Error(`agent review.findings must contain at most ${MAX_AGENT_FINDINGS} entries.`);
  const ids = new Set();
  for (const [index, finding] of value.findings.entries()) {
    const path = `agent review.findings[${index}]`;
    object(finding, path);
    exactKeys(finding, ["id", "title", "body", "severity", "actionable", "path", "line"], path);
    requiredString(finding.id, `${path}.id`);
    if (ids.has(finding.id)) throw new Error(`agent review.findings contains duplicate id ${finding.id}.`);
    ids.add(finding.id);
    requiredString(finding.title, `${path}.title`);
    maxLength(finding.title, 500, `${path}.title`);
    if (typeof finding.body !== "string") throw new Error(`${path}.body must be a string.`);
    maxLength(finding.body, MAX_TEXT_BODY, `${path}.body`);
    member(finding.severity, ["critical", "high", "medium", "low", "info"], `${path}.severity`);
    boolean(finding.actionable, `${path}.actionable`);
    if (finding.path !== null) requiredString(finding.path, `${path}.path`);
    if (finding.line !== null && (!Number.isInteger(finding.line) || finding.line <= 0)) throw new Error(`${path}.line must be a positive integer or null.`);
  }
  date(value.createdAt, "agent review.createdAt");
  return value;
}

export function migrateReviewCycleV1ToV2(value, { source, target }) {
  if (value?.schemaVersion === REVIEW_CYCLE_SCHEMA_VERSION) {
    validateReviewCycle(value);
    if (matchesCycleIdentity(value, target)) {
      return { cycle: structuredClone(value), changed: false, clearedProviderUrls: 0 };
    }
    assertCycleIdentity(value, source);
  } else {
    validateLegacyReviewCycle(value, source);
  }
  const cycle = structuredClone(value);
  const clearedProviderUrls = cycle.checks.statuses.filter((status) => status.targetUrl !== null).length;
  cycle.schemaVersion = REVIEW_CYCLE_SCHEMA_VERSION;
  cycle.repository.id = target.repositoryId;
  cycle.provider = { id: "github", owner: target.owner, repo: target.repo };
  cycle.changeRequest.id = pendingGitHubSyncId(value);
  cycle.changeRequest.number = target.number;
  cycle.changeRequest.url = githubPullRequestUrl(target.owner, target.repo, target.number);
  cycle.feedback = cycle.feedback.map((item) => ({
    ...item,
    source: item.source === "forgejo" ? "github" : item.source,
  }));
  cycle.checks.statuses = cycle.checks.statuses.map((status) => ({ ...status, targetUrl: null }));
  cycle.integrity = { algorithm: "sha256", digest: cycleDigest(cycle) };
  validateReviewCycle(cycle);
  assertCycleIdentity(cycle, target);
  return { cycle, changed: true, clearedProviderUrls };
}

export function reviewCyclePaths({ repositoryId, owner, repo, number }) {
  requiredString(repositoryId, "repositoryId");
  requiredString(owner, "owner");
  requiredString(repo, "repo");
  positiveInteger(number, "number");
  const suffix = `${number}-${createHash("sha256").update(`${repositoryId}\0${owner}\0${repo}`).digest("hex").slice(0, 16)}.json`;
  return {
    legacy: `cycles/forgejo-${suffix}`,
    current: `cycles/github-${suffix}`,
  };
}

function mergeProviderFeedback(existing, incoming, timestamp) {
  const prior = new Map(existing.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const merged = incoming.map((item) => {
    const before = prior.get(item.id);
    return before ? {
      ...item,
      disposition: before.disposition,
      resolution: before.resolution,
      fixId: before.fixId,
    } : item;
  });
  for (const item of existing) {
    if (item.source === "agent") merged.push(item);
    else if (!incomingIds.has(item.id)) merged.push({ ...item, providerState: "stale", updatedAt: timestamp });
  }
  return merged.sort((left, right) => left.id.localeCompare(right.id));
}

function reviewFeedback(value, timestamp) {
  const requestedChanges = ["request_changes", "changes_requested"].includes(value.state);
  const approved = value.state === "approved";
  return feedback({
    id: `review:${value.id}`,
    providerId: value.id,
    kind: "review",
    author: value.author,
    title: `Review ${value.state}`,
    body: value.body,
    commit: value.commit,
    providerState: value.stale ? "stale" : "open",
    disposition: requestedChanges ? "actionable" : approved ? "informational" : "pending",
    resolution: requestedChanges ? "open" : approved ? "dismissed" : "open",
    createdAt: value.submittedAt ?? value.updatedAt ?? timestamp,
    updatedAt: value.updatedAt ?? value.submittedAt ?? timestamp,
  });
}

function reviewCommentFeedback(value) {
  return feedback({
    id: `review-comment:${value.id}`,
    providerId: value.id,
    kind: "review-comment",
    author: value.author,
    title: value.path ? `Inline comment on ${value.path}` : "Inline review comment",
    body: value.body,
    path: value.path,
    line: value.line,
    commit: value.commit,
    providerState: value.resolvedBy ? "resolved" : "open",
    disposition: value.resolvedBy ? "informational" : "pending",
    resolution: value.resolvedBy ? "dismissed" : "open",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function issueCommentFeedback(value) {
  return feedback({
    id: `issue-comment:${value.id}`,
    providerId: value.id,
    kind: "issue-comment",
    author: value.author,
    title: "Change-request comment",
    body: value.body,
    providerState: "open",
    disposition: "pending",
    resolution: "open",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

function checkFeedback(value, timestamp) {
  return feedback({
    id: `check:${value.id}`,
    providerId: value.id,
    kind: "check",
    author: null,
    title: `Failed check: ${value.context}`,
    body: value.description ?? "Check failed.",
    providerState: "open",
    disposition: "actionable",
    resolution: "open",
    createdAt: value.createdAt ?? timestamp,
    updatedAt: value.updatedAt ?? value.createdAt ?? timestamp,
  });
}

function feedback({
  id,
  providerId,
  kind,
  author,
  title,
  body,
  path = null,
  line = null,
  commit = null,
  severity = null,
  providerState,
  disposition,
  resolution,
  createdAt,
  updatedAt,
}) {
  return {
    id,
    source: "github",
    providerId,
    kind,
    author,
    title,
    body,
    path,
    line,
    commit,
    severity,
    providerState,
    disposition,
    resolution,
    fixId: null,
    createdAt,
    updatedAt,
  };
}

function deriveStatus(cycle) {
  if (cycle.changeRequest.state === "merged") return "merged";
  if (cycle.changeRequest.state === "closed") return "closed";
  if (cycle.changeRequest.draft) return "draft";
  if (cycle.changeRequest.mergeable === false) return "blocked";
  if (["error", "failure", "failed"].includes(cycle.checks.state)) return "blocked";
  const live = cycle.feedback.filter((item) => item.providerState !== "stale");
  if (live.some((item) => item.disposition === "pending")) return "needs_triage";
  if (live.some((item) => item.disposition === "actionable" && item.resolution === "open")) return "changes_requested";
  if (cycle.fixes.some((fix) => fix.published !== true)) return "update_required";
  if (["none", "pending", "running"].includes(cycle.checks.state)) return "validating";
  return "ready";
}

function cycleDigest(value) {
  const { integrity: _integrity, ...unsigned } = value;
  return digestObject(unsigned);
}

function mergeChecks(providerChecks, localValidation) {
  if (!localValidation) return providerChecks;
  const localStatus = {
    id: `validation:${localValidation.runId}`,
    context: `tabellio/${localValidation.suite.id}`,
    state: localValidation.status === "passed" ? "success" : "failure",
    description: `Tabellio validation ${localValidation.status}.`,
    targetUrl: null,
    createdAt: localValidation.startedAt,
    updatedAt: localValidation.completedAt,
  };
  const statuses = [...providerChecks.statuses, localStatus];
  let state = providerChecks.state;
  if (localStatus.state === "failure" || ["error", "failure", "failed"].includes(providerChecks.state)) state = "failure";
  else if (["pending", "running"].includes(providerChecks.state)) state = providerChecks.state;
  else state = "success";
  return { commit: providerChecks.commit, state, total: statuses.length, statuses };
}

function cycleId(repositoryId, owner, repo, number) {
  return `review-${createHash("sha256").update(`${repositoryId}\0${owner}\0${repo}\0${number}`).digest("hex").slice(0, 24)}`;
}

function cyclePath(repositoryId, owner, repo, number) {
  return reviewCyclePaths({ repositoryId, owner, repo, number }).current;
}

function validateLegacyReviewCycle(value, identity) {
  object(value, "legacy review cycle");
  exactKeys(value, ["schemaVersion", "id", "repository", "provider", "changeRequest", "status", "round", "feedback", "fixes", "checks", "events", "createdAt", "updatedAt", "integrity"], "legacy review cycle");
  equals(value.schemaVersion, LEGACY_REVIEW_CYCLE_SCHEMA_VERSION, "legacy review cycle.schemaVersion");
  object(value.provider, "legacy review cycle.provider");
  exactKeys(value.provider, ["id", "owner", "repo"], "legacy review cycle.provider");
  equals(value.provider.id, "forgejo", "legacy review cycle.provider.id");
  if (!Array.isArray(value.feedback)) throw new Error("legacy review cycle.feedback must be an array.");
  value.feedback.forEach((item, index) => member(item?.source, ["forgejo", "agent"], `legacy review cycle.feedback[${index}].source`));
  object(value.integrity, "legacy review cycle.integrity");
  exactKeys(value.integrity, ["algorithm", "digest"], "legacy review cycle.integrity");
  equals(value.integrity.algorithm, "sha256", "legacy review cycle.integrity.algorithm");
  if (!/^[0-9a-f]{64}$/.test(value.integrity.digest)) throw new Error("legacy review cycle.integrity.digest must be a SHA-256 digest.");
  if (cycleDigest(value) !== value.integrity.digest) throw new Error("legacy review cycle integrity digest does not match.");
  validateChangeRequest(value.changeRequest);
  validateChecks(value.checks);
  assertCycleIdentity(value, identity);
}

function assertCycleIdentity(cycle, { repositoryId, owner, repo, number }) {
  equals(cycle.repository.id, repositoryId, "review cycle.repository.id");
  equals(cycle.provider.owner, owner, "review cycle.provider.owner");
  equals(cycle.provider.repo, repo, "review cycle.provider.repo");
  equals(cycle.changeRequest.number, number, "review cycle.changeRequest.number");
}

function matchesCycleIdentity(cycle, identity) {
  try {
    assertCycleIdentity(cycle, identity);
    return true;
  } catch {
    return false;
  }
}

function assertStableMigrationRead(...records) {
  if (new Set(records.map((record) => record.version)).size !== 1) {
    throw new Error("Review ledger changed while migration state was being read; retry.");
  }
}

async function readMigrationState(ledger, paths) {
  const [legacy, current, source] = await Promise.all([
    ledger.read(paths.legacy),
    ledger.read(paths.current),
    readMigratedSource(ledger, paths),
  ]);
  return {
    legacy,
    current,
    migratedSource: source ?? { value: null, version: current.version },
  };
}

function readMigratedSource(ledger, paths) {
  if (paths.sourceCurrent === paths.current) return null;
  return ledger.read(paths.sourceCurrent);
}

function selectMigrationSource({ legacy, migratedSource, paths, source, currentSource, remapCurrent }) {
  assertUnambiguousMigrationSources(legacy, migratedSource, paths);
  if (migratedSource.value) {
    requireCurrentRemap(remapCurrent, paths.sourceCurrent);
    return { record: migratedSource, path: paths.sourceCurrent, identity: currentSource };
  }
  if (!legacy.value) throw new Error(`Legacy review cycle ${source.number} does not exist at ${paths.legacy}.`);
  return { record: legacy, path: paths.legacy, identity: source };
}

function requireCurrentRemap(remapCurrent, path) {
  if (remapCurrent) return;
  throw new Error(`Current v0.2 cycle ${path} requires --remap-current true before it can move.`);
}

function assertUnambiguousMigrationSources(legacy, migratedSource, paths) {
  if (!legacy.value || !migratedSource.value) return;
  throw new Error(`Both ${paths.legacy} and ${paths.sourceCurrent} exist; refusing ambiguous migration.`);
}

function currentMigrationResult({ legacy, migratedSource, current, paths, identity }) {
  validateReviewCycle(current.value);
  assertCycleIdentity(current.value, identity);
  if (legacy.value || migratedSource.value) {
    throw new Error(`A source cycle and ${paths.current} both exist; refusing ambiguous migration.`);
  }
  return {
    state: "current",
    changed: false,
    applied: false,
    sourcePath: null,
    path: paths.current,
    version: current.version,
    requiresSync: current.value.changeRequest.id.startsWith("pending-github-sync:"),
    clearedProviderUrls: 0,
    cycle: current.value,
  };
}

async function migrationResult({ ledger, record, sourcePath, targetPath, source, target, apply }) {
  const migrated = migrateReviewCycleV1ToV2(record.value, { source, target });
  const paths = { legacy: sourcePath, current: targetPath };
  if (!apply) return previewMigrationResult(record, paths, migrated);
  const written = await ledger.write(targetPath, migrated.cycle, {
    expectedVersion: record.version,
    replacePath: sourcePath,
  });
  return appliedMigrationResult(written, paths, migrated);
}

function legacyCycleIdentity(target, { legacyRepositoryId, legacyOwner, legacyRepo }) {
  return {
    repositoryId: legacyRepositoryId ?? target.repositoryId,
    owner: legacyOwner ?? target.owner,
    repo: legacyRepo ?? target.repo,
    number: target.number,
  };
}

function previewMigrationResult(legacy, paths, migrated) {
  return {
    state: "preview",
    changed: true,
    applied: false,
    sourcePath: paths.legacy,
    path: paths.current,
    version: legacy.version,
    requiresSync: true,
    clearedProviderUrls: migrated.clearedProviderUrls,
    cycle: migrated.cycle,
  };
}

function appliedMigrationResult(written, paths, migrated) {
  return {
    state: "migrated",
    changed: true,
    applied: true,
    sourcePath: paths.legacy,
    path: paths.current,
    version: written.version,
    previousVersion: written.previousVersion,
    requiresSync: true,
    clearedProviderUrls: migrated.clearedProviderUrls,
    cycle: migrated.cycle,
  };
}

function githubPullRequestUrl(owner, repo, number) {
  requiredString(owner, "owner");
  requiredString(repo, "repo");
  positiveInteger(number, "number");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${number}`;
}

function pendingGitHubSyncId(value) {
  if (value.changeRequest.id.startsWith("pending-github-sync:")) return value.changeRequest.id;
  return `pending-github-sync:${value.provider.id}:${value.changeRequest.id}`;
}

function event(type, actor, at, detail) {
  return { id: `event-${randomUUID()}`, type, actor, at, detail };
}

function appendEvent(events, next) {
  return [...events, next].slice(-100);
}

function validateChangeRequest(value) {
  object(value, "changeRequest");
  exactKeys(value, ["id", "number", "url", "title", "state", "draft", "mergeable", "headBranch", "headCommit", "baseBranch", "baseCommit", "updatedAt"], "changeRequest");
  requiredString(value.id, "changeRequest.id");
  positiveInteger(value.number, "changeRequest.number");
  httpUrl(value.url, "changeRequest.url");
  requiredString(value.title, "changeRequest.title");
  maxLength(value.title, 500, "changeRequest.title");
  member(value.state, ["open", "closed", "merged"], "changeRequest.state");
  boolean(value.draft, "changeRequest.draft");
  if (value.mergeable !== null) boolean(value.mergeable, "changeRequest.mergeable");
  requiredString(value.headBranch, "changeRequest.headBranch");
  oid(value.headCommit, "changeRequest.headCommit");
  requiredString(value.baseBranch, "changeRequest.baseBranch");
  oid(value.baseCommit, "changeRequest.baseCommit");
  date(value.updatedAt, "changeRequest.updatedAt");
}

function validateFeedback(value, path) {
  object(value, path);
  exactKeys(value, ["id", "source", "providerId", "kind", "author", "title", "body", "path", "line", "commit", "severity", "providerState", "disposition", "resolution", "fixId", "createdAt", "updatedAt"], path);
  requiredString(value.id, `${path}.id`);
  member(value.source, ["github", "agent"], `${path}.source`);
  requiredString(value.providerId, `${path}.providerId`);
  member(value.kind, ["review", "review-comment", "issue-comment", "check", "agent-finding"], `${path}.kind`);
  if (value.author !== null) requiredString(value.author, `${path}.author`);
  requiredString(value.title, `${path}.title`);
  maxLength(value.title, 500, `${path}.title`);
  if (typeof value.body !== "string") throw new Error(`${path}.body must be a string.`);
  maxLength(value.body, MAX_TEXT_BODY, `${path}.body`);
  if (value.path !== null) requiredString(value.path, `${path}.path`);
  if (value.line !== null && (!Number.isInteger(value.line) || value.line <= 0)) throw new Error(`${path}.line must be a positive integer or null.`);
  if (value.commit !== null) oid(value.commit, `${path}.commit`);
  if (value.severity !== null) member(value.severity, ["critical", "high", "medium", "low", "info"], `${path}.severity`);
  member(value.providerState, ["open", "resolved", "stale"], `${path}.providerState`);
  member(value.disposition, ["pending", "actionable", "informational", "wont-fix"], `${path}.disposition`);
  member(value.resolution, ["open", "fixed", "dismissed"], `${path}.resolution`);
  if (value.fixId !== null) requiredString(value.fixId, `${path}.fixId`);
  date(value.createdAt, `${path}.createdAt`);
  date(value.updatedAt, `${path}.updatedAt`);
}

function validateFix(value, path) {
  object(value, path);
  exactKeys(value, ["id", "feedbackIds", "originalCommit", "commit", "checkpointId", "summary", "actor", "published", "createdAt"], path);
  requiredString(value.id, `${path}.id`);
  if (!Array.isArray(value.feedbackIds) || value.feedbackIds.length === 0 || new Set(value.feedbackIds).size !== value.feedbackIds.length) throw new Error(`${path}.feedbackIds must be non-empty and unique.`);
  value.feedbackIds.forEach((id, index) => requiredString(id, `${path}.feedbackIds[${index}]`));
  oid(value.originalCommit, `${path}.originalCommit`);
  oid(value.commit, `${path}.commit`);
  requiredString(value.checkpointId, `${path}.checkpointId`);
  requiredString(value.summary, `${path}.summary`);
  maxLength(value.summary, 2_000, `${path}.summary`);
  requiredString(value.actor, `${path}.actor`);
  boolean(value.published, `${path}.published`);
  date(value.createdAt, `${path}.createdAt`);
}

function validateChecks(value) {
  object(value, "checks");
  exactKeys(value, ["commit", "state", "total", "statuses"], "checks");
  oid(value.commit, "checks.commit");
  requiredString(value.state, "checks.state");
  if (!Number.isInteger(value.total) || value.total < 0) throw new Error("checks.total must be a non-negative integer.");
  if (!Array.isArray(value.statuses)) throw new Error("checks.statuses must be an array.");
  if (value.statuses.length > 1_000) throw new Error("checks.statuses must contain at most 1000 entries.");
  for (const [index, status] of value.statuses.entries()) {
    const path = `checks.statuses[${index}]`;
    object(status, path);
    exactKeys(status, ["id", "context", "state", "description", "targetUrl", "createdAt", "updatedAt"], path);
    requiredString(status.id, `${path}.id`);
    requiredString(status.context, `${path}.context`);
    requiredString(status.state, `${path}.state`);
    if (status.description !== null) requiredString(status.description, `${path}.description`);
    if (status.targetUrl !== null) httpUrl(status.targetUrl, `${path}.targetUrl`);
    if (status.createdAt !== null) date(status.createdAt, `${path}.createdAt`);
    if (status.updatedAt !== null) date(status.updatedAt, `${path}.updatedAt`);
  }
}

function validateEvent(value, path) {
  object(value, path);
  exactKeys(value, ["id", "type", "actor", "at", "detail"], path);
  requiredString(value.id, `${path}.id`);
  member(value.type, ["synced", "triaged", "fix-recorded", "agent-review-imported"], `${path}.type`);
  requiredString(value.actor, `${path}.actor`);
  date(value.at, `${path}.at`);
  requiredString(value.detail, `${path}.detail`);
  maxLength(value.detail, 2_000, `${path}.detail`);
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function maxLength(value, maximum, path) {
  if (typeof value === "string" && value.length > maximum) throw new Error(`${path} must contain at most ${maximum} characters.`);
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer.`);
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
}

function member(value, values, path) {
  if (!values.includes(value)) throw new Error(`${path} must be one of: ${values.join(", ")}.`);
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
}

function oid(value, path) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${path} must be a Git object ID.`);
}

function date(value, path) {
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${path} must be an ISO date-time.`);
}

function httpUrl(value, path) {
  requiredString(value, path);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${path} must be an HTTP URL.`);
}
