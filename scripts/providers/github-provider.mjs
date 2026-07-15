import { ChangeRequestProvider } from "../lib/change-request-provider.mjs";

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGES = 10;

export class GitHubProvider extends ChangeRequestProvider {
  #token;

  constructor({ baseUrl = DEFAULT_BASE_URL, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    super();
    requiredString(baseUrl, "baseUrl");
    requiredString(token, "token");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer.");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new TypeError("baseUrl must use HTTPS unless it targets localhost.");
    }
    if (parsed.username || parsed.password) throw new TypeError("baseUrl must not contain credentials.");
    if (parsed.search || parsed.hash) throw new TypeError("baseUrl must not contain a query or fragment.");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async repository({ owner, repo }) {
    return normalizeRepository(await this.#request(repoPath(owner, repo)));
  }

  async listChangeRequests({ owner, repo, state = "open" }) {
    if (!["open", "closed", "all"].includes(state)) throw new TypeError("state must be open, closed, or all.");
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
    const [combinedStatus, checkRuns] = await Promise.all([
      this.#request(`${repoPath(owner, repo)}/commits/${encodeURIComponent(commit)}/status`),
      this.#paginateObject(`${repoPath(owner, repo)}/commits/${encodeURIComponent(commit)}/check-runs`, "check_runs"),
    ]);
    return normalizeCommitStatus(combinedStatus, checkRuns, commit);
  }

  async #paginate(path, query = {}) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await this.#request(path, { ...query, page, per_page: DEFAULT_PAGE_LIMIT });
      if (!Array.isArray(batch)) throw new GitHubResponseError(`${path} must return an array.`);
      values.push(...batch);
      if (batch.length < DEFAULT_PAGE_LIMIT) return values;
    }
    throw new GitHubResponseError(`${path} exceeded the ${MAX_PAGES}-page safety limit.`);
  }

