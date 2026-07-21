export function mergedPullRequestForCommit(value, commit) {
  oid(commit, "commit");
  requireArray(value);
  const pullRequest = uniqueMergedPullRequest(value, commit);
  if (pullRequest === null) return null;
  return checkpointRevision(pullRequest, commit.length);
}

function checkpointRevision(pullRequest, oidLength) {
  const number = pullRequestNumber(pullRequest.number);
  const headCommit = pullRequestHead(pullRequest.head, oidLength);
  return {
    number,
    headCommit,
    fetchRef: `refs/pull/${number}/head`,
    localRef: `refs/remotes/origin/pull/${number}/head`,
  };
}

function oid(value, path, length = null) {
  if (typeof value !== "string") throw new Error(`${path} must be a full hexadecimal Git object ID.`);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${path} must be a full hexadecimal Git object ID.`);
  if (length !== null) requireOidLength(value, path, length);
}

function isMergedCommit(pullRequest, commit) {
  if (pullRequest === null) return false;
  if (typeof pullRequest !== "object") return false;
  if (pullRequest.merge_commit_sha !== commit) return false;
  return mergedAt(pullRequest.merged_at);
}

function requireOidLength(value, path, length) {
  if (value.length !== length) throw new Error(`${path} uses the wrong Git object format.`);
}

function requireArray(value) {
  if (!Array.isArray(value)) throw new Error("GitHub commit pull-request response must be an array.");
}

function uniqueMergedPullRequest(value, commit) {
  const matches = value.filter((pullRequest) => isMergedCommit(pullRequest, commit));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`Merged commit ${commit} is associated with multiple merged pull requests.`);
  return matches[0];
}

function pullRequestNumber(value) {
  if (!Number.isInteger(value)) throw new Error("Merged pull request number must be a positive integer.");
  if (value <= 0) throw new Error("Merged pull request number must be a positive integer.");
  return value;
}

function pullRequestHead(value, oidLength) {
  if (value === null) throw new Error("Merged pull request head must be an object.");
  if (typeof value !== "object") throw new Error("Merged pull request head must be an object.");
  oid(value.sha, "merged pull request head commit", oidLength);
  return value.sha;
}

function mergedAt(value) {
  if (typeof value !== "string") return false;
  return value.length > 0;
}
