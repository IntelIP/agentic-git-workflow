import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  finalizeVisualCaptures,
  inspectDesignMemory,
  validateProductDesignProfile,
  validateUiReviewArtifact,
  validateVisualBaselineManifest,
} from "../scripts/lib/design-memory.mjs";

const root = new URL("../", import.meta.url).pathname;

test("example design memory is valid and internally consistent", async () => {
  const result = await inspectDesignMemory({
    repo: root,
    profile: "examples/tabellio-design-memory/product.design.json",
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.status, "design_memory_ready");
  assert.equal(result.baselines.captureCount, 1);
});

test("capture finalizer requires complete PNG matrix and emits exact-commit candidate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tabellio-visual-captures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = `${root}/examples/tabellio-design-memory`;
  await mkdir(`${directory}/captures`);
  await Promise.all([
    writeFile(`${directory}/tokens.json`, await readFile(`${sourceRoot}/tokens.json`)),
    writeFile(`${directory}/components.json`, await readFile(`${sourceRoot}/components.json`)),
    writeFile(`${directory}/decision.md`, await readFile(`${sourceRoot}/decision.md`)),
  ]);
  const profile = JSON.parse(await readFile(`${sourceRoot}/product.design.json`, "utf8"));
  profile.sources.tokens[0].path = "tokens.json";
  profile.sources.components[0].path = "components.json";
  profile.sources.decisions[0] = "decision.md";
  profile.baselines.manifest = "candidate.json";
  await writeFile(`${directory}/product.design.json`, JSON.stringify(profile, null, 2));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(`${directory}/captures/home--desktop--light--default.png`, png);
  const result = await finalizeVisualCaptures({
    repo: directory,
    profile: "product.design.json",
    capturesDir: "captures",
    artifactBaseUri: "artifact+github://example/product/actions/runs/42/design-captures/",
    sourceCommit: "c".repeat(40),
    out: "candidate.json",
  });
  assert.equal(result.captureCount, 1);
  const candidate = JSON.parse(await readFile(`${directory}/candidate.json`, "utf8"));
  assert.equal(candidate.sourceCommit, "c".repeat(40));
  assert.match(candidate.captures[0].artifact.uri, /^artifact\+github:/);
  assert.throws(() => validateVisualBaselineManifest({ ...candidate, sourceCommit: null }), /captured proposed baseline/);
});

test("structured UI review binds model judgment and cost to exact evidence", async () => {
  const review = JSON.parse(await readFile(`${root}/examples/tabellio-design-memory/ui-review.json`, "utf8"));
  assert.equal(validateUiReviewArtifact(review), review);
  const incomplete = structuredClone(review);
  delete incomplete.cost;
  assert.throws(() => validateUiReviewArtifact(incomplete), /cost is required/);
  const unknownCost = structuredClone(review);
  unknownCost.cost = { telemetry: "unknown", currency: null, amount: null, inputTokens: null, outputTokens: null };
  assert.throws(() => validateUiReviewArtifact(unknownCost), /requires blocked verdict/);
  unknownCost.verdict = "blocked";
  unknownCost.blockers = ["model cost telemetry unavailable"];
  assert.equal(validateUiReviewArtifact(unknownCost), unknownCost);
});

test("design memory rejects unsupported fields and ephemeral artifacts", async () => {
  const profile = JSON.parse(await readFile(`${root}/examples/tabellio-design-memory/product.design.json`, "utf8"));
  profile.unexpected = true;
  assert.throws(() => validateProductDesignProfile(profile), /unsupported properties/);

  const baselines = JSON.parse(await readFile(`${root}/examples/tabellio-design-memory/baselines.json`, "utf8"));
  baselines.captures[0].artifact.uri = "file:///tmp/screenshot.png";
  assert.throws(() => validateVisualBaselineManifest(baselines), /ephemeral file URI/);
});

test("design memory blocks when a canonical source drifts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tabellio-design-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = `${root}/examples/tabellio-design-memory`;
  await Promise.all([
    writeFile(`${directory}/tokens.json`, await readFile(`${sourceRoot}/tokens.json`)),
    writeFile(`${directory}/components.json`, await readFile(`${sourceRoot}/components.json`)),
    writeFile(`${directory}/decision.md`, await readFile(`${sourceRoot}/decision.md`)),
  ]);
  const profile = JSON.parse(await readFile(`${sourceRoot}/product.design.json`, "utf8"));
  profile.sources.tokens[0].path = "tokens.json";
  profile.sources.components[0].path = "components.json";
  profile.sources.decisions[0] = "decision.md";
  profile.baselines.manifest = "baselines.json";
  await writeFile(`${directory}/product.design.json`, JSON.stringify(profile, null, 2));
  const baselines = JSON.parse(await readFile(`${sourceRoot}/baselines.json`, "utf8"));
  baselines.profilePath = "product.design.json";
  const crypto = await import("node:crypto");
  baselines.profileDigest = crypto.createHash("sha256").update(await readFile(`${directory}/product.design.json`)).digest("hex");
  await writeFile(`${directory}/baselines.json`, JSON.stringify(baselines, null, 2));
  await writeFile(`${directory}/tokens.json`, "{}\n");
  const result = await inspectDesignMemory({ repo: directory, profile: "product.design.json" });
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.join("\n"), /source digest mismatch/);
});

test("design memory rejects duplicate surface matrix dimensions", async () => {
  const profile = JSON.parse(await readFile(`${root}/examples/tabellio-design-memory/product.design.json`, "utf8"));
  profile.policy.surfaces[0].viewports.push(profile.policy.surfaces[0].viewports[0]);
  assert.throws(() => validateProductDesignProfile(profile), /viewports must contain unique entries/);
});
