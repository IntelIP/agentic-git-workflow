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
      if (parsed.protocol === "ssh:") {
        return normalizedSshUrl(parsed) ?? hashedRemote(remote);
      }
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

function normalizedSshUrl(parsed) {
  if (`${parsed.password}${parsed.port}${parsed.search}${parsed.hash}` !== "") return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts.every(safeRemoteSegment)) return null;
  return `${parsed.hostname}/${parts.join("/")}`.replace(/\.git$/, "");
}

function safeRemoteSegment(value) {
  return /^[A-Za-z0-9._-]+$/.test(value) && ![".", ".."].includes(value);
}

export function localRepositoryId(repoPath) {
  const name = repoPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return `local/${name ?? "repository"}`;
}

function hashedRemote(remote) {
  return `remote/${createHash("sha256").update(remote).digest("hex").slice(0, 16)}`;
}
