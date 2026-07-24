import { runGit } from "./git-process.mjs";

const GITHUB_HOST = "github.com";
const SLUG = /^[A-Za-z0-9_.-]+$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export function parseGitHubRepositoryRemote(value) {
  if (typeof value !== "string") return null;
  const parts = repositoryRemoteParts(value);
  if (!parts) return null;
  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/i, "");
  if (![owner, name].every(validRepositorySlug)) return null;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    identity: `${GITHUB_HOST}/${owner}/${name}`,
    key: `${owner}/${name}`.toLowerCase(),
  };
}

function validRepositorySlug(value) {
  return SLUG.test(value) && value !== "." && value !== "..";
}

export function sameGitHubRepository(left, right) {
  return left !== null && right !== null && left.key === right.key;
}

export async function effectiveGitHubRepository(store, remote) {
  assertSafeRemoteName(remote);
  const [fetchUrls, pushUrls] = await Promise.all([
    effectiveRemoteUrls(store.repoPath, remote, false),
    effectiveRemoteUrls(store.repoPath, remote, true),
  ]);
  const repositories = [...fetchUrls, ...pushUrls].map(parseGitHubRepositoryRemote);
  if (repositories.some((repository) => repository === null)) {
    throw new Error(`Remote ${remote} has a non-GitHub effective fetch or push URL.`);
  }
  const repository = repositories[0];
  if (!repositories.every((candidate) => sameGitHubRepository(repository, candidate))) {
    throw new Error(`Remote ${remote} effective fetch and push URLs target different GitHub repositories.`);
  }
  return { ...repository, fetchUrls, pushUrls };
}

export async function readRemoteRefOid({ repoPath, remote, ref, allowMissing = false }) {
  assertSafeRemoteName(remote);
  assertSafeGitRef(ref);
  const result = await runGit({
    args: ["ls-remote", "--refs", remote, ref],
    cwd: repoPath,
    timeoutMs: 15 * 60 * 1000,
  });
  return parseRemoteRefOutput(result.stdout, remote, ref, allowMissing);
}

async function effectiveRemoteUrls(repoPath, remote, push) {
  const result = await runGit({
    args: ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
    cwd: repoPath,
  });
  const urls = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error(`Remote ${remote} has no effective ${push ? "push" : "fetch"} URL.`);
  return urls;
}

function repositoryRemoteParts(value) {
  const https = httpsParts(value);
  return https || sshUrlParts(value) || sshParts(value);
}

function httpsParts(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;
  if (parsed.origin.toLowerCase() !== `https://${GITHUB_HOST}`) return null;
  if (`${parsed.username}${parsed.password}${parsed.search}${parsed.hash}` !== "") return null;
  return repositoryPathParts(parsed.pathname);
}

function sshParts(value) {
  const match = value.match(/^git@github\.com:([^\s]+)$/i);
  return match ? repositoryPathParts(match[1]) : null;
}

function sshUrlParts(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;
  const valid = [
    parsed.protocol === "ssh:",
    parsed.hostname.toLowerCase() === GITHUB_HOST,
    parsed.username === "git",
    `${parsed.password}${parsed.port}${parsed.search}${parsed.hash}` === "",
  ].every(Boolean);
  return valid ? repositoryPathParts(parsed.pathname) : null;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function repositoryPathParts(value) {
  const parts = value.replace(/^\/+|\/+$/g, "").split("/");
  return parts.length === 2 ? parts : null;
}

function assertSafeRemoteName(remote) {
  if (!REMOTE_NAME.test(remote)) throw new Error("remote must be a safe Git remote name.");
}

function assertSafeGitRef(ref) {
  if (!GIT_REF.test(ref)) throw new Error("ref must be a safe fully qualified Git ref.");
  if (ref.includes("..")) throw new Error("ref must be a safe fully qualified Git ref.");
}

function parseRemoteRefOutput(source, remote, ref, allowMissing) {
  const rows = remoteOutputRows(source);
  if (rows.length === 0) return missingRemoteRefValue(allowMissing, remote, ref);
  if (rows.length !== 1) throw new Error(`Remote ${remote} returned ${rows.length} values for ${ref}.`);
  return parseExpectedRemoteRefRow(rows[0], remote, ref);
}

function parseExpectedRemoteRefRow(row, remote, ref) {
  const [oid, actualRef] = row.split(/\s+/);
  if (actualRef !== ref) throw new Error(`Remote ${remote} returned an invalid value for ${ref}.`);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`Remote ${remote} returned an invalid value for ${ref}.`);
  return oid;
}

function missingRemoteRefValue(allowMissing, remote, ref) {
  if (allowMissing) return null;
  throw new Error(`Remote ${remote} returned 0 values for ${ref}.`);
}

function remoteOutputRows(source) {
  const trimmed = source.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\r?\n/);
}
