import { createHash } from "node:crypto";

import { parseGitHubRepositoryRemote } from "./github-repository.mjs";

export async function repositoryIdentity(store, explicitId = null) {
  if (explicitId) return explicitId;
  const remote = await store.gitConfig("remote.origin.url");
  return remote ? normalizeRepositoryRemote(remote) : localRepositoryId(store.repoPath);
}

export function normalizeRepositoryRemote(remote) {
  const github = parseGitHubRepositoryRemote(remote);
  if (github) return github.identity;
  if (/^[A-Za-z]:[\\/]/.test(remote) || remote.startsWith("/") || remote.startsWith("\\\\")) {
    return hashedRemote(remote);
  }
  if (remote.includes("://")) {
    try {
      const parsed = new URL(remote);
      if (!["http:", "https:"].includes(parsed.protocol)) return hashedRemote(remote);
      return `${parsed.host}${parsed.pathname}`.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return hashedRemote(remote);
    }
  }
  const scpLike = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (!scpLike || scpLike[2].startsWith("/")) return hashedRemote(remote);
  return `${scpLike[1]}/${scpLike[2]}`.replace(/\.git$/, "");
}

export function localRepositoryId(repoPath) {
  const name = repoPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return `local/${name ?? "repository"}`;
}

function hashedRemote(remote) {
  return `remote/${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
}
