#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const prompt = process.argv.slice(2).join(" ");
if (/username/i.test(prompt)) {
  const username = process.env.TABELLIO_GIT_USERNAME?.trim();
  if (!username) process.exitCode = 1;
  else process.stdout.write(`${username}\n`);
} else if (/password/i.test(prompt)) {
  const tokenFile = process.env.TABELLIO_GIT_TOKEN_FILE;
  if (!tokenFile) process.exitCode = 1;
  else {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!token) process.exitCode = 1;
    else process.stdout.write(`${token}\n`);
  }
} else {
  process.exitCode = 1;
}
