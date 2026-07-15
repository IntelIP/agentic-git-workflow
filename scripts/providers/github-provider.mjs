const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const FAILURE_STATES = new Set(["error", "failure", "failed"]);
const PENDING_STATES = new Set(["pending", "queued", "running", "in_progress"]);
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export class GitHubProvider {
  #token;

  constructor({ baseUrl = DEFAULT_BASE_URL, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    requiredString(token, "token");
    positiveInteger(timeoutMs, "timeoutMs");
    requiredFunction(fetchImpl, "fetchImpl");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async repository({ owner, repo }) {
    return normalizeRepository(await this.#request(repoPath(owner, repo)));
  }

  async listChangeRequests({ owner, repo, state = "open" }) {
    requiredEnum(state, ["open", "closed", "all"], "state", TypeError);
    const values = await this.#paginate(`${repoPath(owner, repo)}/pulls`, { state });
    return values.map(normalizeChangeRequest);
  }

  async changeRequest({ owner, repo, number }) {
    positiveInteger(number, "number");
    return normalizeChangeRequest(await this.#request(`${repoPath(owner, repo)}/pulls/${number}`));
  }

  async listReviews({ owner, repo, number }) {
    positiveInteger(number, "number");
    const values = await this.#paginate(`${repoPath(owner, repo)}/pulls/${number}/reviews`);
    return values.map(normalizeReview);
  }

  async listReviewComments({ owner, repo, number }) {
    positiveInteger(number, "number");
    const values = await this.#paginate(`${repoPath(owner, repo)}/pulls/${number}/comments`);
    return values.map(normalizeReviewComment).sort(compareByCreatedAtThenId);
  }

  async listIssueComments({ owner, repo, number }) {
    positiveInteger(number, "number");
    const values = await this.#paginate(`${repoPath(owner, repo)}/issues/${number}/comments`);
    return values.map(normalizeIssueComment).sort(compareByCreatedAtThenId);
  }

  async commitStatus({ owner, repo, commit }) {
    requiredString(commit, "commit");
    const encodedCommit = encodeURIComponent(commit);
    const [combinedStatus, checkRuns] = await Promise.all([
      this.#request(`${repoPath(owner, repo)}/commits/${encodedCommit}/status`),
      this.#paginateObject(`${repoPath(owner, repo)}/commits/${encodedCommit}/check-runs`, "check_runs"),
    ]);
    return normalizeCommitStatus(combinedStatus, checkRuns, commit);
  }

  async #paginate(path, query = {}) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await this.#request(path, { ...query, page, per_page: DEFAULT_PAGE_LIMIT });
      requiredArray(batch, path);
      values.push(...batch);
      if (batch.length < DEFAULT_PAGE_LIMIT) return values;
    }
    throw new GitHubResponseError(`${path} exceeded the ${MAX_PAGES}-page safety limit.`);
  }

  async #paginateObject(path, key) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = requiredObject(await this.#request(path, { page, per_page: DEFAULT_PAGE_LIMIT }), path);
      const batch = response[key];
      requiredArray(batch, `${path}.${key}`);
      values.push(...batch);
      if (batch.length < DEFAULT_PAGE_LIMIT) return values;
    }
    throw new GitHubResponseError(`${path}.${key} exceeded the ${MAX_PAGES}-page safety limit.`);
  }

  async #request(path, query = {}) {
    const url = buildUrl(this.baseUrl, path, query);
    const response = await fetchWithTimeout({
      fetchImpl: this.fetchImpl,
      url,
      token: this.#token,
      timeoutMs: this.timeoutMs,
    });
    const body = await response.text();
    if (!response.ok) throw httpError(response.status, url, body, this.#token);
    return parseResponseBody(body, url);
  }
}

export class GitHubHttpError extends Error {
  constructor({ status, method, url, body }) {
    super(`${method} ${url} failed with HTTP ${status}${body ? `: ${body.slice(0, 500)}` : "."}`);
    this.name = "GitHubHttpError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

class GitHubResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubResponseError";
  }
}

function normalizeRepository(value) {
  const repository = requiredObject(value, "repository");
  const owner = requiredObject(repository.owner, "repository.owner");
  return {
    id: String(requiredInteger(repository.id, "repository.id")),
    owner: requiredValue(owner.login, "repository.owner.login"),
    name: requiredValue(repository.name, "repository.name"),
    fullName: requiredValue(repository.full_name, "repository.full_name"),
    private: repository.private === true,
    archived: repository.archived === true,
    defaultBranch: nullableString(repository.default_branch),
    webUrl: requiredHttpUrl(repository.html_url, "repository.html_url"),
    cloneUrl: requiredHttpUrl(repository.clone_url, "repository.clone_url"),
  };
}

