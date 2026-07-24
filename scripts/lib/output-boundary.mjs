import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function assertOutputBoundary({
  outputs,
  protectedInputs = [],
  duplicatePathMessage,
  symbolicLinkMessage,
  outputAliasMessage,
  inputAliasMessage,
}) {
  const targets = outputs.map((target) => resolve(target));
  const inputTargets = protectedInputs.map((target) => resolve(target));
  assertUniqueOutputPaths(targets, duplicatePathMessage);
  assertNoProtectedPathMatches(targets, inputTargets, inputAliasMessage);
  await Promise.all(targets.map((target) => mkdir(dirname(target), { recursive: true })));
  const outputIdentities = await Promise.all(targets.map(outputIdentity));
  assertNoSymbolicLinks(outputIdentities, symbolicLinkMessage);
  assertNoIdentityCollision(outputIdentities, outputAliasMessage);
  const inputIdentities = await Promise.all(
    inputTargets.map((target) => optionalExistingIdentity(target)),
  );
  assertNoInputIdentityCollision(outputIdentities, inputIdentities, inputAliasMessage);
}

function assertUniqueOutputPaths(targets, message) {
  if (new Set(targets).size !== targets.length) throw new Error(message);
}

function assertNoProtectedPathMatches(outputs, inputs, message) {
  if (outputs.some((target) => inputs.includes(target))) throw new Error(message);
}

function assertNoSymbolicLinks(identities, message) {
  if (identities.some((identity) => identity.symbolicLink)) throw new Error(message);
}

function assertNoIdentityCollision(identities, message) {
  if (hasIdentityCollision(identities)) throw new Error(message);
}

function assertNoInputIdentityCollision(outputs, inputs, message) {
  const aliasesInput = outputs.some((output) =>
    inputs.some((input) => input !== null && sameIdentity(output, input))
  );
  if (aliasesInput) throw new Error(message);
}

async function outputIdentity(target) {
  const entry = await optionalFilesystemEntry(() => lstat(target));
  if (entry?.isSymbolicLink()) {
    return { canonicalPath: null, inode: null, symbolicLink: true };
  }
  if (!entry) {
    return {
      canonicalPath: join(await realpath(dirname(target)), basename(target)),
      inode: null,
      symbolicLink: false,
    };
  }
  return existingIdentity(target);
}

async function existingIdentity(target) {
  const metadata = await stat(target);
  return {
    canonicalPath: await realpath(target),
    inode: `${metadata.dev}:${metadata.ino}`,
    symbolicLink: false,
  };
}

async function optionalExistingIdentity(target) {
  try {
    return await existingIdentity(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function hasIdentityCollision(identities) {
  return identities.some((identity, index) =>
    identities.slice(index + 1).some((candidate) => sameIdentity(identity, candidate))
  );
}

function sameIdentity(left, right) {
  if (left.canonicalPath === right.canonicalPath) return true;
  return left.inode !== null && left.inode === right.inode;
}

async function optionalFilesystemEntry(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
