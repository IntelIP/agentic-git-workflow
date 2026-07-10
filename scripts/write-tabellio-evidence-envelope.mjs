import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { canonicalJson, readContextPacket } from "./lib/context-packet.mjs";

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ?? "tabellio-pr-evidence.json";
const absoluteOutPath = resolve(outPath);
const recordedOutPath = basename(absoluteOutPath);
const absoluteContextPath = args.context ? resolve(args.context) : null;
const recordedContextPath = absoluteContextPath
  ? relative(dirname(absoluteOutPath), absoluteContextPath) || basename(absoluteContextPath)
  : null;
const context = absoluteContextPath ? await readContextPacket(absoluteContextPath) : null;
const now = new Date().toISOString();
const changedFiles = context ? context.changeSet.files.map((file) => file.path).sort() : getChangedFiles();
const requiredValidationCommand = env("TABELLIO_REQUIRED_VALIDATION_COMMAND");
const requiredValidationStatus = normalizeStatus(env("TABELLIO_REQUIRED_VALIDATION_STATUS") || "skipped");
const requiredValidationExitCode = normalizeExitCode(env("TABELLIO_REQUIRED_VALIDATION_EXIT_CODE"));
const validationCommand = env("TABELLIO_VALIDATION_COMMAND");
const validationStatus = normalizeStatus(env("TABELLIO_VALIDATION_STATUS") || "skipped");
const validationExitCode = normalizeExitCode(env("TABELLIO_VALIDATION_EXIT_CODE"));
const writerCommand = env("TABELLIO_WRITER_COMMAND") || `node ${process.argv[1] || "scripts/write-tabellio-evidence-envelope.mjs"}`;
const sha = context?.refs.head.commit || env("GITHUB_SHA") || git(["rev-parse", "HEAD"]) || "unknown";
const baseRef = context?.refs.base.name || env("GITHUB_BASE_REF") || git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
const headRef = context?.refs.head.name || env("GITHUB_HEAD_REF") || git(["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
const repo = context?.repository.id || env("GITHUB_REPOSITORY") || basename(git(["rev-parse", "--show-toplevel"]) || process.cwd());
const runId = context?.runId || env("GITHUB_RUN_ID") || `local-${sha.slice(0, 12)}-${Date.now()}`;

const evidence = {
  schemaVersion: "tabellio-evidence/v0.1",
  runId,
  repo,
  git: {
    baseRef,
    headRef,
    sha,
    pullRequest: env("GITHUB_EVENT_NAME") === "pull_request" ? readPullRequestNumber() : "",
    pullRequestUrl: readPullRequestUrl(),
  },
  actor: {
    type: context?.actor.type || (env("GITHUB_ACTOR") ? "ci" : "agent"),
    id: context?.actor.id || env("GITHUB_ACTOR") || env("USER") || "local-agent",
  },
  agentRuntime: {
    name: env("TABELLIO_RUNTIME_NAME") || "unspecified",
    model: env("TABELLIO_RUNTIME_MODEL") || "",
    tooling: splitCsv(env("TABELLIO_RUNTIME_TOOLING") || "git,github-actions,node"),
  },
  taskSource: {
    type: env("TABELLIO_TASK_SOURCE_TYPE") || "manual",
    summary: context?.task.summary || env("TABELLIO_TASK_SUMMARY") || "Tabellio evidence envelope generated from repository state.",
    url: env("TABELLIO_TASK_URL") || "",
  },
  changedFiles,
  commandsRun: buildCommandsRun(),
  checks: [
    {
      name: "evidence-envelope-generated",
      status: "passed",
      summary: "Evidence envelope written from Git and CI context.",
    },
  ],
  approvals: defaultActionClasses().map((actionClass) => ({
    actionClass,
    status: "required",
  })),
  externalActionPolicy: {
    defaultMode: "deny",
    actionClasses: defaultActionClasses().map((actionClass) => ({
      id: actionClass,
      requiresExplicitApproval: true,
      approved: false,
      attempted: false,
      expectedSideEffects: ["none before explicit approval"],
      forbiddenSideEffects: forbiddenSideEffects(actionClass),
      verificationCommand: "git status --short",
    })),
  },
  artifacts: [
    {
      name: "Tabellio evidence envelope",
      path: recordedOutPath,
      hashScope: "canonical-json-without-this-artifact-sha256",
    },
    ...(context ? [{
      name: "Tabellio native Git context",
      path: recordedContextPath,
      sha256: sha256(readFileSync(absoluteContextPath)),
      hashScope: "file-bytes",
    }] : []),
  ],
  createdAt: now,
};

if (context) {
  evidence.context = {
    schemaVersion: context.schemaVersion,
    packetPath: recordedContextPath,
    digest: context.integrity.digest,
    baseCommit: context.refs.base.commit,
    headCommit: context.refs.head.commit,
    mergeBaseCommit: context.refs.mergeBase.commit,
    mergeClean: context.mergePreview.clean,
  };
}

evidence.artifacts[0].sha256 = evidenceDigest(evidence, 0);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));

