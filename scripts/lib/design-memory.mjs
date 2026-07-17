import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const THEMES = new Set(["light", "dark", "high-contrast"]);
const PLATFORMS = new Set(["web", "ios", "android", "desktop", "email", "docs"]);

export function validateProductDesignProfile(value) {
  object(value, "design profile");
  exactKeys(value, ["schemaVersion", "productId", "title", "audience", "platforms", "visualThesis", "sources", "referenceLock", "policy", "baselines"], "design profile");
  equal(value.schemaVersion, "tabellio-product-design/v0.1", "design profile.schemaVersion");
  string(value.productId, "design profile.productId");
  if (/^(?:\/|file:|[A-Za-z]:[\\/])|\\/.test(value.productId)) throw new TypeError("design profile.productId must not expose a local path.");
  string(value.title, "design profile.title");
  stringArray(value.audience, "design profile.audience", 1, 20);
  enumArray(value.platforms, PLATFORMS, "design profile.platforms", 1, 6);
  string(value.visualThesis, "design profile.visualThesis", 1, 1000);

  object(value.sources, "design profile.sources");
  exactKeys(value.sources, ["tokens", "components", "decisions"], "design profile.sources");
  sourceArray(value.sources.tokens, "design profile.sources.tokens");
  sourceArray(value.sources.components, "design profile.sources.components");
  stringArray(value.sources.decisions, "design profile.sources.decisions", 0, 100, safePath);

  object(value.referenceLock, "design profile.referenceLock");
  exactKeys(value.referenceLock, ["primary", "preserve", "borrow", "roleRules", "reject", "mediaStrategy"], "design profile.referenceLock");
  string(value.referenceLock.primary, "design profile.referenceLock.primary");
  stringArray(value.referenceLock.preserve, "design profile.referenceLock.preserve", 1, 20);
  stringArray(value.referenceLock.borrow, "design profile.referenceLock.borrow", 0, 20);
  stringArray(value.referenceLock.roleRules, "design profile.referenceLock.roleRules", 0, 30);
  stringArray(value.referenceLock.reject, "design profile.referenceLock.reject", 1, 30);
  string(value.referenceLock.mediaStrategy, "design profile.referenceLock.mediaStrategy", 1, 1000);

  object(value.policy, "design profile.policy");
  exactKeys(value.policy, ["themes", "viewports", "states", "surfaces", "forbiddenPatterns", "accessibility"], "design profile.policy");
  enumArray(value.policy.themes, THEMES, "design profile.policy.themes", 1, 3);
  if (!Array.isArray(value.policy.viewports) || value.policy.viewports.length < 1 || value.policy.viewports.length > 20) throw new TypeError("design profile.policy.viewports must contain 1 to 20 entries.");
  const viewportIds = new Set();
  for (const [index, viewport] of value.policy.viewports.entries()) {
    const label = `design profile.policy.viewports[${index}]`;
    object(viewport, label);
    exactKeys(viewport, ["id", "width", "height", "deviceScaleFactor"], label);
    string(viewport.id, `${label}.id`);
    if (viewportIds.has(viewport.id)) throw new TypeError(`duplicate viewport id: ${viewport.id}`);
    viewportIds.add(viewport.id);
    integer(viewport.width, `${label}.width`, 240, 7680);
    integer(viewport.height, `${label}.height`, 240, 7680);
    number(viewport.deviceScaleFactor, `${label}.deviceScaleFactor`, 0.5, 4);
  }
  stringArray(value.policy.states, "design profile.policy.states", 1, 50);
  if (!Array.isArray(value.policy.surfaces) || value.policy.surfaces.length < 1 || value.policy.surfaces.length > 100) throw new TypeError("design profile.policy.surfaces must contain 1 to 100 entries.");
  const surfaceIds = new Set();
  for (const [index, surface] of value.policy.surfaces.entries()) {
    const label = `design profile.policy.surfaces[${index}]`;
    object(surface, label);
    exactKeys(surface, ["id", "kind", "target", "viewports", "themes", "states"], label);
    string(surface.id, `${label}.id`);
    if (surfaceIds.has(surface.id)) throw new TypeError(`duplicate surface id: ${surface.id}`);
    surfaceIds.add(surface.id);
    if (!new Set(["route", "component"]).has(surface.kind)) throw new TypeError(`${label}.kind must be route or component.`);
    string(surface.target, `${label}.target`);
    uniqueStringArray(surface.viewports, `${label}.viewports`, 1, 20);
    uniqueStringArray(surface.themes, `${label}.themes`, 1, 3);
    uniqueStringArray(surface.states, `${label}.states`, 1, 50);
  }
  stringArray(value.policy.forbiddenPatterns, "design profile.policy.forbiddenPatterns", 0, 100);
  object(value.policy.accessibility, "design profile.policy.accessibility");
  exactKeys(value.policy.accessibility, ["standard", "keyboardRequired", "reducedMotionRequired"], "design profile.policy.accessibility");
  string(value.policy.accessibility.standard, "design profile.policy.accessibility.standard");
  boolean(value.policy.accessibility.keyboardRequired, "design profile.policy.accessibility.keyboardRequired");
  boolean(value.policy.accessibility.reducedMotionRequired, "design profile.policy.accessibility.reducedMotionRequired");

  object(value.baselines, "design profile.baselines");
  exactKeys(value.baselines, ["manifest"], "design profile.baselines");
  safePath(value.baselines.manifest, "design profile.baselines.manifest");
  return value;
}

