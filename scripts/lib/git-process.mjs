import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitCommandError extends Error {
  constructor({ args, cwd, exitCode, signal, stdout, stderr }) {
    const rendered = ["git", ...args].join(" ");
    super(`${rendered} failed with exit code ${exitCode ?? "unknown"}.`);
    this.name = "GitCommandError";
    this.command = rendered;
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function runGit({
  args,
  cwd = process.cwd(),
  gitDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  acceptableExitCodes = [0],
  env = {},
}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Git arguments must be an array of strings.");
  }

  const gitArgs = gitDir ? [`--git-dir=${gitDir}`, ...args] : args;

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      gitArgs,
      {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...env,
        },
      },
      (error, stdout = "", stderr = "") => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
        const result = {
          args: gitArgs,
          cwd,
          exitCode,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        };

        if (!error || (exitCode !== null && acceptableExitCodes.includes(exitCode))) {
          resolve(result);
          return;
        }

        reject(new GitCommandError(result));
      },
    );
  });
}
