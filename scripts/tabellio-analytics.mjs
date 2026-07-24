#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import {
  collectAnalyticsDataset,
  renderAnalyticsReport,
  validateAnalyticsDataset,
} from "./lib/analytics.mjs";

const allowed = {
  collect: ["config", "id", "observedAt", "since", "until", "out", "report"],
  check: ["dataset"],
};

try {
  const options = parseCommandOptions(process.argv.slice(2), allowed);
  if (options.command === "collect") {
    requireOptions(options, ["config", "id", "since", "until", "out", "report"], "collect");
    await assertDistinctOutputs(options.out, options.report);
    const config = JSON.parse(await readFile(resolve(options.config), "utf8"));
    const dataset = await collectAnalyticsDataset({
      id: options.id,
      repositories: config.repositories,
      observedAt: options.observedAt ?? new Date().toISOString(),
      since: options.since,
      until: options.until,
    });
    validateAnalyticsDataset(dataset);
    await writeOutput(options.out, `${JSON.stringify(dataset, null, 2)}\n`);
    await writeOutput(options.report, renderAnalyticsReport(dataset));
    console.log(JSON.stringify({
      ok: true,
      status: "analytics_baseline_ready",
      dataset: resolve(options.out),
      report: resolve(options.report),
      repositoryCount: dataset.repositories.length,
      digest: dataset.integrity.digest,
    }, null, 2));
  } else {
    requireOptions(options, ["dataset"], "check");
    const dataset = JSON.parse(await readFile(resolve(options.dataset), "utf8"));
    validateAnalyticsDataset(dataset);
    console.log(JSON.stringify({
      ok: true,
      status: "analytics_dataset_ready",
      dataset: resolve(options.dataset),
      repositoryCount: dataset.repositories.length,
      digest: dataset.integrity.digest,
    }, null, 2));
  }
} catch (error) {
  reportCliError(error);
}

async function writeOutput(path, content) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function assertDistinctOutputs(datasetPath, reportPath) {
  const targets = [datasetPath, reportPath].map((target) => resolve(target));
  assertDistinctPaths(targets);
  await Promise.all(targets.map((target) => mkdir(dirname(target), { recursive: true })));
  const identities = await Promise.all(targets.map(outputIdentity));
  assertNoSymbolicLinks(identities);
  if (outputsShareIdentity(identities)) {
    throw new Error("--out and --report must resolve to distinct files.");
  }
}

function assertDistinctPaths(targets) {
  if (targets[0] === targets[1]) {
    throw new Error("--out and --report must resolve to distinct paths.");
  }
}

function assertNoSymbolicLinks(identities) {
  if (identities.some((identity) => identity.symbolicLink)) {
    throw new Error("--out and --report must not be symbolic links.");
  }
}

function outputsShareIdentity([dataset, report]) {
  if (dataset.canonicalPath === report.canonicalPath) return true;
  if (dataset.inode === null) return false;
  return dataset.inode === report.inode;
}

async function outputIdentity(target) {
  const entry = await optionalFilesystemEntry(() => lstat(target));
  if (entry?.isSymbolicLink()) {
    return { canonicalPath: null, inode: null, symbolicLink: true };
  }
  if (!entry) return missingOutputIdentity(target);
  const metadata = await stat(target);
  return {
    canonicalPath: await realpath(target),
    inode: `${metadata.dev}:${metadata.ino}`,
    symbolicLink: false,
  };
}

async function missingOutputIdentity(target) {
  return {
    canonicalPath: join(await realpath(dirname(target)), basename(target)),
    inode: null,
    symbolicLink: false,
  };
}

async function optionalFilesystemEntry(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