export function validateVisualBaselineManifest(value) {
  object(value, "baseline manifest");
  exactKeys(value, ["schemaVersion", "status", "productId", "profilePath", "profileDigest", "sourceCommit", "approvedAt", "approvedBy", "captures"], "baseline manifest");
  equal(value.schemaVersion, "tabellio-visual-baselines/v0.1", "baseline manifest.schemaVersion");
  if (!new Set(["proposed", "approved"]).has(value.status)) throw new TypeError("baseline manifest.status must be proposed or approved.");
  string(value.productId, "baseline manifest.productId");
  safePath(value.profilePath, "baseline manifest.profilePath");
  digest(value.profileDigest, "baseline manifest.profileDigest");
  if (value.status === "approved") {
    if (!OID.test(value.sourceCommit)) throw new TypeError("approved baseline manifest.sourceCommit must be a hexadecimal Git object ID.");
    if (Number.isNaN(Date.parse(value.approvedAt))) throw new TypeError("approved baseline manifest.approvedAt must be an ISO date-time.");
    object(value.approvedBy, "baseline manifest.approvedBy");
    exactKeys(value.approvedBy, ["type", "id"], "baseline manifest.approvedBy");
    if (!new Set(["human", "team"]).has(value.approvedBy.type)) throw new TypeError("baseline manifest.approvedBy.type must be human or team.");
    string(value.approvedBy.id, "baseline manifest.approvedBy.id");
  } else if (value.approvedAt !== null || value.approvedBy !== null) {
    throw new TypeError("proposed baselines must keep approvedAt and approvedBy null.");
  }
  const minimumCaptures = value.status === "approved" ? 1 : 0;
  if (!Array.isArray(value.captures) || value.captures.length < minimumCaptures || value.captures.length > 500) throw new TypeError(`baseline manifest.captures must contain ${minimumCaptures} to 500 entries.`);
  const captureIds = new Set();
  for (const [index, capture] of value.captures.entries()) {
    const label = `baseline manifest.captures[${index}]`;
    object(capture, label);
    exactKeys(capture, ["id", "surface", "kind", "viewport", "theme", "state", "artifact", "maskSelectors", "maxDiffPixelRatio"], label);
    string(capture.id, `${label}.id`);
    if (captureIds.has(capture.id)) throw new TypeError(`duplicate capture id: ${capture.id}`);
    captureIds.add(capture.id);
    string(capture.surface, `${label}.surface`);
    if (!new Set(["route", "component"]).has(capture.kind)) throw new TypeError(`${label}.kind must be route or component.`);
    string(capture.viewport, `${label}.viewport`);
    if (!THEMES.has(capture.theme)) throw new TypeError(`${label}.theme is unsupported.`);
    string(capture.state, `${label}.state`);
    object(capture.artifact, `${label}.artifact`);
    exactKeys(capture.artifact, ["uri", "digest", "mediaType", "bytes"], `${label}.artifact`);
    string(capture.artifact.uri, `${label}.artifact.uri`);
    if (/^file:/i.test(capture.artifact.uri)) throw new TypeError(`${label}.artifact.uri must not use an ephemeral file URI.`);
    try { new URL(capture.artifact.uri); } catch { throw new TypeError(`${label}.artifact.uri must be an absolute URI.`); }
    digest(capture.artifact.digest, `${label}.artifact.digest`);
    string(capture.artifact.mediaType, `${label}.artifact.mediaType`);
    integer(capture.artifact.bytes, `${label}.artifact.bytes`, 0, Number.MAX_SAFE_INTEGER);
    stringArray(capture.maskSelectors, `${label}.maskSelectors`, 0, 100);
    number(capture.maxDiffPixelRatio, `${label}.maxDiffPixelRatio`, 0, 1);
  }
  if (value.status === "proposed" && value.captures.length === 0 && value.sourceCommit !== null) throw new TypeError("empty proposed baseline must keep sourceCommit null.");
  if (value.status === "proposed" && value.captures.length > 0 && !OID.test(value.sourceCommit)) throw new TypeError("captured proposed baseline.sourceCommit must be a hexadecimal Git object ID.");
  return value;
}

