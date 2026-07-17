#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_CAPTURE_BYTES = 1024 * 1024;

try {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const configPath = containedPath(root, options.config ?? ".tabellio/validators.json", "config");
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const profile = config.profiles[options.profile];
  if (!profile) throw new Error(`Unknown validator profile: ${options.profile}.`);

  const execution = await runProfile(profile, root);
  if (!options.out) {
    process.exitCode = execution.status === "passed" ? 0 : execution.status === "failed" ? 1 : 2;
  } else {
    if (!options.validatorId) throw new Error("--validator-id is required with --out.");
    const outPath = containedPath(root, options.out, "out");
    const evidence = buildEvidence(options.validatorId, profile, execution);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, profile: options.profile, out: relative(root, outPath), status: evidence.status }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Expected a value after ${flag ?? "arguments"}.`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!["config", "profile", "validatorId", "out"].includes(key)) throw new Error(`Unsupported option: ${flag}.`);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${flag}.`);
    values[key] = value;
  }
  if (!values.profile) throw new Error("--profile is required.");
  return values;
}

function validateConfig(value) {
  object(value, "adapter config");
  exactKeys(value, ["schemaVersion", "profiles"], "adapter config");
  if (value.schemaVersion !== "tabellio-adapter/v0.1") throw new Error("adapter config schemaVersion must be tabellio-adapter/v0.1.");
  object(value.profiles, "adapter config.profiles");
  const entries = Object.entries(value.profiles);
  if (entries.length < 1 || entries.length > 20) throw new Error("adapter config.profiles must contain 1 to 20 profiles.");
  for (const [id, profile] of entries) validateProfile(id, profile);
  return value;
}

function validateProfile(id, value) {
  requiredString(id, "profile id");
  object(value, `profile ${id}`);
  exactKeys(value, ["commands", "metrics", "cost", "summary"], `profile ${id}`);
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 20) {
    throw new Error(`profile ${id}.commands must contain 1 to 20 commands.`);
  }
  for (const [index, argv] of value.commands.entries()) validateArgv(argv, `profile ${id}.commands[${index}]`);
  if (!Array.isArray(value.metrics) || value.metrics.length > 100) throw new Error(`profile ${id}.metrics must be an array.`);
  for (const [index, metric] of value.metrics.entries()) validateMetric(metric, `profile ${id}.metrics[${index}]`);
  validateCost(value.cost, `profile ${id}.cost`);
  requiredString(value.summary, `profile ${id}.summary`);
}

function validateArgv(argv, path) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 100) throw new Error(`${path} must contain 1 to 100 arguments.`);
  for (const [index, argument] of argv.entries()) requiredString(argument, `${path}[${index}]`);
}

function validateMetric(value, path) {
  object(value, path);
  const keys = Object.keys(value);
  const extracted = keys.includes("pattern");
  exactKeys(value, extracted ? ["name", "unit", "pattern"] : ["name", "unit", "passValue", "failValue"], path);
  requiredString(value.name, `${path}.name`);
  requiredString(value.unit, `${path}.unit`);
  if (extracted) {
    requiredString(value.pattern, `${path}.pattern`);
    const expression = new RegExp(value.pattern);
    if (expression.source.length > 500) throw new Error(`${path}.pattern is too long.`);
  } else {
    finiteNumber(value.passValue, `${path}.passValue`);
    finiteNumber(value.failValue, `${path}.failValue`);
  }
}

function validateCost(value, path) {
  object(value, path);
  exactKeys(value, ["telemetry", "usd", "modelCalls", "toolCalls"], path);
  if (!['available', 'unavailable', 'not_applicable'].includes(value.telemetry)) throw new Error(`${path}.telemetry is invalid.`);
  if (value.telemetry === "available") {
    nonNegativeNumber(value.usd, `${path}.usd`);
    nonNegativeInteger(value.modelCalls, `${path}.modelCalls`);
    nonNegativeInteger(value.toolCalls, `${path}.toolCalls`);
  } else if (value.usd !== null || value.modelCalls !== null || value.toolCalls !== null) {
    throw new Error(`${path} unavailable or not_applicable values must be null.`);
  }
}

async function runProfile(profile, cwd) {
  const outputs = [];
  for (const argv of profile.commands) {
    const result = await runCommand(argv, cwd);
    outputs.push(result.output);
    if (result.spawnError) return { status: "blocked", outputs, reason: `command unavailable: ${argv[0]}` };
    if (result.exitCode !== 0) return { status: "failed", outputs, reason: `command failed: ${argv.join(" ")}` };
  }
  return { status: "passed", outputs, reason: "all declared commands passed" };
}

function runCommand(argv, cwd) {
  return new Promise((resolvePromise) => {
    let captured = "";
    let capturedBytes = 0;
    let spawnError = null;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, CI: "1", TABELLIO_VALIDATION: "1", NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (target) => (chunk) => {
      target.write(chunk);
      if (capturedBytes >= MAX_CAPTURE_BYTES) return;
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      const slice = chunk.subarray(0, remaining);
      captured += slice.toString("utf8");
      capturedBytes += slice.byteLength;
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, signal) => resolvePromise({
      exitCode: exitCode ?? (signal ? 1 : 0),
      output: captured,
      spawnError,
    }));
  });
}

function buildEvidence(validatorId, profile, execution) {
  const combinedOutput = execution.outputs.join("\n");
  const metrics = [];
  let status = execution.status;
  let reason = execution.reason;
  for (const metric of profile.metrics) {
    if (Object.hasOwn(metric, "pattern")) {
      const match = new RegExp(metric.pattern, "m").exec(combinedOutput);
      const value = match ? Number(match[1]) : Number.NaN;
      if (!Number.isFinite(value)) {
        status = "blocked";
        reason = `metric unavailable: ${metric.name}`;
        continue;
      }
      metrics.push({ name: metric.name, value, unit: metric.unit });
    } else {
      metrics.push({
        name: metric.name,
        value: execution.status === "passed" ? metric.passValue : metric.failValue,
        unit: metric.unit,
      });
    }
  }
  return {
    schemaVersion: "tabellio-validator-evidence/v0.1",
    validatorId,
    status,
    summary: `${profile.summary} ${reason}.`.slice(0, 2000),
    metrics,
    cost: profile.cost,
    artifacts: [],
  };
}

function containedPath(root, input, label) {
  requiredString(input, label);
  if (isAbsolute(input)) throw new Error(`${label} must be relative.`);
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} must stay inside the repository.`);
  return target;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value === "" || /[\0\r\n]/.test(value)) throw new Error(`${path} must be a non-empty single-line string.`);
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite.`);
}

function nonNegativeNumber(value, path) {
  finiteNumber(value, path);
  if (value < 0) throw new Error(`${path} must be non-negative.`);
}

function nonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer.`);
}
