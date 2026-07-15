export function parseOptionPairs(args, context) {
  if (args.length % 2 !== 0) throw new Error(`Expected a value after ${args.at(-1) ?? context}.`);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const key = optionKey(flag);
    addOption(values, key, flag, args[index + 1]);
  }
  return values;
}

export function assertAllowedOptions(values, allowed) {
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported option: --${toKebabCase(key)}.`);
  }
}

export function requireOptions(values, keys, command) {
  for (const key of keys) {
    if (!values[key]) throw new Error(`--${toKebabCase(key)} is required${command ? ` for ${command}` : ""}.`);
  }
}

export function positiveNumberOption(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer.`);
  return number;
}

export function reportCliError(error) {
  process.exitCode = 1;
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  }, null, 2));
}

export async function writeJsonOutput(value, out) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (out) {
    const outPath = resolve(out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output);
  }
  process.stdout.write(output);
}

function optionKey(flag) {
  if (typeof flag !== "string" || !flag.startsWith("--")) throw new Error(`Expected an option, received ${flag}.`);
  return flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function addOption(values, key, flag, value) {
  if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
  values[key] = value;
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
