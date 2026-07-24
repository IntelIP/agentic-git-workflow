import { createHash } from "node:crypto";

import { parseGitHubRepositoryRemote } from "./github-repository.mjs";

const PRIVATE_REMOTE_ROOTS = new Set([
  "etc",
  "home",
  "opt",
  "private",
  "srv",
  "tmp",
  "user",
  "users",
  "var",
  "volumes",
]);

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
  return normalizedScpRemote(scpLike) ?? hashedRemote(remote);
}

function normalizedSshUrl(parsed) {
  if (`${parsed.password}${parsed.port}${parsed.search}${parsed.hash}` !== "") return null;
  const parts = normalizedRemoteParts(parsed.pathname);
  if (!parts) return null;
  return `${parsed.hostname}/${parts.join("/")}`.replace(/\.git$/, "");
}

function normalizedScpRemote(match) {
  if (!match || match[2].startsWith("/")) return null;
  const parts = normalizedRemoteParts(match[2]);
  if (!parts) return null;
  return `${match[1]}/${parts.join("/")}`.replace(/\.git$/, "");
}

function normalizedRemoteParts(path) {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts.every(safeRemoteSegment)) return null;
  return PRIVATE_REMOTE_ROOTS.has(parts[0].toLowerCase()) ? null : parts;
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
