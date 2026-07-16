import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { createControlRefIntent, snapshotControlRefs } from "./control-ref-transport.mjs";
import { contract } from "./contract-checks.mjs";
import { runExternalCommand } from "./external-command.mjs";
import { GitJsonLedger } from "./git-json-ledger.mjs";
import { effectiveGitHubRepository, sameGitHubRepository } from "./github-repository.mjs";
import { runGit } from "./git-process.mjs";
import { runPreflight } from "./preflight.mjs";
import { validatePlatformConfig } from "./platform-config.mjs";
import { createReleaseIntent } from "./release-operation.mjs";
import { ReviewCycleManager, reviewCycleHasReleaseReadiness } from "./review-cycle.mjs";
import { ValidationRunner } from "./validation-runner.mjs";
import { GitHubProvider } from "../providers/github-provider.mjs";
import { NativeGitStore } from "../providers/native-git-store.mjs";

export async function planRelease({
  repoPath = process.cwd(),
  repositoryId: explicitRepositoryId = null,
  owner,
  repo,
  number,
  version,
  notesPath,
  title = `Tabellio v${version}`,
  controlRemote = "control",
  manifestPath = "tabellio.validation.json",
  runnerId = "tabellio-release",
  token,
  apiUrl,
  ghBinary = "gh",
  commandRunner = runExternalCommand,
  preflightRunner = runPreflight,
  githubProvider = null,
  remoteRepositoryReader = effectiveGitHubRepository,
  now = new Date(),
} = {}) {
  validatePlanInput({ owner, repo, number, version, notesPath, controlRemote, manifestPath });
  const store = await NativeGitStore.open(resolve(repoPath));
  const preflight = await preflightRunner({ repoPath: store.repoPath, profile: "release", ghBinary, commandRunner, controlRemote });
  assertReadyPreflight(preflight);
  await assertPlatformManifest(store, manifestPath);
  const repositories = await bindReleaseRepositories(store, { owner, repo, explicitRepositoryId, controlRemote, remoteRepositoryReader });
  const repositoryId = repositories.code.identity;
  const evidence = await loadReleaseEvidence({ store, notesPath, ghBinary, owner, repo, number, commandRunner });
  const { headCommit, parentCommit, notesSource, pr } = validateReleaseEvidence(evidence, { version, number });
  const pullRequestHead = await resolvePullRequestHead(store, number, pr.headRefOid);
  const validationLedger = await GitJsonLedger.open({ repoPath: store.repoPath, ref: "refs/tabellio/validations" });
  const validation = await validateMergedHead({
    store,
    validationLedger,
    repositoryId,
    headCommit,
    parentCommit,
    pullRequestHead,
    manifestPath,
    runnerId,
    now,
  });
  const provider = await resolveGitHubProvider({ githubProvider, apiUrl, token, ghBinary, commandRunner, cwd: store.repoPath });
  await assertMergedReview({
    store,
    validationLedger,
    provider,
    repositoryId,
    owner,
    repo,
    number,
    pullRequestHead,
    runnerId,
    now,
  });
  const controlIntent = await planControlPublication({ store, repositoryId, controlRemote, now });
  return createReleaseIntent({
    repository: { id: repositoryId, owner, name: repo },
    version,
    revision: { commit: headCommit, parent: parentCommit },
    pullRequest: { number, headCommit: pr.headRefOid, mergeCommit: pr.mergeCommit.oid },
    controlIntent,
    controlRepository: { id: repositories.control.identity },
    validation: {
      runId: validation.result.runId,
      resultVersion: validation.version,
      status: validation.result.status,
      headCommit: validation.result.revision.headCommit,
    },
    release: { title, notesPath, notesDigest: sha256(notesSource) },
    createdAt: now.toISOString(),
  });
}

function validatePlanInput({ owner, repo, number, version, notesPath, controlRemote, manifestPath }) {
  contract.string(owner, "owner");
  contract.string(repo, "repo");
  contract.positiveInteger(number, "number");
  contract.semver(version, "version");
  contract.safeRelativePath(notesPath, "notesPath");
  contract.safeRelativePath(manifestPath, "manifestPath");
  contract.equals(controlRemote, "control", "controlRemote");
}

async function assertPlatformManifest(store, manifestPath) {
  const source = await runGit({ args: ["show", "HEAD:tabellio.platform.json"], cwd: store.repoPath });
  const platform = validatePlatformConfig(JSON.parse(source.stdout));
  contract.equals(manifestPath, platform.validation.manifest, "manifestPath");
}

async function bindReleaseRepositories(store, { owner, repo, explicitRepositoryId, controlRemote, remoteRepositoryReader }) {
  const [origin, control] = await Promise.all([
    remoteRepositoryReader(store, "origin"),
    remoteRepositoryReader(store, controlRemote),
  ]);
  if (sameGitHubRepository(origin, control)) throw new Error("Control repository must differ from the code repository.");
  assertRequestedRepository(origin, owner, repo);
  assertExplicitRepositoryId(origin, explicitRepositoryId);
  return { code: origin, control };
}

function assertRequestedRepository(origin, owner, repo) {
  if (origin.key !== `${owner}/${repo}`.toLowerCase()) throw new Error(`Requested repository ${owner}/${repo} does not match origin ${origin.fullName}.`);
}

function assertExplicitRepositoryId(origin, explicitRepositoryId) {
  if (!explicitRepositoryId) return;
  if (explicitRepositoryId.toLowerCase() !== origin.identity.toLowerCase()) throw new Error(`repositoryId does not match origin ${origin.identity}.`);
}

