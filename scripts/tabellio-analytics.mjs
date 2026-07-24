#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
