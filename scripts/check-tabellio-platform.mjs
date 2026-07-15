#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validatePlatformConfig } from "./lib/platform-config.mjs";

const path = resolve(process.argv[2] ?? "tabellio.platform.json");
try {
  if (process.argv.length > 3) throw new Error("Usage: check-tabellio-platform [path].");
  const config = JSON.parse(await readFile(path, "utf8"));
  validatePlatformConfig(config);
  console.log(JSON.stringify({
    ok: true,
    status: "platform_ready",
    path,
    codeStorage: config.codeStorage.provider,
    codeRemote: config.codeStorage.remoteName,
    publicSurface: config.codeStorage.publicSurface,
    controlState: config.workflow.controlState,
    controlProvider: config.workflow.controlProvider,
    controlRemote: config.workflow.controlRemoteName,
    publishesControlRefsToCodeStorage: config.workflow.publishControlRefsToCodeStorage,
  }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ ok: false, status: "blocked", path, error: error instanceof Error ? error.message : String(error) }, null, 2));
}
