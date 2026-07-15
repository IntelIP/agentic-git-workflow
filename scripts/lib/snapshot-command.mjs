import { resolve } from "node:path";

import { NativeGitStore } from "../providers/native-git-store.mjs";
import { writeJsonOutput } from "./cli-options.mjs";

export async function runSnapshotCommand({ repo, out, capture }) {
  const store = await NativeGitStore.open(resolve(repo ?? process.cwd()));
  const snapshot = await capture(store);
  await writeJsonOutput(snapshot, out);
}
