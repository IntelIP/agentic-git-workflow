export const STACK_SCHEMA_VERSION = "tabellio-stack/v0.1";

export class StackManager {
  /** @returns {Promise<string>} */
  async toolVersion() {
    throw new Error("StackManager.toolVersion must be implemented.");
  }

  /** @param {{repositoryId: string, capturedAt?: string}} options */
  async snapshot(_options) {
    throw new Error("StackManager.snapshot must be implemented.");
  }
}

export function validateStackSnapshot(value) {
  requireObject(value, "stack snapshot");
  exactKeys(value, [
    "schemaVersion",
    "repository",
    "provider",
    "capturedAt",
    "currentBranch",
    "roots",
    "branches",
  ], "stack snapshot");
  equals(value.schemaVersion, STACK_SCHEMA_VERSION, "schemaVersion");
  isoDate(value.capturedAt, "capturedAt");

  requireObject(value.repository, "repository");
  exactKeys(value.repository, ["id"], "repository");
  requiredString(value.repository.id, "repository.id");
  if (/^(?:\/|file:|[A-Za-z]:[\\/])/.test(value.repository.id) || value.repository.id.includes("\\")) {
    throw new Error("repository.id must not expose a local filesystem path.");
  }

  requireObject(value.provider, "provider");
  exactKeys(value.provider, ["id", "version"], "provider");
  equals(value.provider.id, "git-spice", "provider.id");
  requiredString(value.provider.version, "provider.version");

  if (value.currentBranch !== null) requiredString(value.currentBranch, "currentBranch");
  stringArray(value.roots, "roots");
  if (!Array.isArray(value.branches)) throw new Error("branches must be an array.");

  const branchNames = new Set();
  const branchByName = new Map();
  const currentBranches = [];
  for (const [index, branch] of value.branches.entries()) {
    const path = `branches[${index}]`;
    requireObject(branch, path);
    exactKeys(branch, [
      "name",
      "current",
      "parent",
      "children",
      "needsRestack",
      "checkedOutElsewhere",
      "changeRequest",
      "push",
    ], path);
    requiredString(branch.name, `${path}.name`);
    if (branchNames.has(branch.name)) throw new Error(`branches contains duplicate name: ${branch.name}.`);
    branchNames.add(branch.name);
    branchByName.set(branch.name, branch);
    boolean(branch.current, `${path}.current`);
    if (branch.current) currentBranches.push(branch.name);
    if (branch.parent !== null) requiredString(branch.parent, `${path}.parent`);
    stringArray(branch.children, `${path}.children`);
    boolean(branch.needsRestack, `${path}.needsRestack`);
    boolean(branch.checkedOutElsewhere, `${path}.checkedOutElsewhere`);
    validateChangeRequest(branch.changeRequest, `${path}.changeRequest`);
    validatePush(branch.push, `${path}.push`);
  }

  if (currentBranches.length > 1) throw new Error("branches may contain at most one current branch.");
  if ((currentBranches[0] ?? null) !== value.currentBranch) {
    throw new Error("currentBranch must match the branch marked current.");
  }

  const expectedRoots = value.branches
    .filter((branch) => branch.parent === null)
    .map((branch) => branch.name)
    .sort();
  if (JSON.stringify([...value.roots].sort()) !== JSON.stringify(expectedRoots)) {
    throw new Error("roots must list every branch without a parent.");
  }

  for (const branch of value.branches) {
    if (branch.parent !== null && !branchNames.has(branch.parent)) {
      throw new Error(`Branch ${branch.name} references missing parent ${branch.parent}.`);
    }
    for (const child of branch.children) {
      if (!branchNames.has(child)) throw new Error(`Branch ${branch.name} references missing child ${child}.`);
      const childBranch = branchByName.get(child);
      if (childBranch.parent !== branch.name) {
        throw new Error(`Branch ${child} must name ${branch.name} as its parent.`);
      }
    }
  }
  return value;
}

function validateChangeRequest(value, path) {
  if (value === null) return;
  requireObject(value, path);
  exactKeys(value, ["id", "url", "status"], path);
  requiredString(value.id, `${path}.id`);
  requiredString(value.url, `${path}.url`);
  let parsed;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error(`${path}.url must be an absolute HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${path}.url must be an absolute HTTP URL.`);
  if (value.status !== null && !["open", "closed", "merged"].includes(value.status)) {
    throw new Error(`${path}.status must be open, closed, merged, or null.`);
  }
}

function validatePush(value, path) {
  if (value === null) return;
  requireObject(value, path);
  exactKeys(value, ["ahead", "behind", "needsPush"], path);
  nonNegativeInteger(value.ahead, `${path}.ahead`);
  nonNegativeInteger(value.behind, `${path}.behind`);
  boolean(value.needsPush, `${path}.needsPush`);
}

function exactKeys(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unsupported properties: ${unexpected.join(", ")}.`);
  const undefinedKeys = Object.keys(value).filter((key) => value[key] === undefined);
  if (undefinedKeys.length > 0) throw new Error(`${path} properties must not be undefined: ${undefinedKeys.join(", ")}.`);
}

function requireObject(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function stringArray(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    requiredString(item, `${path}[${index}]`);
    if (seen.has(item)) throw new Error(`${path} must contain unique values.`);
    seen.add(item);
  }
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
}

function nonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer.`);
}

function isoDate(value, path) {
  requiredString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO date-time string.`);
  }
}

function equals(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${expected}.`);
}