export async function finalizeVisualCaptures({ repo = ".", profile = "design/product.design.json", capturesDir, artifactBaseUri, sourceCommit, out } = {}) {
  const root = resolve(repo);
  if (!capturesDir || !artifactBaseUri || !sourceCommit || !out) throw new TypeError("capturesDir, artifactBaseUri, sourceCommit, and out are required.");
  if (!OID.test(sourceCommit)) throw new TypeError("sourceCommit must be a hexadecimal Git object ID.");
  const baseUri = new URL(artifactBaseUri);
  if (baseUri.protocol === "file:") throw new TypeError("artifactBaseUri must be durable and must not use file:.");
  const profilePath = containedPath(root, profile, "profile");
  const profileBytes = await readFile(profilePath);
  const profileValue = JSON.parse(profileBytes.toString("utf8"));
  validateProductDesignProfile(profileValue);
  const directory = containedPath(root, capturesDir, "capturesDir");
  const files = (await readdir(directory)).filter((entry) => entry.endsWith(".png")).sort();
  const captures = [];
  for (const surface of profileValue.policy.surfaces) {
    for (const viewport of surface.viewports) for (const theme of surface.themes) for (const state of surface.states) {
      const id = `${surface.id}--${viewport}--${theme}--${state}`;
      const filename = `${id}.png`;
      if (!files.includes(filename)) throw new TypeError(`required capture file is missing: ${filename}`);
      const bytes = await readFile(resolve(directory, filename));
      if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new TypeError(`capture is not a PNG: ${filename}`);
      captures.push({
        id,
        surface: surface.target,
        kind: surface.kind,
        viewport,
        theme,
        state,
        artifact: {
          uri: new URL(basename(filename), `${baseUri.toString().replace(/\/?$/, "/")}`).toString(),
          digest: sha256(bytes),
          mediaType: "image/png",
          bytes: bytes.length,
        },
        maskSelectors: [],
        maxDiffPixelRatio: 0.01,
      });
    }
  }
  const manifest = {
    schemaVersion: "tabellio-visual-baselines/v0.1",
    status: "proposed",
    productId: profileValue.productId,
    profilePath: relative(root, profilePath).split(sep).join("/"),
    profileDigest: sha256(profileBytes),
    sourceCommit,
    approvedAt: null,
    approvedBy: null,
    captures,
  };
  validateVisualBaselineManifest(manifest);
  const outputPath = containedPath(root, out, "out");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { status: "capture_candidate_ready", output: relative(root, outputPath).split(sep).join("/"), captureCount: captures.length, profileDigest: manifest.profileDigest, sourceCommit };
}

