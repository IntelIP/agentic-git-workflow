const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export class GitHubStatusPublisher {
  #token;

  constructor({ baseUrl = DEFAULT_BASE_URL, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    requiredString(token, "token");
    positiveInteger(timeoutMs, "timeoutMs");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async publish({ owner, repo, commit, state, context, description, targetUrl = null }) {
    requiredSlug(owner, "owner");
    requiredSlug(repo, "repo");
    requiredOid(commit, "commit");
    requiredEnum(state, ["error", "failure", "pending", "success"], "state");
    requiredString(context, "context");
    requiredString(description, "description");
    if (description.length > 140) throw new TypeError("description must be at most 140 characters.");
    optionalHttpUrl(targetUrl, "targetUrl");
    const url = new URL(
      `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(commit)}`,
    );
    const body = {
      state,
      context,
      description,
      ...(targetUrl === null ? {} : { target_url: targetUrl }),
    };
    const response = await fetchWithTimeout({
      fetchImpl: this.fetchImpl,
      url,
      token: this.#token,
      timeoutMs: this.timeoutMs,
      body,
    });
    const source = await response.text();
    if (!response.ok) {
      throw new GitHubStatusPublishError({
        status: response.status,
        url: url.toString(),
        body: redact(source, this.#token),
      });
    }
    return normalizePublishedStatus(parseJson(source, url), commit);
  }
}

export class GitHubStatusPublishError extends Error {
  constructor({ status, url, body }) {
    super(`POST ${url} failed with HTTP ${status}${body ? `: ${body.slice(0, 500)}` : "."}`);
    this.name = "GitHubStatusPublishError";
    this.status = status;
    this.url = url;
  }
}

async function fetchWithTimeout({ fetchImpl, url, token, timeoutMs, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GitHubStatusPublishError({
        status: 0,
        url: url.toString(),
        body: `request timed out after ${timeoutMs}ms`,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePublishedStatus(value, commit) {
  requiredObject(value, "status");
  return {
    id: String(requiredInteger(value.id, "status.id")),
    commit: requiredOid(commit, "commit"),
    state: requiredEnum(value.state, ["error", "failure", "pending", "success"], "status.state"),
    context: requiredString(value.context, "status.context"),
    description: optionalString(value.description),
    targetUrl: optionalHttpUrl(value.target_url ?? null, "status.target_url"),
    createdAt: optionalDate(value.created_at, "status.created_at"),
    updatedAt: optionalDate(value.updated_at, "status.updated_at"),
  };
}

function normalizeBaseUrl(value) {
  const parsed = parseAbsoluteUrl(value, "baseUrl");
  requireAllowedApiEndpoint(parsed);
  requireCleanApiUrl(parsed);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function parseJson(value, url) {
  try {
    return JSON.parse(value);
  } catch {
    throw new GitHubStatusPublishError({ status: 0, url: url.toString(), body: "invalid JSON response" });
  }
}

function redact(value, token) {
  return typeof value === "string" ? value.split(token).join("[REDACTED]") : "";
}

function requiredObject(value, path) {
  if (Object.prototype.toString.call(value) !== "[object Object]") throw new TypeError(`${path} must be an object.`);
  return value;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function requiredSlug(value, path) {
  requiredString(value, path);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new TypeError(`${path} contains unsupported characters.`);
  if (value === "." || value === "..") throw new TypeError(`${path} must not be "." or "..".`);
}

function requiredOid(value, path) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new TypeError(`${path} must be a Git object ID.`);
  }
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer.`);
}

function requiredInteger(value, path) {
  if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer.`);
  return value;
}

function requiredEnum(value, values, path) {
  if (!values.includes(value)) throw new TypeError(`${path} must be one of: ${values.join(", ")}.`);
  return value;
}

function optionalHttpUrl(value, path) {
  if (emptyOptional(value)) return null;
  const parsed = parseAbsoluteUrl(value, path);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new TypeError(`${path} must be an absolute HTTP URL.`);
  requireNoCredentials(parsed, path);
  return value;
}

function optionalDate(value, path) {
  if (emptyOptional(value)) return null;
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${path} must be an ISO date-time.`);
  return value;
}

function parseAbsoluteUrl(value, path) {
  requiredString(value, path);
  if (!URL.canParse(value)) throw new TypeError(`${path} must be an absolute URL.`);
  return new URL(value);
}

function requireAllowedApiEndpoint(value) {
  if (!isGitHubCloud(value) && !isLoopbackTransport(value)) {
    throw new TypeError("baseUrl must target GitHub Cloud or loopback.");
  }
}

function isGitHubCloud(value) {
  return value.origin === DEFAULT_BASE_URL;
}

function isLoopbackTransport(value) {
  return LOCAL_HOSTS.has(value.hostname) && ["http:", "https:"].includes(value.protocol);
}

function requireCleanApiUrl(value) {
  requireNoCredentials(value, "baseUrl");
  if (`${value.search}${value.hash}` !== "") throw new TypeError("baseUrl must not contain a query or fragment.");
}

function requireNoCredentials(value, path) {
  if (`${value.username}${value.password}` !== "") throw new TypeError(`${path} must not contain credentials.`);
}

function emptyOptional(value) {
  return value === null || value === undefined || value === "";
}