function getChangedFiles() {
  const explicit = env("TABELLIO_CHANGED_FILES");
  if (explicit) return splitCsv(explicit);

  const base = env("GITHUB_BASE_REF");
  if (base) {
    const mergeBase = git(["merge-base", `origin/${base}`, "HEAD"]);
    if (mergeBase) {
      const files = git(["diff", "--name-only", `${mergeBase}...HEAD`]);
      if (files) return files.split("\n").filter(Boolean).sort();
    }
  }

  const stagedOrWorking = splitLines(git(["diff", "--name-only", "HEAD"]));
  const untracked = filterFallbackToolkitFiles(splitLines(git(["ls-files", "--others", "--exclude-standard"])));
  const localFiles = [...stagedOrWorking, ...untracked];
  if (localFiles.length > 0) return [...new Set(localFiles)].sort();

  const lastCommit = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  return splitLines(lastCommit).sort();
}

function filterFallbackToolkitFiles(files) {
  return files.filter((file) => file !== ".tabellio/toolkit" && !file.startsWith(".tabellio/toolkit/"));
}

function defaultActionClasses() {
  return [
    "deployment",
    "database-migration",
    "infrastructure-change",
    "dns-or-hosting-change",
    "billing-or-live-money",
    "credentialed-provider-read",
    "secret-value-read",
    "destructive-workspace-action",
  ];
}

function forbiddenSideEffects(actionClass) {
  const map = {
    "deployment": ["production deploy", "hosting mutation"],
    "database-migration": ["schema mutation", "data mutation"],
    "infrastructure-change": ["cloud resource mutation"],
    "dns-or-hosting-change": ["DNS mutation", "hosting config mutation"],
    "billing-or-live-money": ["billing mutation", "live financial transaction"],
    "credentialed-provider-read": ["credentialed API read"],
    "secret-value-read": ["secret value read", "secret value logging"],
    "destructive-workspace-action": ["file deletion", "history rewrite"],
  };
  return map[actionClass] ?? ["unapproved external side effect"];
}

function normalizeStatus(value) {
  if (value === "success" || value === "passed") return "passed";
  if (value === "failure" || value === "failed" || value === "cancelled" || value === "timed_out") return "failed";
  return "skipped";
}

function buildCommandsRun() {
  const commands = [];
  const seen = new Set();
  for (const [command, status, explicitExitCode] of [
    [requiredValidationCommand, requiredValidationStatus, requiredValidationExitCode],
    [validationCommand, validationStatus, validationExitCode],
  ]) {
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push({
      command,
      status,
      ...(status === "passed" ? { exitCode: 0 } : status === "failed" ? { exitCode: explicitExitCode ?? 1 } : {}),
      completedAt: now,
    });
  }
  return commands.length > 0 ? commands : [{
    command: writerCommand,
    status: "passed",
    exitCode: 0,
    completedAt: now,
  }];
}

function normalizeExitCode(value) {
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readPullRequestNumber() {
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!eventPath || !existsSync(eventPath)) return "";
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return event.pull_request?.number ? String(event.pull_request.number) : "";
  } catch {
    return "";
  }
}

function readPullRequestUrl() {
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!eventPath || !existsSync(eventPath)) return "";
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return event.pull_request?.html_url ?? "";
  } catch {
    return "";
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceDigest(value, artifactIndex) {
  const copy = structuredClone(value);
  delete copy.artifacts[artifactIndex].sha256;
  return sha256(canonicalJson(copy));
}

function splitCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitLines(value) {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function env(name) {
  return process.env[name] ?? "";
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") parsed.out = argv[++index];
    else if (argv[index] === "--context") parsed.context = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return parsed;
}
