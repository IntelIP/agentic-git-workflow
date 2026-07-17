import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("repository adapter emits passed, failed, blocked, and extracted evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    schemaVersion: "tabellio-adapter/v0.1",
    profiles: {
      passed: profile([[process.execPath, "-e", "console.log('score=0.95')"]], [
        { name: "suite_pass", unit: "ratio", passValue: 1, failValue: 0 },
        { name: "score", unit: "ratio", pattern: "score=([0-9.]+)" },
      ]),
      failed: profile([[process.execPath, "-e", "process.exit(3)"]]),
      blocked: profile([["missing-tabellio-test-command"]]),
    },
  };
  await writeFile(join(root, "validators.json"), JSON.stringify(config));

  const passed = await runAdapter(root, "passed", "passed-validator", "passed.json");
  assert.equal(passed.status, "passed");
  assert.equal(passed.metrics.find((metric) => metric.name === "score").value, 0.95);

  const failed = await runAdapter(root, "failed", "failed-validator", "failed.json");
  assert.equal(failed.status, "failed");
  assert.equal(failed.metrics[0].value, 0);

  const blocked = await runAdapter(root, "blocked", "blocked-validator", "blocked.json");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.summary, /command unavailable/);
});

async function runAdapter(root, profileName, validatorId, out) {
  await execFileAsync(process.execPath, [
    new URL("../scripts/tabellio-validator.mjs", import.meta.url).pathname,
    "--config", "validators.json",
    "--profile", profileName,
    "--validator-id", validatorId,
    "--out", out,
  ], { cwd: root });
  return JSON.parse(await readFile(join(root, out), "utf8"));
}

function profile(commands, metrics = [{ name: "suite_pass", unit: "ratio", passValue: 1, failValue: 0 }]) {
  return {
    commands,
    metrics,
    cost: { telemetry: "not_applicable", usd: null, modelCalls: null, toolCalls: null },
    summary: "Deterministic repository adapter completed.",
  };
}