  async #paginateObject(path, key) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.#request(path, { page, per_page: DEFAULT_PAGE_LIMIT });
      const batch = response?.[key];
      if (!Array.isArray(batch)) throw new GitHubResponseError(`${path}.${key} must be an array.`);
      values.push(...batch);
      if (batch.length < DEFAULT_PAGE_LIMIT) return values;
    }
    throw new GitHubResponseError(`${path}.${key} exceeded the ${MAX_PAGES}-page safety limit.`);
  }

  async #request(path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new GitHubHttpError({
          status: response.status,
          method: "GET",
          url: url.toString(),
          body: redact(body, this.#token),
        });
      }
      if (body.trim() === "") return null;
      try {
        return JSON.parse(body);
      } catch {
        throw new GitHubResponseError(`GET ${url} returned invalid JSON.`);
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new GitHubResponseError(`GET ${url} timed out after ${this.timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
  return {
    id: String(requiredInteger(value?.id, "repository.id")),
    owner: requiredValue(value?.owner?.login, "repository.owner.login"),
    name: requiredValue(value?.name, "repository.name"),
    fullName: requiredValue(value?.full_name, "repository.full_name"),
    private: value?.private === true,
    archived: value?.archived === true,
    defaultBranch: nullableString(value?.default_branch),
    webUrl: requiredHttpUrl(value?.html_url, "repository.html_url"),
    cloneUrl: requiredHttpUrl(value?.clone_url, "repository.clone_url"),
  };
}

function normalizeChangeRequest(value) {
  const merged = value?.merged === true || value?.merged_at !== null && value?.merged_at !== undefined;
  return {
    id: String(requiredInteger(value?.id, "changeRequest.id")),
    number: requiredInteger(value?.number, "changeRequest.number"),
    title: requiredValue(value?.title, "changeRequest.title"),
    state: merged ? "merged" : requiredEnum(value?.state, ["open", "closed"], "changeRequest.state"),
    draft: value?.draft === true,
    mergeable: typeof value?.mergeable === "boolean" ? value.mergeable : null,
    source: normalizeBranch(value?.head, "changeRequest.head"),
    target: normalizeBranch(value?.base, "changeRequest.base"),
    author: nullableString(value?.user?.login),
    webUrl: requiredHttpUrl(value?.html_url, "changeRequest.html_url"),
    createdAt: requiredDate(value?.created_at, "changeRequest.created_at"),
    updatedAt: requiredDate(value?.updated_at, "changeRequest.updated_at"),
  };
}

function normalizeBranch(value, path) {
  return {
    branch: requiredValue(value?.ref, `${path}.ref`),
    commit: requiredValue(value?.sha, `${path}.sha`),
  };
}

function normalizeReview(value) {
  const state = requiredValue(value?.state, "review.state").toLowerCase();
  const submittedAt = nullableDate(value?.submitted_at, "review.submitted_at");
  return {
    id: String(requiredInteger(value?.id, "review.id")),
    state,
    body: typeof value?.body === "string" ? value.body : "",
    commit: nullableString(value?.commit_id),
    dismissed: state === "dismissed",
    stale: false,
    author: nullableString(value?.user?.login),
    submittedAt,
    updatedAt: submittedAt,
    webUrl: nullableHttpUrl(value?.html_url, "review.html_url"),
  };
}

function normalizeReviewComment(value) {
  return {
    id: String(requiredInteger(value?.id, "reviewComment.id")),
    reviewId: String(requiredInteger(value?.pull_request_review_id, "reviewComment.pull_request_review_id")),
    body: typeof value?.body === "string" ? value.body : "",
    path: nullableString(value?.path),
    line: firstInteger(value?.line, value?.original_line, value?.position),
    commit: nullableString(value?.commit_id ?? value?.original_commit_id),
    author: nullableString(value?.user?.login),
    resolvedBy: null,
    createdAt: requiredDate(value?.created_at, "reviewComment.created_at"),
    updatedAt: requiredDate(value?.updated_at, "reviewComment.updated_at"),
    webUrl: nullableHttpUrl(value?.html_url, "reviewComment.html_url"),
  };
}

function normalizeIssueComment(value) {
  return {
    id: String(requiredInteger(value?.id, "issueComment.id")),
    body: typeof value?.body === "string" ? value.body : "",
    author: nullableString(value?.user?.login),
    createdAt: requiredDate(value?.created_at, "issueComment.created_at"),
    updatedAt: requiredDate(value?.updated_at, "issueComment.updated_at"),
    webUrl: nullableHttpUrl(value?.html_url, "issueComment.html_url"),
  };
}

function normalizeCommitStatus(value, checkRuns, requestedCommit) {
  const statuses = Array.isArray(value?.statuses) ? value.statuses.map(normalizeStatus) : [];
  const checks = checkRuns.map(normalizeCheckRun);
  const combined = [...statuses, ...checks];
  let state = combined.length === 0 ? "none" : "success";
  if (combined.some((status) => ["error", "failure", "failed"].includes(status.state))) state = "failure";
  else if (combined.some((status) => ["pending", "queued", "running", "in_progress"].includes(status.state))) state = "pending";
  return {
    commit: nullableString(value?.sha) ?? requestedCommit,
    state,
    total: combined.length,
    statuses: combined,
  };
}

function normalizeStatus(value) {
  return {
    id: `status:${requiredInteger(value?.id, "commitStatus.status.id")}`,
    context: requiredValue(value?.context, "commitStatus.status.context"),
    state: requiredValue(value?.state, "commitStatus.status.state").toLowerCase(),
    description: nullableString(value?.description),
    targetUrl: nullableHttpUrl(value?.target_url, "commitStatus.status.target_url"),
    createdAt: nullableDate(value?.created_at, "commitStatus.status.created_at"),
    updatedAt: nullableDate(value?.updated_at, "commitStatus.status.updated_at"),
  };
}

function normalizeCheckRun(value) {
  const status = requiredValue(value?.status, "checkRun.status").toLowerCase();
  const conclusion = nullableString(value?.conclusion)?.toLowerCase() ?? null;
  let state = "pending";
  if (status === "completed") {
    state = ["success", "neutral", "skipped"].includes(conclusion) ? "success" : "failure";
  }
  return {
    id: `check-run:${requiredInteger(value?.id, "checkRun.id")}`,
    context: requiredValue(value?.name, "checkRun.name"),
    state,
    description: nullableString(value?.output?.title) ?? conclusion ?? status,
    targetUrl: nullableHttpUrl(value?.details_url ?? value?.html_url, "checkRun.details_url"),
    createdAt: nullableDate(value?.started_at, "checkRun.started_at"),
    updatedAt: nullableDate(value?.completed_at ?? value?.started_at, "checkRun.completed_at"),
  };
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

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
}

function requiredValue(value, path) {
  requiredString(value, path);
  return value;
}

function requiredInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new GitHubResponseError(`${path} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer.`);
}

function requiredEnum(value, values, path) {
  if (!values.includes(value)) throw new GitHubResponseError(`${path} must be ${values.join(" or ")}.`);
  return value;
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
  if (value === undefined || value === null || value === "") return null;
  return requiredDate(value, path);
}

function requiredHttpUrl(value, path) {
  const normalized = nullableHttpUrl(value, path);
  if (normalized === null) throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  return normalized;
}

function nullableHttpUrl(value, path) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new GitHubResponseError(`${path} must be an absolute HTTP URL.`);
  return value;
}
