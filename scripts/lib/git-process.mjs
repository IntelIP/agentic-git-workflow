import { execFile, spawn } from "node:child_process";

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

export async function withPreparedRefUpdate({
  cwd,
  gitDir,
  ref,
  newCommit,
  expectedOldCommit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}, apply) {
  if (typeof apply !== "function") throw new TypeError("apply must be a function.");
  for (const [name, value] of Object.entries({ ref, newCommit, expectedOldCommit })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new TypeError(`${name} must be a non-empty single-line string.`);
    }
  }
  const args = [
    ...(gitDir ? [`--git-dir=${gitDir}`] : []),
    "update-ref",
    "--stdin",
    "-m",
    "tabellio: fast-forward validated agent run",
  ];
  const child = spawn("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let prepared = false;
  let prepareResolve;
  let prepareReject;
  const preparePromise = new Promise((resolve, reject) => {
    prepareResolve = resolve;
    prepareReject = reject;
  });
  const completion = new Promise((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!prepared && stdout.includes("prepare: ok\n")) {
      prepared = true;
      prepareResolve();
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.once("error", (error) => {
    if (!prepared) prepareReject(error);
  });
  child.once("close", (exitCode, signal) => {
    if (!prepared) {
      prepareReject(new GitCommandError({ args, cwd, exitCode, signal, stdout, stderr }));
    }
  });

  const commands = [
    "start",
    `update ${ref} ${newCommit} ${expectedOldCommit}`,
    "prepare",
  ];
  child.stdin.write(`${commands.join("\n")}\n`);

  try {
    await preparePromise;
    try {
      await apply();
    } catch (error) {
      child.stdin.end("abort\n");
      await completion;
      throw error;
    }
    child.stdin.end("commit\n");
    const { exitCode, signal } = await completion;
    if (exitCode !== 0) {
      throw new GitCommandError({ args, cwd, exitCode, signal, stdout, stderr });
    }
    return { args, cwd, exitCode, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
