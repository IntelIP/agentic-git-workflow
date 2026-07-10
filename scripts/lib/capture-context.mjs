import { createHash } from "node:crypto";

import { createContextPacket } from "./context-packet.mjs";

export function localRepositoryId(repoPath) {
  const name = repoPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return `local/${name ?? "repository"}`;
}

export async function captureContext({
  store,
  baseRevision,
  headRevision,
  baseName = baseRevision,
  headName = headRevision,
  notesRef = "refs/notes/tabellio/context",
  runId,
  repositoryId,
  actor,
  taskSummary,
  createdAt,
}) {
  const [baseCommit, headCommit] = await Promise.all([
    store.resolveRef(baseRevision),
    store.resolveRef(headRevision),
  ]);
  const mergePreview = await store.previewMerge({ base: baseCommit, head: headCommit });
  if (mergePreview.baseCommit !== baseCommit || mergePreview.headCommit !== headCommit) {
    throw new Error("Merge preview did not use the frozen base and head commits.");
  }
  const [diff, note] = await Promise.all([
    store.getDiff(mergePreview.mergeBase, headCommit),
    store.readNote(headCommit, { notesRef }),
  ]);
  if (diff.baseCommit !== mergePreview.mergeBase || diff.headCommit !== headCommit) {
    throw new Error("Change set did not use merge-base and the frozen head commit.");
  }

  return createContextPacket({
    runId,
    repository: {
      id: repositoryId,
      storage: "native-git",
    },
    actor,
    task: {
      summary: taskSummary,
    },
    refs: {
      base: { name: baseName, commit: baseCommit },
      head: { name: headName, commit: headCommit },
      mergeBase: { name: "merge-base", commit: mergePreview.mergeBase },
    },
    changeSet: {
      files: diff.files,
    },
    checkpoints: note ? [checkpointFromNote({ note, notesRef, commit: headCommit })] : [],
    mergePreview: {
      clean: mergePreview.clean,
      tree: mergePreview.tree,
      conflictFiles: mergePreview.conflictFiles,
    },
    createdAt,
  });
}

function checkpointFromNote({ note, notesRef, commit }) {
  const checkpoint = {
    ref: notesRef,
    commit,
    digest: createHash("sha256").update(note).digest("hex"),
  };
  try {
    const parsed = JSON.parse(note);
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      checkpoint.summary = parsed.summary.trim().slice(0, 500);
    }
  } catch {
    // Note content stays private; only its digest is captured.
  }
  return checkpoint;
}