export function validateUiReviewArtifact(value) {
  object(value, "UI review");
  exactKeys(value, ["schemaVersion", "productId", "sourceCommit", "profileDigest", "reviewer", "cost", "captures", "summary", "findings", "verdict", "blockers"], "UI review");
  equal(value.schemaVersion, "tabellio-ui-review/v0.1", "UI review.schemaVersion");
  string(value.productId, "UI review.productId");
  if (!OID.test(value.sourceCommit)) throw new TypeError("UI review.sourceCommit must be a hexadecimal Git object ID.");
  digest(value.profileDigest, "UI review.profileDigest");
  object(value.reviewer, "UI review.reviewer");
  exactKeys(value.reviewer, ["provider", "model"], "UI review.reviewer");
  string(value.reviewer.provider, "UI review.reviewer.provider");
  string(value.reviewer.model, "UI review.reviewer.model");
  object(value.cost, "UI review.cost");
  exactKeys(value.cost, ["telemetry", "currency", "amount", "inputTokens", "outputTokens"], "UI review.cost");
  if (!new Set(["available", "unknown", "not_applicable"]).has(value.cost.telemetry)) throw new TypeError("UI review.cost.telemetry is unsupported.");
  if (value.cost.telemetry === "available") {
    string(value.cost.currency, "UI review.cost.currency", 3, 3);
    number(value.cost.amount, "UI review.cost.amount", 0, Number.MAX_SAFE_INTEGER);
    integer(value.cost.inputTokens, "UI review.cost.inputTokens", 0, Number.MAX_SAFE_INTEGER);
    integer(value.cost.outputTokens, "UI review.cost.outputTokens", 0, Number.MAX_SAFE_INTEGER);
  } else if (value.cost.currency !== null || value.cost.amount !== null || value.cost.inputTokens !== null || value.cost.outputTokens !== null) {
    throw new TypeError("unavailable UI review cost fields must be null.");
  }
  if (!Array.isArray(value.captures) || value.captures.length < 1 || value.captures.length > 500) throw new TypeError("UI review.captures must contain 1 to 500 entries.");
  for (const [index, capture] of value.captures.entries()) {
    const label = `UI review.captures[${index}]`;
    object(capture, label);
    exactKeys(capture, ["id", "artifactDigest"], label);
    string(capture.id, `${label}.id`);
    digest(capture.artifactDigest, `${label}.artifactDigest`);
  }
  string(value.summary, "UI review.summary", 1, 2000);
  if (!Array.isArray(value.findings) || value.findings.length > 500) throw new TypeError("UI review.findings must contain 0 to 500 entries.");
  for (const [index, finding] of value.findings.entries()) {
    const label = `UI review.findings[${index}]`;
    object(finding, label);
    exactKeys(finding, ["id", "severity", "category", "surface", "evidence", "recommendation"], label);
    string(finding.id, `${label}.id`);
    if (!new Set(["info", "warning", "error", "critical"]).has(finding.severity)) throw new TypeError(`${label}.severity is unsupported.`);
    string(finding.category, `${label}.category`);
    string(finding.surface, `${label}.surface`);
    string(finding.evidence, `${label}.evidence`, 1, 2000);
    string(finding.recommendation, `${label}.recommendation`, 1, 2000);
  }
  if (!new Set(["passed", "failed", "blocked"]).has(value.verdict)) throw new TypeError("UI review.verdict must be passed, failed, or blocked.");
  stringArray(value.blockers, "UI review.blockers", 0, 100);
  if (value.verdict === "blocked" && value.blockers.length === 0) throw new TypeError("blocked UI review requires at least one blocker.");
  if (value.cost.telemetry === "unknown" && value.verdict !== "blocked") throw new TypeError("unknown UI review cost telemetry requires blocked verdict.");
  return value;
}