function assertReadyPreflight(preflight) {
  if (preflight.status === "ready") return;
  const blockers = preflight.checks.filter((check) => check.status === "blocked").map((check) => check.id);
  throw new Error(`Release preflight blocked: ${blockers.join(", ")}.`);
}

async function loadReleaseEvidence({ store, notesPath, ghBinary, owner, repo, number, commandRunner }) {
  const [headCommit, parentCommit, packageSource, changelogSource, notesSource, prView] = await Promise.all([
    store.resolveRef("HEAD"),
    store.resolveRef("HEAD^"),
    runGit({ args: ["show", "HEAD:package.json"], cwd: store.repoPath }),
    runGit({ args: ["show", "HEAD:CHANGELOG.md"], cwd: store.repoPath }),
    runGit({ args: ["show", `HEAD:${notesPath}`], cwd: store.repoPath }),
    commandRunner({
      binary: ghBinary,
      args: ["pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "state,headRefOid,mergeCommit"],
      cwd: store.repoPath,
      timeoutMs: 30_000,
    }),
  ]);
  return { headCommit, parentCommit, packageSource: packageSource.stdout, changelogSource: changelogSource.stdout, notesSource: notesSource.stdout, prView: prView.stdout };
}

function validateReleaseEvidence({ headCommit, parentCommit, packageSource, changelogSource, notesSource, prView }, { version, number }) {
  const packageJson = JSON.parse(packageSource);
  contract.equals(packageJson.version, version, "package.json version");
  assertDatedChangelog(changelogSource, version);
  const pr = JSON.parse(prView);
  assertMergedPullRequest(pr, { number, headCommit });
  return { headCommit, parentCommit, notesSource, pr };
}

function assertDatedChangelog(source, version) {
  const found = new RegExp(`^## ${escapeRegex(version)} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(source);
  if (!found) throw new Error(`CHANGELOG.md has no dated ${version} release section.`);
}

function assertMergedPullRequest(pr, { number, headCommit }) {
  if (pr.state !== "MERGED") throw new Error(`Pull request ${number} is not merged.`);
  if (!pr.mergeCommit) throw new Error(`Pull request ${number} has no merge commit.`);
  contract.oid(pr.headRefOid, `pull request ${number} head`);
  contract.oid(pr.mergeCommit.oid, `pull request ${number} merge commit`);
  if (pr.mergeCommit.oid !== headCommit) throw new Error(`Pull request ${number} merge commit does not equal local main.`);
}

async function resolvePullRequestHead(store, number, expectedHead) {
  try {
    return await store.resolveRef(expectedHead);
  } catch {
    await runGit({
      args: ["fetch", "--no-tags", "origin", `refs/pull/${number}/head`],
      cwd: store.repoPath,
      timeoutMs: 15 * 60 * 1000,
    });
    const fetchedHead = await store.resolveRef("FETCH_HEAD");
    contract.equals(fetchedHead, expectedHead, `pull request ${number} fetched head`);
    return fetchedHead;
  }
}

async function validateMergedHead({ store, validationLedger, repositoryId, headCommit, parentCommit, pullRequestHead, manifestPath, runnerId, now }) {
  const validation = await new ValidationRunner({ store, ledger: validationLedger }).run({
    repositoryId,
    commit: headCommit,
    base: parentCommit,
    checkpointHead: pullRequestHead,
    checkpointBase: parentCommit,
    manifestPath,
    runnerId,
    now,
  });
  if (validation.result.status !== "passed") throw new Error("Exact merged-head validation failed.");
  return validation;
}

async function resolveGitHubProvider({ githubProvider, apiUrl, token, ghBinary, commandRunner, cwd }) {
  if (githubProvider) return githubProvider;
  const resolvedToken = token || await tokenFromGh({ ghBinary, commandRunner, cwd });
  return new GitHubProvider({ baseUrl: apiUrl, token: resolvedToken });
}

async function assertMergedReview({ store, validationLedger, provider, repositoryId, owner, repo, number, pullRequestHead, runnerId, now }) {
  const reviewLedger = await GitJsonLedger.open({ repoPath: store.repoPath, ref: "refs/tabellio/reviews" });
  const manager = new ReviewCycleManager({
    store,
    ledger: reviewLedger,
    validationLedger,
    provider,
    repositoryId,
    owner,
    repo,
  });
  const review = await manager.sync({ number, actor: runnerId, now });
  if (review.cycle.status !== "merged") throw new Error(`Review cycle ${number} is ${review.cycle.status}, not merged.`);
  contract.equals(review.cycle.changeRequest.headCommit, pullRequestHead, `review cycle ${number} head`);
  if (!reviewCycleHasReleaseReadiness(review.cycle, pullRequestHead)) {
    throw new Error(`Review cycle ${number} is not release-ready for the merged pull-request head.`);
  }
}

async function planControlPublication({ store, repositoryId, controlRemote, now }) {
  return createControlRefIntent({
    operation: "publish",
    repositoryId,
    remote: controlRemote,
    refs: await snapshotControlRefs({
      repoPath: store.repoPath,
      remote: controlRemote,
      refs: ["refs/tabellio/reviews", "refs/tabellio/validations", "refs/heads/entire/checkpoints/v1"],
    }),
    createdAt: now.toISOString(),
  });
}

async function tokenFromGh({ ghBinary, commandRunner, cwd }) {
  const result = await commandRunner({ binary: ghBinary, args: ["auth", "token", "--hostname", "github.com"], cwd, timeoutMs: 30_000 });
  const token = result.stdout.trim();
  if (!token) throw new Error("GitHub CLI returned an empty token.");
  return token;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
