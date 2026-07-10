import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "../../scripts/lib/git-process.mjs";
import { NativeGitStore } from "../../scripts/providers/native-git-store.mjs";

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tabellio-native-git-"));
  const bare = join(root, "repository.git");
  const seed = join(root, "seed");
  const workspaces = join(root, "workspaces");
  await mkdir(workspaces);
  await NativeGitStore.createBare(bare);
  await runGit({ args: ["clone", bare, seed], cwd: root });

  await writeFile(join(seed, "README.md"), "base\n");
  await commitAll(seed, "base");
  await runGit({ args: ["push", "origin", "main"], cwd: seed });

  await runGit({ args: ["switch", "-c", "feature"], cwd: seed });
  await writeFile(join(seed, "README.md"), "feature\n");
  await commitAll(seed, "feature");
  const featureCommit = await head(seed);
  await runGit({ args: ["push", "origin", "feature"], cwd: seed });

  await runGit({ args: ["switch", "main"], cwd: seed });
  await writeFile(join(seed, "README.md"), "main\n");
  await writeFile(join(seed, "BASE_ONLY.md"), "base branch only\n");
  await commitAll(seed, "main change");
  const mainCommit = await head(seed);
  await runGit({ args: ["push", "origin", "main"], cwd: seed });

  return { root, bare, seed, workspaces, featureCommit, mainCommit };
}

export function identityEnv() {
  return {
    GIT_AUTHOR_NAME: "Tabellio Test",
    GIT_AUTHOR_EMAIL: "tabellio@example.invalid",
    GIT_COMMITTER_NAME: "Tabellio Test",
    GIT_COMMITTER_EMAIL: "tabellio@example.invalid",
  };
}

async function commitAll(cwd, message) {
  await runGit({ args: ["add", "."], cwd });
  await runGit({ args: ["commit", "-m", message], cwd, env: identityEnv() });
}

async function head(cwd) {
  return runGit({ args: ["rev-parse", "HEAD"], cwd }).then((result) => result.stdout.trim());
}