function normalizeChangeRequest(value) {
  const changeRequest = requiredObject(value, "changeRequest");
  return {
    id: String(requiredInteger(changeRequest.id, "changeRequest.id")),
    number: requiredInteger(changeRequest.number, "changeRequest.number"),
    title: requiredValue(changeRequest.title, "changeRequest.title"),
    state: changeRequestState(changeRequest),
    draft: changeRequest.draft === true,
    mergeable: nullableBoolean(changeRequest.mergeable),
    source: normalizeBranch(changeRequest.head, "changeRequest.head"),
    target: normalizeBranch(changeRequest.base, "changeRequest.base"),
    author: nullableLogin(changeRequest.user, "changeRequest.user"),
    webUrl: requiredHttpUrl(changeRequest.html_url, "changeRequest.html_url"),
    createdAt: requiredDate(changeRequest.created_at, "changeRequest.created_at"),
    updatedAt: requiredDate(changeRequest.updated_at, "changeRequest.updated_at"),
  };
}

function changeRequestState(value) {
  if (value.merged === true) return "merged";
  if (!isEmptyOptional(value.merged_at)) return "merged";
  return requiredEnum(value.state, ["open", "closed"], "changeRequest.state");
}

function normalizeBranch(value, path) {
  const branch = requiredObject(value, path);
  return {
    branch: requiredValue(branch.ref, `${path}.ref`),
    commit: requiredValue(branch.sha, `${path}.sha`),
  };
}

function normalizeReview(value) {
  const review = requiredObject(value, "review");
  const state = requiredValue(review.state, "review.state").toLowerCase();
  const submittedAt = nullableDate(review.submitted_at, "review.submitted_at");
  return {
    id: String(requiredInteger(review.id, "review.id")),
    state,
    body: optionalText(review.body),
    commit: nullableString(review.commit_id),
    dismissed: state === "dismissed",
    stale: false,
    author: nullableLogin(review.user, "review.user"),
    submittedAt,
    updatedAt: submittedAt,
    webUrl: nullableHttpUrl(review.html_url, "review.html_url"),
  };
}

function normalizeReviewComment(value) {
  const comment = requiredObject(value, "reviewComment");
  return {
    id: String(requiredInteger(comment.id, "reviewComment.id")),
    reviewId: String(requiredInteger(comment.pull_request_review_id, "reviewComment.pull_request_review_id")),
    body: optionalText(comment.body),
    path: nullableString(comment.path),
    line: firstInteger(comment.line, comment.original_line, comment.position),
    commit: nullableString(firstPresent(comment.commit_id, comment.original_commit_id)),
    author: nullableLogin(comment.user, "reviewComment.user"),
    resolvedBy: null,
    createdAt: requiredDate(comment.created_at, "reviewComment.created_at"),
    updatedAt: requiredDate(comment.updated_at, "reviewComment.updated_at"),
    webUrl: nullableHttpUrl(comment.html_url, "reviewComment.html_url"),
  };
}

function normalizeIssueComment(value) {
  const comment = requiredObject(value, "issueComment");
  return {
    id: String(requiredInteger(comment.id, "issueComment.id")),
    body: optionalText(comment.body),
    author: nullableLogin(comment.user, "issueComment.user"),
    createdAt: requiredDate(comment.created_at, "issueComment.created_at"),
    updatedAt: requiredDate(comment.updated_at, "issueComment.updated_at"),
    webUrl: nullableHttpUrl(comment.html_url, "issueComment.html_url"),
  };
}

function normalizeCommitStatus(value, checkRuns, requestedCommit) {
  const response = requiredObject(value, "commitStatus");
  const statuses = optionalArray(response.statuses, "commitStatus.statuses").map(normalizeStatus);
  const checks = checkRuns.map(normalizeCheckRun);
  const combined = [...statuses, ...checks];
  return {
    commit: nullableString(response.sha) ?? requestedCommit,
    state: combinedState(combined),
    total: combined.length,
    statuses: combined,
  };
}

function combinedState(statuses) {
  if (statuses.length === 0) return "none";
  const states = new Set(statuses.map((status) => status.state));
  if (setsOverlap(states, FAILURE_STATES)) return "failure";
  if (setsOverlap(states, PENDING_STATES)) return "pending";
  return "success";
}

