import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function assertExternalStateRoot(repoPath, stateRoot, label) {
  const path = relative(repoPath, stateRoot);
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (!outside) throw new Error(`${label} state root must be outside the worktree; omit --state-root to use Git metadata.`);
}

export async function canonicalProspectivePath(path) {
  const { ancestor, missing } = await realExistingAncestor(path);
  return resolve(ancestor, ...missing);
}

async function realExistingAncestor(path, missing = []) {
  try {
    return { ancestor: await realpath(path), missing };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return realExistingAncestor(dirname(path), [basename(path), ...missing]);
  }
}
