import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePlatformConfig } from "../scripts/lib/platform-config.mjs";

const projectRoot = new URL("../", import.meta.url).pathname;

test("platform v0.3 makes GitHub code-only storage and private GitHub control state explicit", async () => {
  const config = JSON.parse(await readFile(`${projectRoot}/tabellio.platform.json`, "utf8"));
  assert.equal(validatePlatformConfig(config), config);
  assert.deepEqual(config.codeStorage, {
    provider: "github",
    remoteName: "origin",
    publicSurface: "code-and-thin-pr",
    codeRef: "refs/heads/main",
    allowedRefPrefixes: ["refs/heads/", "refs/tags/"],
  });
  assert.equal(config.workflow.controlState, "external");
  assert.equal(config.workflow.controlProvider, "github");
  assert.equal(config.workflow.controlRemoteName, "control");
  assert.equal(config.workflow.publishControlRefsToCodeStorage, false);
  assert.equal(config.ledger.storage, "external");
  assert.equal(config.validation.storage, "external");
  assert.equal(config.reviews.storage, "external");
});

test("platform v0.3 rejects provider drift and private-state publication", async () => {
  const config = JSON.parse(await readFile(`${projectRoot}/tabellio.platform.json`, "utf8"));
  assert.throws(
    () => validatePlatformConfig({ ...config, codeStorage: { ...config.codeStorage, provider: "unsupported" } }),
    /platform.codeStorage.provider must be "github"/,
  );
  assert.throws(
    () => validatePlatformConfig({ ...config, workflow: { ...config.workflow, publishControlRefsToCodeStorage: true } }),
    /platform.workflow.publishControlRefsToCodeStorage must be false/,
  );
  assert.throws(
    () => validatePlatformConfig({ ...config, workflow: { ...config.workflow, controlProvider: "unsupported" } }),
    /platform.workflow.controlProvider must be "github"/,
  );
  assert.throws(
    () => validatePlatformConfig({ ...config, codeStorage: { ...config.codeStorage, allowedRefPrefixes: ["refs/heads/", "refs/tabellio/"] } }),
    /allowedRefPrefixes must contain each required value exactly once/,
  );
});
