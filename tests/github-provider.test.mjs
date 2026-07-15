import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  GitHubHttpError,
  GitHubProvider,
} from "../scripts/providers/github-provider.mjs";

const timestamp = "2026-07-10T20:00:00Z";
const commit = "a".repeat(40);

test("GitHub provider normalizes repositories, pull requests, reviews, comments, statuses, and checks", async (t) => {
  const requests = [];
  const fixture = await startServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const baseUrl = `http://${request.headers.host}`;
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
      accept: request.headers.accept,
    });
    const route = githubFixtureRoutes(baseUrl).get(url.pathname);
    return route ? json(response, route()) : json(response, { message: "not found" }, 404);
  });
  t.after(fixture.close);

  const provider = new GitHubProvider({ baseUrl: fixture.baseUrl, token: "secret-token" });
  assert.ok(!JSON.stringify(provider).includes("secret-token"));
  assert.deepEqual(await provider.repository({ owner: "acme", repo: "project" }), {
    id: "11",
    owner: "acme",
    name: "project",
    fullName: "acme/project",
    private: true,
    archived: false,
    defaultBranch: "main",
    webUrl: `${fixture.baseUrl}/acme/project`,
    cloneUrl: `${fixture.baseUrl}/acme/project.git`,
  });
  const pulls = await provider.listChangeRequests({ owner: "acme", repo: "project" });
  assert.equal(pulls.length, 1);
  assert.deepEqual(pulls[0], {
    id: "21",
    number: 7,
    title: "Agent change",
    state: "open",
    draft: false,
    mergeable: true,
    source: { branch: "agent/change", commit },
    target: { branch: "main", commit: "b".repeat(40) },
    author: "agent",
    webUrl: `${fixture.baseUrl}/acme/project/pull/7`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  assert.deepEqual(await provider.changeRequest({ owner: "acme", repo: "project", number: 7 }), pulls[0]);
  assert.deepEqual(await provider.listReviews({ owner: "acme", repo: "project", number: 7 }), [{
    id: "31",
    state: "approved",
    body: "Looks good.",
    commit,
    dismissed: false,
    stale: false,
    author: "reviewer",
    submittedAt: timestamp,
    updatedAt: timestamp,
    webUrl: `${fixture.baseUrl}/acme/project/pull/7#pullrequestreview-31`,
  }]);
  assert.equal((await provider.listReviewComments({ owner: "acme", repo: "project", number: 7 }))[0].path, "src/index.js");
  assert.equal((await provider.listIssueComments({ owner: "acme", repo: "project", number: 7 }))[0].body, "Run the checks.");
  assert.deepEqual(await provider.commitStatus({ owner: "acme", repo: "project", commit }), {
    commit,
    state: "success",
    total: 2,
    statuses: [{
      id: "status:51",
      context: "tests",
      state: "success",
      description: "All statuses passed",
      targetUrl: `${fixture.baseUrl}/checks/51`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, {
      id: "check-run:61",
      context: "Tabellio Evidence",
      state: "success",
      description: "Evidence verified",
      targetUrl: `${fixture.baseUrl}/checks/61`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
  assert.ok(requests.every((request) => request.authorization === "Bearer secret-token"));
  assert.ok(requests.every((request) => request.accept === "application/vnd.github+json"));
  assert.equal(requests.find((request) => request.path.endsWith("/pulls")).query.per_page, "100");
});

test("GitHub provider enforces safe API URLs and redacts tokens from failures", async (t) => {
  assert.throws(
    () => new GitHubProvider({ baseUrl: "https://user:password@example.com", token: "token" }),
    /must not contain credentials/,
  );
  assert.throws(
    () => new GitHubProvider({ baseUrl: "http://example.com", token: "token" }),
    /must use HTTPS/,
  );
  const fixture = await startServer((_request, response) => json(response, { message: "bad secret-token" }, 500));
  t.after(fixture.close);
  const provider = new GitHubProvider({ baseUrl: fixture.baseUrl, token: "secret-token" });
  await assert.rejects(
    () => provider.repository({ owner: "acme", repo: "project" }),
    (error) => error instanceof GitHubHttpError
      && error.status === 500
      && !error.message.includes("secret-token")
      && error.message.includes("[REDACTED]"),
  );
});

function repository(baseUrl) {
  return {
    id: 11,
    owner: { login: "acme" },
    name: "project",
    full_name: "acme/project",
    private: true,
    archived: false,
    default_branch: "main",
    html_url: `${baseUrl}/acme/project`,
    clone_url: `${baseUrl}/acme/project.git`,
  };
}

function pullRequest(baseUrl) {
  return {
    id: 21,
    number: 7,
    title: "Agent change",
    state: "open",
    merged: false,
    merged_at: null,
    draft: false,
    mergeable: true,
    head: { ref: "agent/change", sha: commit },
    base: { ref: "main", sha: "b".repeat(40) },
    user: { login: "agent" },
    html_url: `${baseUrl}/acme/project/pull/7`,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function review(baseUrl) {
  return {
    id: 31,
    state: "APPROVED",
    body: "Looks good.",
    commit_id: commit,
    user: { login: "reviewer" },
    submitted_at: timestamp,
    html_url: `${baseUrl}/acme/project/pull/7#pullrequestreview-31`,
  };
}

function reviewComment(baseUrl) {
  return {
    id: 41,
    pull_request_review_id: 31,
    body: "Prefer a constant.",
    path: "src/index.js",
    line: 4,
    commit_id: commit,
    user: { login: "reviewer" },
    created_at: timestamp,
    updated_at: timestamp,
    html_url: `${baseUrl}/acme/project/pull/7#discussion_r41`,
  };
}

function issueComment(baseUrl) {
  return {
    id: 42,
    body: "Run the checks.",
    user: { login: "reviewer" },
    created_at: timestamp,
    updated_at: timestamp,
    html_url: `${baseUrl}/acme/project/pull/7#issuecomment-42`,
  };
}

function combinedStatus(baseUrl) {
  return {
    sha: commit,
    state: "success",
    total_count: 1,
    statuses: [{
      id: 51,
      context: "tests",
      state: "success",
      description: "All statuses passed",
      target_url: `${baseUrl}/checks/51`,
      created_at: timestamp,
      updated_at: timestamp,
    }],
  };
}

function checkRuns(baseUrl) {
  return {
    total_count: 1,
    check_runs: [{
      id: 61,
      name: "Tabellio Evidence",
      status: "completed",
      conclusion: "success",
      output: { title: "Evidence verified" },
      details_url: `${baseUrl}/checks/61`,
      started_at: timestamp,
      completed_at: timestamp,
    }],
  };
}

function githubFixtureRoutes(baseUrl) {
  return new Map([
    ["/repos/acme/project", () => repository(baseUrl)],
    ["/repos/acme/project/pulls", () => [pullRequest(baseUrl)]],
    ["/repos/acme/project/pulls/7", () => pullRequest(baseUrl)],
    ["/repos/acme/project/pulls/7/reviews", () => [review(baseUrl)]],
    ["/repos/acme/project/pulls/7/comments", () => [reviewComment(baseUrl)]],
    ["/repos/acme/project/issues/7/comments", () => [issueComment(baseUrl)]],
    [`/repos/acme/project/commits/${commit}/status`, () => combinedStatus(baseUrl)],
    [`/repos/acme/project/commits/${commit}/check-runs`, () => checkRuns(baseUrl)],
  ]);
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
