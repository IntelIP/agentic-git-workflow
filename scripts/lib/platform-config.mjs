const CONTROL_REFS = [
  "refs/tabellio/reviews",
  "refs/tabellio/validations",
  "refs/heads/entire/checkpoints/v1",
];

const CODE_REF_PREFIXES = ["refs/heads/", "refs/tags/"];

export function validatePlatformConfig(value) {
  exactObject(value, { schemaVersion: "tabellio-platform/v0.3" }, "platform", ["codeStorage", "workflow", "ledger", "validation", "reviews"]);

  exactObject(value.codeStorage, {
    provider: "github",
    remoteName: "origin",
    publicSurface: "code-and-thin-pr",
    codeRef: "refs/heads/main",
  }, "platform.codeStorage", ["allowedRefPrefixes"]);
  exactSet(value.codeStorage.allowedRefPrefixes, CODE_REF_PREFIXES, "platform.codeStorage.allowedRefPrefixes");

  exactObject(value.workflow, {
    stackManager: "git-spice",
    controlState: "external",
    controlProvider: "github",
    controlRemoteName: "control",
    publishControlRefsToCodeStorage: false,
  }, "platform.workflow", ["controlRefs"]);
  exactSet(value.workflow.controlRefs, CONTROL_REFS, "platform.workflow.controlRefs");

  exactObject(value.ledger, {
    provider: "entire",
    storage: "external",
    checkpointRef: "refs/heads/entire/checkpoints/v1",
  }, "platform.ledger");
  exactObject(value.validation, {
    runner: "tabellio-validate",
    storage: "external",
    resultRef: "refs/tabellio/validations",
  }, "platform.validation", ["manifest"]);
  if (typeof value.validation.manifest !== "string" || value.validation.manifest.trim() === "") {
    throw new Error("platform.validation.manifest must be a non-empty string.");
  }
  exactObject(value.reviews, {
    provider: "tabellio",
    storage: "external",
    stateRef: "refs/tabellio/reviews",
  }, "platform.reviews");
  return value;
}

function exactObject(value, expected, path, additionalKeys = []) {
  assertObject(value, path);
  const wantedKeys = [...Object.keys(expected), ...additionalKeys].sort();
  const actualKeys = Object.keys(value).sort();
  assertKeys(actualKeys, wantedKeys, path);
  assertValues(value, expected, path);
}

function assertObject(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function assertKeys(actual, wanted, path) {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function assertValues(value, expected, path) {
  for (const [key, wanted] of Object.entries(expected)) {
    if (value[key] !== wanted) throw new Error(`${path}.${key} must be ${JSON.stringify(wanted)}.`);
  }
}

function exactSet(value, expected, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const actual = JSON.stringify([...value].sort());
  const wanted = JSON.stringify([...expected].sort());
  if (actual !== wanted) throw new Error(`${path} must contain each required value exactly once: ${expected.join(", ")}.`);
}