export async function inspectDesignMemory({ repo = ".", profile = "design/product.design.json", baselines = null } = {}) {
  const root = resolve(repo);
  const profilePath = containedPath(root, profile, "profile");
  const blockers = [];
  let profileValue = null;
  let baselineValue = null;
  try {
    const profileBytes = await readFile(profilePath);
    profileValue = JSON.parse(profileBytes.toString("utf8"));
    validateProductDesignProfile(profileValue);
    for (const source of [...profileValue.sources.tokens, ...profileValue.sources.components]) {
      const sourcePath = containedPath(root, source.path, "source");
      const bytes = await readFile(sourcePath);
      const actual = sha256(bytes);
      if (actual !== source.digest) blockers.push(`source digest mismatch: ${source.path}`);
    }
    for (const decision of profileValue.sources.decisions) await readFile(containedPath(root, decision, "decision"));
    const baselineRelative = baselines ?? profileValue.baselines.manifest;
    const baselinePath = containedPath(root, baselineRelative, "baselines");
    baselineValue = JSON.parse(await readFile(baselinePath, "utf8"));
    validateVisualBaselineManifest(baselineValue);
    const expectedProfilePath = relative(root, profilePath).split(sep).join("/");
    if (baselineValue.profilePath !== expectedProfilePath) blockers.push(`baseline profilePath must equal ${expectedProfilePath}`);
    if (baselineValue.profileDigest !== sha256(profileBytes)) blockers.push("baseline profileDigest does not match profile bytes");
    if (baselineValue.productId !== profileValue.productId) blockers.push("baseline productId does not match profile productId");
    if (baselineValue.status !== "approved") blockers.push("baseline manifest is proposed; human approval required");
    const viewportIds = new Set(profileValue.policy.viewports.map((entry) => entry.id));
    const states = new Set(profileValue.policy.states);
    const themes = new Set(profileValue.policy.themes);
    for (const capture of baselineValue.captures) {
      if (!viewportIds.has(capture.viewport)) blockers.push(`capture ${capture.id} uses unknown viewport ${capture.viewport}`);
      if (!states.has(capture.state)) blockers.push(`capture ${capture.id} uses unknown state ${capture.state}`);
      if (!themes.has(capture.theme)) blockers.push(`capture ${capture.id} uses unrequired theme ${capture.theme}`);
    }
    for (const surface of profileValue.policy.surfaces) {
      for (const viewport of surface.viewports) if (!viewportIds.has(viewport)) blockers.push(`surface ${surface.id} uses unknown viewport ${viewport}`);
      for (const theme of surface.themes) if (!themes.has(theme)) blockers.push(`surface ${surface.id} uses unknown theme ${theme}`);
      for (const state of surface.states) if (!states.has(state)) blockers.push(`surface ${surface.id} uses unknown state ${state}`);
      if (baselineValue.captures.length > 0) {
        for (const viewport of surface.viewports) for (const theme of surface.themes) for (const state of surface.states) {
          const found = baselineValue.captures.some((capture) => capture.surface === surface.target && capture.kind === surface.kind && capture.viewport === viewport && capture.theme === theme && capture.state === state);
          if (!found) blockers.push(`approved baseline missing capture: ${surface.id}/${viewport}/${theme}/${state}`);
        }
      }
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "design_memory_ready" : "blocked",
    profile: profileValue ? { productId: profileValue.productId, schemaVersion: profileValue.schemaVersion } : null,
    baselines: baselineValue ? { schemaVersion: baselineValue.schemaVersion, captureCount: baselineValue.captures?.length ?? null } : null,
    blockers,
  };
}

function sourceArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new TypeError(`${label} must contain 1 to 100 entries.`);
  for (const [index, entry] of value.entries()) {
    const item = `${label}[${index}]`;
    object(entry, item);
    exactKeys(entry, ["path", "digest"], item);
    safePath(entry.path, `${item}.path`);
    digest(entry.digest, `${item}.digest`);
  }
}

function containedPath(root, input, label) {
  safePath(input, label);
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError(`${label} must stay inside repository.`);
  return absolute;
}

function safePath(value, label = "path") {
  string(value, label);
  if (isAbsolute(value) || value === ".." || value.split(/[\\/]/).includes("..") || /^[A-Za-z]:[\\/]/.test(value)) throw new TypeError(`${label} must be a safe repository-relative path.`);
}

function exactKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new TypeError(`${label} has unsupported properties: ${extra.join(", ")}`);
  for (const key of allowed) if (!(key in value)) throw new TypeError(`${label}.${key} is required.`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
}

function string(value, label, min = 1, max = 500) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new TypeError(`${label} must be a string between ${min} and ${max} characters.`);
}

function stringArray(value, label, min, max, itemValidator = null) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${label} must contain ${min} to ${max} entries.`);
  for (const [index, entry] of value.entries()) itemValidator ? itemValidator(entry, `${label}[${index}]`) : string(entry, `${label}[${index}]`);
}

function uniqueStringArray(value, label, min, max) {
  stringArray(value, label, min, max);
  if (new Set(value).size !== value.length) throw new TypeError(`${label} must contain unique entries.`);
}

function enumArray(value, allowed, label, min, max) {
  stringArray(value, label, min, max);
  for (const entry of value) if (!allowed.has(entry)) throw new TypeError(`${label} contains unsupported value: ${entry}`);
}

function equal(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} must equal ${expected}.`);
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer between ${min} and ${max}.`);
}

function number(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${label} must be a number between ${min} and ${max}.`);
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
