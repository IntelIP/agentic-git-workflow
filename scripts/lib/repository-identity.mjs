import { createHash } from "node:crypto";

export async function repositoryIdentity(store, explicitId = null) {
  if (explicitId) return explicitId;
  const remote = await store.gitConfig("remote.origin.url");
  return remote ? normalizeRepositoryRemote(remote) : localRepositoryId(store.repoPath);
}

export function normalizeRepositoryRemote(remote) {
  if (/^[A-Za-z]:[\\/]/.test(remote) || remote.startsWith("/") || remote.startsWith("\\\\")) {
    return hashedRemote(remote);
  }
  if (remote.includes("://")) {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol === "file:") return hashedRemote(remote);
      return `${parsed.host}${parsed.pathname}`.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return hashedRemote(remote);
    }
  }
  const scpLike = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  return scpLike ? `${scpLike[1]}/${scpLike[2]}`.replace(/\.git$/, "") : hashedRemote(remote);
}

export function localRepositoryId(repoPath) {
  const name = repoPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return `local/${name ?? "repository"}`;
}

function hashedRemote(remote) {
  return `remote/${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
}