function setsOverlap(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function normalizeStatus(value) {
  const status = requiredObject(value, "commitStatus.status");
  return {
    id: `status:${requiredInteger(status.id, "commitStatus.status.id")}`,
    context: requiredValue(status.context, "commitStatus.status.context"),
    state: requiredValue(status.state, "commitStatus.status.state").toLowerCase(),
    description: nullableString(status.description),
    targetUrl: nullableHttpUrl(status.target_url, "commitStatus.status.target_url"),
    createdAt: nullableDate(status.created_at, "commitStatus.status.created_at"),
    updatedAt: nullableDate(status.updated_at, "commitStatus.status.updated_at"),
  };
}

function normalizeCheckRun(value) {
  const checkRun = requiredObject(value, "checkRun");
  const output = optionalObject(checkRun.output, "checkRun.output");
  const status = requiredValue(checkRun.status, "checkRun.status").toLowerCase();
  const conclusion = nullableLowercase(checkRun.conclusion);
  return {
    id: `check-run:${requiredInteger(checkRun.id, "checkRun.id")}`,
    context: requiredValue(checkRun.name, "checkRun.name"),
    state: checkRunState(status, conclusion),
    description: firstString(output.title, conclusion, status),
    targetUrl: nullableHttpUrl(firstPresent(checkRun.details_url, checkRun.html_url), "checkRun.details_url"),
    createdAt: nullableDate(checkRun.started_at, "checkRun.started_at"),
    updatedAt: nullableDate(firstPresent(checkRun.completed_at, checkRun.started_at), "checkRun.completed_at"),
  };
}

function checkRunState(status, conclusion) {
  if (status !== "completed") return "pending";
  return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion) ? "success" : "failure";
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

async function fetchWithTimeout({ fetchImpl, url, token, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: githubHeaders(token),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new GitHubResponseError(`GET ${url} timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function httpError(status, url, body, token) {
  return new GitHubHttpError({
    status,
    method: "GET",
    url: url.toString(),
    body: redact(body, token),
  });
}

function parseResponseBody(body, url) {
  if (body.trim() === "") return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new GitHubResponseError(`GET ${url} returned invalid JSON.`);
  }
}

function normalizeBaseUrl(value) {
  requiredString(value, "baseUrl");
  if (!URL.canParse(value)) throw new TypeError("baseUrl must be an absolute URL.");
  const parsed = new URL(value);
  requireSecureApiUrl(parsed);
  rejectCredentials(parsed);
  rejectQueryAndFragment(parsed);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function requireSecureApiUrl(url) {
  if (url.protocol === "https:") return;
  if (LOCAL_HOSTS.has(url.hostname)) return;
  throw new TypeError("baseUrl must use HTTPS unless it targets localhost.");
}

function rejectCredentials(url) {
  if (url.username) throw new TypeError("baseUrl must not contain credentials.");
  if (url.password) throw new TypeError("baseUrl must not contain credentials.");
}

function rejectQueryAndFragment(url) {
  if (url.search) throw new TypeError("baseUrl must not contain a query or fragment.");
  if (url.hash) throw new TypeError("baseUrl must not contain a query or fragment.");
}

function repoPath(owner, repo) {
  requiredString(owner, "owner");
  requiredString(repo, "repo");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function compareByCreatedAtThenId(left, right) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function redact(value, token) {
  return String(value).split(token).join("[REDACTED]");
}

function firstInteger(...values) {
  return values.find((value) => Number.isInteger(value)) ?? null;
}

function firstPresent(value, fallback) {
  return isEmptyOptional(value) ? fallback : value;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = nullableString(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function optionalText(value) {
  return typeof value === "string" ? value : "";
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function nullableLowercase(value) {
  const normalized = nullableString(value);
  return normalized === null ? null : normalized.toLowerCase();
}

function nullableLogin(value, path) {
  if (isEmptyOptional(value)) return null;
  return nullableString(requiredObject(value, path).login);
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
}

function requiredValue(value, path) {
  requiredString(value, path);
  return value;
}

function requiredFunction(value, path) {
  if (typeof value !== "function") throw new TypeError(`${path} must be a function.`);
}

function requiredInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new GitHubResponseError(`${path} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer.`);
}

function requiredEnum(value, values, path, ErrorType = GitHubResponseError) {
  if (!values.includes(value)) throw new ErrorType(`${path} must be ${values.join(" or ")}.`);
  return value;
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubResponseError(`${path} must be an object.`);
  }
  return value;
}

function optionalObject(value, path) {
  if (isEmptyOptional(value)) return {};
  return requiredObject(value, path);
}

function requiredArray(value, path) {
  if (!Array.isArray(value)) throw new GitHubResponseError(`${path} must be an array.`);
  return value;
}

function optionalArray(value, path) {
  if (isEmptyOptional(value)) return [];
  return requiredArray(value, path);
}

function isEmptyOptional(value) {
  return value === undefined || value === null || value === "";
}

function nullableString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function requiredDate(value, path) {
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new GitHubResponseError(`${path} must be an ISO date-time.`);
  return value;
}

function nullableDate(value, path) {
  if (isEmptyOptional(value)) return null;
  return requiredDate(value, path);
}

function requiredHttpUrl(value, path) {
  if (isEmptyOptional(value)) throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  return parseHttpUrl(value, path);
}

function nullableHttpUrl(value, path) {
  if (isEmptyOptional(value)) return null;
  return parseHttpUrl(value, path);
}

function parseHttpUrl(value, path) {
  if (!URL.canParse(value)) throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  return value;
}
