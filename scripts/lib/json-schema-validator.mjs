function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

const TYPE_CHECKS = Object.freeze({
  null: (value) => value === null,
  array: Array.isArray,
  object: isPlainObject,
  integer: Number.isInteger,
  number: (value) => typeof value === "number" && Number.isFinite(value),
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
});

const VALUE_VALIDATORS = Object.freeze({
  "[object String]": validateString,
  "[object Number]": validateNumber,
  "[object Array]": validateArray,
  "[object Object]": validateObject,
});

function typeMatches(value, type) {
  const check = TYPE_CHECKS[type];
  return Boolean(check) && check(value);
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported JSON Schema reference: ${reference}.`);
  return reference.slice(2).split("/").reduce((current, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) {
      throw new Error(`Unresolvable JSON Schema reference: ${reference}.`);
    }
    return current[key];
  }, rootSchema);
}

function validateNode(value, schema, rootSchema, path) {
  if (schema.$ref) return validateNode(value, resolveReference(rootSchema, schema.$ref), rootSchema, path);
  if (Array.isArray(schema.oneOf)) return validateOneOf(value, schema.oneOf, rootSchema, path);
  const keywordErrors = validateValueKeywords(value, schema, path);
  if (keywordErrors.length > 0) return keywordErrors;
  return validateComplexValue(value, schema, rootSchema, path);
}

function validateComplexValue(value, schema, rootSchema, path) {
  const validator = VALUE_VALIDATORS[Object.prototype.toString.call(value)] ?? noErrors;
  return validator(value, schema, rootSchema, path);
}

function noErrors() {
  return [];
}

function validateOneOf(value, candidates, rootSchema, path) {
  const matches = candidates.filter((candidate) =>
    validateNode(value, candidate, rootSchema, path).length === 0
  );
  return matches.length === 1 ? [] : [`${path} must match exactly one oneOf contract.`];
}

function validateValueKeywords(value, schema, path) {
  return [
    constError(value, schema, path),
    enumError(value, schema, path),
    typeError(value, schema, path),
  ].filter(Boolean);
}

function constError(value, schema, path) {
  return Object.hasOwn(schema, "const") && value !== schema.const
    ? `${path} must equal ${JSON.stringify(schema.const)}.`
    : null;
}

function enumError(value, schema, path) {
  return Array.isArray(schema.enum) && !schema.enum.includes(value)
    ? `${path} must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}.`
    : null;
}

function typeError(value, schema, path) {
  const allowedTypes = [schema.type].flat().filter(Boolean);
  return allowedTypes.length > 0 && !allowedTypes.some((type) => typeMatches(value, type))
    ? `${path} must have type ${allowedTypes.join(" or ")}.`
    : null;
}

function validateString(value, schema, _rootSchema, path) {
  return [
    minLengthError(value, schema, path),
    maxLengthError(value, schema, path),
    patternError(value, schema, path),
    formatError(value, schema, path),
  ].filter(Boolean);
}

function minLengthError(value, schema, path) {
  return violation(schema.minLength !== undefined && value.length < schema.minLength, `${path} must contain at least ${schema.minLength} characters.`);
}

function maxLengthError(value, schema, path) {
  return violation(schema.maxLength !== undefined && value.length > schema.maxLength, `${path} must contain at most ${schema.maxLength} characters.`);
}

function patternError(value, schema, path) {
  return violation(Boolean(schema.pattern) && !new RegExp(schema.pattern, "u").test(value), `${path} does not match its required pattern.`);
}

function formatError(value, schema, path) {
  return violation(schema.format === "date-time" && !isJsonDateTime(value), `${path} must be an ISO date-time.`);
}

function validateNumber(value, schema, _rootSchema, path) {
  return [
    violation(schema.minimum !== undefined && value < schema.minimum, `${path} must be at least ${schema.minimum}.`),
    violation(schema.maximum !== undefined && value > schema.maximum, `${path} must be at most ${schema.maximum}.`),
  ].filter(Boolean);
}

function validateArray(value, schema, rootSchema, path) {
  return [
    violation(schema.minItems !== undefined && value.length < schema.minItems, `${path} must contain at least ${schema.minItems} items.`),
    violation(schema.maxItems !== undefined && value.length > schema.maxItems, `${path} must contain at most ${schema.maxItems} items.`),
    ...validateArrayItems(value, schema.items, rootSchema, path),
  ].filter(Boolean);
}

function validateArrayItems(value, itemSchema, rootSchema, path) {
  return itemSchema
    ? value.flatMap((entry, index) => validateNode(entry, itemSchema, rootSchema, `${path}[${index}]`))
    : [];
}

function validateObject(value, schema, rootSchema, path) {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  return [
    ...(schema.required ?? [])
      .filter((required) => !Object.hasOwn(value, required))
      .map((required) => `${path}.${required} is required.`),
    violation(
      schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties,
      `${path} must contain at least ${schema.minProperties} properties.`,
    ),
    ...Object.entries(value).flatMap(([key, entry]) =>
      validateObjectProperty(entry, key, properties, schema.additionalProperties, rootSchema, path)
    ),
  ].filter(Boolean);
}

function validateObjectProperty(entry, key, properties, additionalProperties, rootSchema, path) {
  const entryPath = `${path}.${key}`;
  if (Object.hasOwn(properties, key)) return validateNode(entry, properties[key], rootSchema, entryPath);
  if (additionalProperties === false) return [`${entryPath} is not allowed.`];
  if (isPlainObject(additionalProperties)) return validateNode(entry, additionalProperties, rootSchema, entryPath);
  return [];
}

function violation(condition, message) {
  return condition ? message : null;
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/;

export function isJsonDateTime(value) {
  if (typeof value !== "string") return false;
  const match = DATE_TIME_PATTERN.exec(value);
  return Boolean(match) && Number.isFinite(Date.parse(value)) && hasExactCalendarComponents(match);
}

function hasExactCalendarComponents(match) {
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const expected = [year, month, day, hour, minute, second].map(Number);
  if (expected[3] > 23 || expected[4] > 59 || expected[5] > 59) return false;
  const instant = new Date(0);
  instant.setUTCHours(expected[3], expected[4], expected[5], milliseconds(fraction));
  instant.setUTCFullYear(expected[0], expected[1] - 1, expected[2]);
  const actual = [
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  ];
  return actual.every((part, index) => part === expected[index]);
}

function milliseconds(fraction) {
  return Number(fraction.padEnd(3, "0").slice(0, 3));
}

export function validateJsonSchema(value, schema) {
  if (!isPlainObject(schema)) throw new TypeError("JSON Schema must be an object.");
  return validateNode(value, schema, schema, "$");
}
