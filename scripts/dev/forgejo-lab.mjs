#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composePath = resolve(projectRoot, "infra/forgejo/compose.yml");
const credentialsRoot = resolve(projectRoot, ".tabellio/forgejo/credentials");
const passwordPath = resolve(credentialsRoot, "admin-password");
const tokenPath = resolve(credentialsRoot, "admin-token");
const tokenScopesPath = resolve(credentialsRoot, "admin-token-scopes");
const tokenScopes = "write:repository,write:issue,write:user";
const baseUrl = "http://127.0.0.1:3300";
const container = "tabellio-forgejo";
const command = process.argv[2];

try {
  let result;
  if (command === "up") result = await up();
  else if (command === "down") result = await down();
  else if (command === "status") result = await status();
  else if (command === "bootstrap") result = await bootstrap();
  else if (command === "seed") result = await seed();
  else throw new Error("Expected command: up, down, status, bootstrap, or seed.");
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  }, null, 2));
}

async function up() {
  await run("docker", ["compose", "-f", composePath, "up", "-d"]);
  await waitForHealth();
  return { status: "running", baseUrl };
}

async function down() {
  await run("docker", ["compose", "-f", composePath, "down"]);
  return { status: "stopped" };
}

async function status() {
  const health = await fetch(`${baseUrl}/api/healthz`).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  })).catch(() => ({ ok: false, status: 0, body: "" }));
  const version = health.ok
    ? await fetch(`${baseUrl}/api/v1/version`).then(async (response) => response.ok ? response.json() : null)
    : null;
  return { status: health.ok ? "running" : "unavailable", baseUrl, health, version };
}

async function bootstrap() {
  await waitForHealth();
  await mkdir(credentialsRoot, { recursive: true, mode: 0o700 });
  await chmod(credentialsRoot, 0o700);
  const password = await readSecret(passwordPath).catch(async () => {
    const generated = randomBytes(24).toString("base64url");
    await writeSecret(passwordPath, generated);
    return generated;
  });
  const users = await forgejo(["admin", "user", "list", "--admin"]);
  if (!users.stdout.split(/\r?\n/).some((line) => line.includes("tabellio-admin"))) {
    await forgejo([
      "admin", "user", "create",
      "--username", "tabellio-admin",
      "--password", password,
      "--email", "tabellio@example.invalid",
      "--admin",
      "--must-change-password=false",
    ]);
  }
  const storedScopes = await readSecret(tokenScopesPath).catch(() => null);
  const token = storedScopes === tokenScopes ? await readSecret(tokenPath).catch(() => null) : null;
  const activeToken = token ?? await (async () => {
    const tokenResult = await forgejo([
      "admin", "user", "generate-access-token",
      "--username", "tabellio-admin",
      "--token-name", `tabellio-dev-${Date.now()}`,
      "--scopes", tokenScopes,
      "--raw",
    ]);
    const generated = tokenResult.stdout.trim();
    if (!generated) throw new Error("Forgejo did not return an access token.");
    await writeSecret(tokenPath, generated);
    await writeSecret(tokenScopesPath, tokenScopes);
    return generated;
  })();
  if (!activeToken) throw new Error("Forgejo access token is unavailable.");
  return {
    status: "bootstrapped",
    baseUrl,
    username: "tabellio-admin",
    passwordPath,
    tokenPath,
  };
}

async function seed() {
  await waitForHealth();
  const token = await readSecret(tokenPath);
  const owner = "tabellio-admin";
  const repo = "tabellio-lab";
  let repository = await apiRequest(token, `/api/v1/repos/${owner}/${repo}`, { expected: [200, 404] });
  if (repository.status === 404) {
    repository = await apiRequest(token, "/api/v1/user/repos", {
      method: "POST",
      body: {
        name: repo,
        private: true,
        auto_init: true,
        default_branch: "main",
        description: "Disposable Tabellio Forgejo provider fixture",
      },
      expected: [201],
    });
  }
  let pulls = await apiRequest(token, `/api/v1/repos/${owner}/${repo}/pulls?state=open`, { expected: [200] });
  if (!Array.isArray(pulls.value) || pulls.value.length === 0) {
    await apiRequest(token, `/api/v1/repos/${owner}/${repo}/contents/provider-proof.txt`, {
      method: "POST",
      body: {
        branch: "main",
        new_branch: "agent/provider-proof",
        message: "Add provider proof",
        content: Buffer.from("Forgejo provider proof\n", "utf8").toString("base64"),
      },
      expected: [201, 409],
    });
    await apiRequest(token, `/api/v1/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: {
        base: "main",
        head: "agent/provider-proof",
        title: "Prove Forgejo provider reads",
        body: "Disposable pull request for provider integration checks.",
      },
      expected: [201, 409],
    });
    pulls = await apiRequest(token, `/api/v1/repos/${owner}/${repo}/pulls?state=open`, { expected: [200] });
  }
  const pull = Array.isArray(pulls.value) ? pulls.value[0] : null;
  return {
    status: "seeded",
    owner,
    repo,
    repositoryUrl: repository.value?.html_url ?? `${baseUrl}/${owner}/${repo}`,
    changeRequest: pull ? { number: pull.number, url: pull.html_url } : null,
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await fetch(`${baseUrl}/api/healthz`).then((response) => response.ok).catch(() => false);
    if (ready) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Forgejo did not become healthy at ${baseUrl}.`);
}

function forgejo(args) {
  return run("docker", ["exec", "-u", "git", container, "forgejo", ...args]);
}

async function apiRequest(token, path, { method = "GET", body, expected = [200] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `token ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  if (text.trim() !== "") {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (!expected.includes(response.status)) {
    const safeBody = String(text).split(token).join("[REDACTED]").slice(0, 500);
    throw new Error(`${method} ${path} failed with HTTP ${response.status}${safeBody ? `: ${safeBody}` : "."}`);
  }
  return { status: response.status, value };
}

function run(binary, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(binary, args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout = "", stderr = "") => {
      if (!error) resolvePromise({ stdout, stderr });
      else reject(new Error(`${binary} failed: ${stderr.trim() || error.message}`));
    });
  });
}

async function readSecret(path) {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

async function writeSecret(path, value) {
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
