import { ForgeProvider } from "../lib/forge-provider.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGES = 20;

export class ForgejoProvider extends ForgeProvider {
  #token;

  constructor({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    super();
    requiredString(baseUrl, "baseUrl");
    requiredString(token, "token");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer.");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new TypeError("baseUrl must use HTTP or HTTPS.");
    if (parsed.username || parsed.password) throw new TypeError("baseUrl must not contain credentials.");
    if (parsed.search || parsed.hash) throw new TypeError("baseUrl must not contain a query or fragment.");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async version() {
    const value = await this.#request("/api/v1/version");
    requiredString(value?.version, "Forgejo version");
    return value.version;
  }

  async repository({ owner, repo }) {
    const value = await this.#request(repoPath(owner, repo));
    return normalizeRepository(value);
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

  async listReviewComments({ owner, repo, number, reviews = null }) {
    const reviewList = reviews ?? await this.listReviews({ owner, repo, number });
    if (!Array.isArray(reviewList)) throw new TypeError("reviews must be an array when provided.");
    const comments = [];
    for (const review of reviewList) {
      const values = await this.#paginate(`${repoPath(owner, repo)}/pulls/${number}/reviews/${review.id}/comments`);
      comments.push(...values.map((value) => normalizeReviewComment(value, review.id)));
    }
    return comments.sort(compareByCreatedAtThenId);
  }

  async listIssueComments({ owner, repo, number }) {
    positiveInteger(number, "number");
    const values = await this.#paginate(`${repoPath(owner, repo)}/issues/${number}/comments`);
    return values.map(normalizeIssueComment).sort(compareByCreatedAtThenId);
  }

  async commitStatus({ owner, repo, commit }) {
    requiredString(commit, "commit");
    return normalizeCommitStatus(
      await this.#request(`${repoPath(owner, repo)}/commits/${encodeURIComponent(commit)}/status`),
      commit,
    );
  }

  async #paginate(path, query = {}) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await this.#request(path, { ...query, page, limit: DEFAULT_PAGE_LIMIT });
      if (!Array.isArray(batch)) throw new ForgejoResponseError(`${path} must return an array.`);
      values.push(...batch);
      if (batch.length < DEFAULT_PAGE_LIMIT) return values;
    }
    throw new ForgejoResponseError(`${path} exceeded the ${MAX_PAGES}-page safety limit.`);
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
          Accept: "application/json",
          Authorization: `token ${this.#token}`,
        },
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new ForgejoHttpError({
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
        throw new ForgejoResponseError(`GET ${url} returned invalid JSON.`);
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new ForgejoResponseError(`GET ${url} timed out after ${this.timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ForgejoHttpError extends Error {
  constructor({ status, method, url, body }) {
    super(`${method} ${url} failed with HTTP ${status}${body ? `: ${body.slice(0, 500)}` : "."}`);
    this.name = "ForgejoHttpError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

export class ForgejoResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ForgejoResponseError";
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
  const merged = value?.merged === true;
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
  return {
    id: String(requiredInteger(value?.id, "review.id")),
    state: requiredValue(value?.state, "review.state").toLowerCase(),
    body: typeof value?.body === "string" ? value.body : "",
    commit: nullableString(value?.commit_id),
    dismissed: value?.dismissed === true,
    stale: value?.stale === true,
    author: nullableString(value?.user?.login),
    submittedAt: nullableDate(value?.submitted_at, "review.submitted_at"),
    updatedAt: nullableDate(value?.updated_at, "review.updated_at"),
    webUrl: nullableHttpUrl(value?.html_url, "review.html_url"),
  };
}

function normalizeReviewComment(value, reviewId) {
  return {
    id: String(requiredInteger(value?.id, "reviewComment.id")),
    reviewId,
    body: typeof value?.body === "string" ? value.body : "",
    path: nullableString(value?.path),
    line: Number.isInteger(value?.position) ? value.position : null,
    commit: nullableString(value?.commit_id),
    author: nullableString(value?.user?.login),
    resolvedBy: nullableString(value?.resolver?.login),
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

function normalizeCommitStatus(value, requestedCommit) {
  const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
  return {
    commit: nullableString(value?.sha) ?? requestedCommit,
    state: nullableString(value?.state)?.toLowerCase() ?? "none",
    total: Number.isInteger(value?.total_count) ? value.total_count : statuses.length,
    statuses: statuses.map((status) => ({
      id: String(requiredInteger(status?.id, "commitStatus.status.id")),
      context: requiredValue(status?.context, "commitStatus.status.context"),
      state: requiredValue(status?.status, "commitStatus.status.status").toLowerCase(),
      description: nullableString(status?.description),
      targetUrl: nullableHttpUrl(status?.target_url, "commitStatus.status.target_url"),
      createdAt: nullableDate(status?.created_at, "commitStatus.status.created_at"),
      updatedAt: nullableDate(status?.updated_at, "commitStatus.status.updated_at"),
    })),
  };
}

function repoPath(owner, repo) {
  requiredString(owner, "owner");
  requiredString(repo, "repo");
  return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function compareByCreatedAtThenId(left, right) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function redact(value, token) {
  return String(value).split(token).join("[REDACTED]");
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string.`);
}

function requiredValue(value, path) {
  requiredString(value, path);
  return value;
}

function requiredInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) throw new ForgejoResponseError(`${path} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer.`);
}

function requiredEnum(value, values, path) {
  if (!values.includes(value)) throw new ForgejoResponseError(`${path} must be ${values.join(" or ")}.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function requiredDate(value, path) {
  requiredString(value, path);
  if (Number.isNaN(Date.parse(value))) throw new ForgejoResponseError(`${path} must be an ISO date-time.`);
  return value;
}

function nullableDate(value, path) {
  if (value === undefined || value === null || value === "") return null;
  return requiredDate(value, path);
}

function requiredHttpUrl(value, path) {
  const normalized = nullableHttpUrl(value, path);
  if (normalized === null) throw new ForgejoResponseError(`${path} must be an absolute HTTP URL.`);
  return normalized;
}

function nullableHttpUrl(value, path) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ForgejoResponseError(`${path} must be an absolute HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new ForgejoResponseError(`${path} must be an absolute HTTP URL.`);
  return value;
}
