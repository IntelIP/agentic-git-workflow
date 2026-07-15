import { execFile } from "node:child_process";

export class ExternalCommandError extends Error {
  constructor({ binary, args, cwd, exitCode, signal, stdout, stderr, cause }) {
    const unavailable = cause?.code === "ENOENT";
    super(unavailable
      ? `${binary} is not installed or not executable.`
      : `${[binary, ...args].join(" ")} failed with exit code ${exitCode ?? "unknown"}.`);
    this.command = [binary, ...args].join(" ");
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.cause = cause;
  }
}

export function runExternalCommand({
  binary,
  args,
  cwd = process.cwd(),
  timeoutMs,
  env = {},
  ErrorType = ExternalCommandError,
  argumentLabel = binary,
}) {
  requiredString(binary, "binary");
  validateArguments(args, argumentLabel);
  return new Promise((resolve, reject) => {
    execFile(binary, args, commandOptions(cwd, timeoutMs, env), (error, stdout = "", stderr = "") => {
      finishCommand({ error, stdout, stderr, binary, args, cwd, ErrorType, resolve, reject });
    });
  });
}

function commandOptions(cwd, timeoutMs, env) {
  return {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      NO_COLOR: "1",
      ...env,
    },
  };
}

function finishCommand({ error, stdout, stderr, binary, args, cwd, ErrorType, resolve, reject }) {
  const result = {
    binary,
    args,
    cwd,
    exitCode: commandExitCode(error),
    signal: commandSignal(error),
    stdout,
    stderr,
    cause: commandCause(error),
  };
  if (error) reject(new ErrorType(result));
  else resolve(result);
}

function commandSignal(error) {
  return error?.signal ?? null;
}

function commandCause(error) {
  return error ?? null;
}

function commandExitCode(error) {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

function validateArguments(args, label) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError(`${label} arguments must be an array of strings.`);
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
}
