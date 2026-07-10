import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { captureContext } from "./lib/capture-context.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { NativeGitStore } from "./providers/native-git-store.mjs";

const args = parseArgs(process.argv.slice(2));
const repoPath = resolve(args.repo ?? process.cwd());
const outPath = resolve(args.out ?? "tabellio-context.json");
const baseRevision = args.base ?? "main";
const headRevision = args.head ?? "HEAD";
const notesRef = args.notesRef ?? "refs/notes/tabellio/context";
const store = await NativeGitStore.open(repoPath);

const packet = await captureContext({
  store,
  baseRevision,
  headRevision,
  baseName: args.baseName ?? baseRevision,
  headName: args.headName ?? headRevision,
  notesRef,
  runId: args.runId ?? `local-${randomUUID()}`,
  repositoryId: await repositoryIdentity(store, args.repoId),
  actor: {
    type: args.actorType ?? "agent",
    id: args.actor ?? process.env.USER ?? "local-agent",
  },
  taskSummary: args.taskSummary ?? "Context captured from native Git state.",
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(packet, null, 2)}\n`);
console.log(JSON.stringify(packet, null, 2));

function parseArgs(argv) {
  const parsed = {};
  const aliases = new Map([
    ["--repo", "repo"],
    ["--repo-id", "repoId"],
    ["--base", "base"],
    ["--base-name", "baseName"],
    ["--head", "head"],
    ["--head-name", "headName"],
    ["--out", "out"],
    ["--run-id", "runId"],
    ["--task-summary", "taskSummary"],
    ["--actor", "actor"],
    ["--actor-type", "actorType"],
    ["--notes-ref", "notesRef"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error(`${argv[index - 1]} requires a value.`);
    parsed[key] = value;
  }
  return parsed;
}
