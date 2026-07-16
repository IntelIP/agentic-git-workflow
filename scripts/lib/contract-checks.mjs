function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const contract = Object.freeze({
  object(value, path) {
    ensure(Object.prototype.toString.call(value) === "[object Object]", `${path} must be an object.`);
  },

  exactKeys(value, expected, path) {
    const actual = Object.keys(value);
    const wanted = new Set(expected);
    ensure(actual.length === wanted.size && actual.every((key) => wanted.has(key)), `${path} must contain exactly: ${expected.join(", ")}.`);
  },

  string(value, path) {
    ensure(typeof value === "string" && value.trim() !== "", `${path} must be a non-empty string.`);
  },

  slug(value, path) {
    ensure(typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value), `${path} contains unsupported characters.`);
  },

  semver(value, path) {
    ensure(typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value), `${path} must be a stable semantic version.`);
  },

  oid(value, path) {
    ensure(typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), `${path} must be a Git object ID.`);
  },

  sha256(value, path) {
    ensure(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${path} must be a SHA-256 digest.`);
  },

  positiveInteger(value, path) {
    ensure(Number.isInteger(value) && value > 0, `${path} must be a positive integer.`);
  },

  member(value, values, path) {
    ensure(values.includes(value), `${path} must be one of: ${values.join(", ")}.`);
  },

  equals(value, expected, path) {
    ensure(value === expected, `${path} must be ${JSON.stringify(expected)}.`);
  },

  date(value, path) {
    this.string(value, path);
    ensure(ISO_DATE_TIME.test(value), `${path} must be an ISO date-time string.`);
    ensure(!Number.isNaN(Date.parse(value)), `${path} must be an ISO date-time string.`);
  },

  safeRelativePath(value, path) {
    this.string(value, path);
    const unsafe = value === "." || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..");
    ensure(!unsafe, `${path} must be a safe relative path.`);
  },
});
