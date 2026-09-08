import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  parseOwnerArchiveRelocationRecipe,
  type OwnerArchiveRelocationRecipe,
} from "./archiveRelocationRecipe.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECIPE_BYTES = 2 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type FileSnapshot = Readonly<{
  text: string;
  sha256: string;
  device: number;
  inode: number;
  links: number;
}>;

export class ArchiveRelocationRecipeStoreError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unsafe_store" | "recipe_conflict" | "recipe_missing",
  ) {
    super(`Archive relocation recipe store failed: ${code}`);
    this.name = "ArchiveRelocationRecipeStoreError";
  }
}

function fail(code: ArchiveRelocationRecipeStoreError["code"]): never {
  throw new ArchiveRelocationRecipeStoreError(code);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsafe_store");
  return value;
}

function recipePath(directory: string, workflowRelocationId: string): string {
  if (!UUID.test(workflowRelocationId)) fail("invalid_input");
  const path = join(
    directory,
    `archive-relocation-recipe-${workflowRelocationId}.json`,
  );
  if (
    dirname(path) !== directory ||
    basename(path) !== `archive-relocation-recipe-${workflowRelocationId}.json`
  )
    fail("invalid_input");
  return path;
}

function tempPath(path: string): string {
  return `${path}.prepared.tmp`;
}

function requireRegularFile(stats: Stats, links: 1 | 2): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== FILE_MODE ||
    stats.nlink !== links ||
    stats.size < 1 ||
    stats.size > MAX_RECIPE_BYTES
  )
    fail("unsafe_store");
}

async function requireProtectedDirectory(path: string): Promise<{
  device: number;
  inode: number;
}> {
  const canonical = resolve(path);
  if (canonical !== path || (await realpath(path).catch(() => "")) !== path)
    fail("unsafe_store");
  let current = path;
  let target: Stats | undefined;
  while (true) {
    const stats = await lstat(current).catch(() => fail("unsafe_store"));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (current === path
        ? stats.uid !== uid() || (stats.mode & 0o777) !== DIRECTORY_MODE
        : (stats.uid !== uid() && stats.uid !== 0) ||
          (stats.mode & 0o022) !== 0)
    )
      fail("unsafe_store");
    if (current === path) target = stats;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!target) fail("unsafe_store");
  return { device: target.dev, inode: target.ino };
}

async function assertDirectory(
  directory: string,
  identity: { device: number; inode: number },
): Promise<void> {
  const current = await requireProtectedDirectory(directory);
  if (current.device !== identity.device || current.inode !== identity.inode)
    fail("unsafe_store");
}

async function inspectFile(
  path: string,
  links: 1 | 2,
): Promise<FileSnapshot | undefined> {
  const before = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("unsafe_store");
  });
  if (before === undefined) return undefined;
  requireRegularFile(before, links);
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonBlock !== "number")
    fail("unsafe_store");
  const handle = await open(
    path,
    constants.O_RDONLY | noFollow | nonBlock,
  ).catch(() => fail("unsafe_store"));
  try {
    const opened = await handle.stat();
    requireRegularFile(opened, links);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      fail("unsafe_store");
    const buffer = Buffer.allocUnsafe(MAX_RECIPE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RECIPE_BYTES) fail("unsafe_store");
    const after = await handle.stat();
    requireRegularFile(after, links);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      offset !== opened.size
    )
      fail("unsafe_store");
    const text = buffer.subarray(0, offset).toString("utf8");
    return {
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      device: after.dev,
      inode: after.ino,
      links: after.nlink,
    };
  } finally {
    await handle.close();
  }
}

async function inspectEither(path: string): Promise<FileSnapshot | undefined> {
  const stats = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("unsafe_store");
  });
  if (stats === undefined) return undefined;
  if (stats.nlink !== 1 && stats.nlink !== 2) fail("unsafe_store");
  return await inspectFile(path, stats.nlink);
}

async function syncDirectory(path: string): Promise<void> {
  if (typeof constants.O_DIRECTORY !== "number") fail("unsafe_store");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  ).catch(() => fail("unsafe_store"));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canonicalRecipe(value: unknown): {
  recipe: OwnerArchiveRelocationRecipe;
  text: string;
} {
  let recipe: OwnerArchiveRelocationRecipe;
  try {
    recipe = parseOwnerArchiveRelocationRecipe(value);
  } catch {
    fail("invalid_input");
  }
  const text = `${JSON.stringify(recipe)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_RECIPE_BYTES) fail("invalid_input");
  return { recipe, text };
}

function parsedSnapshot(
  snapshot: FileSnapshot,
  workflowRelocationId: string,
  expectedRecipeHash: string,
): OwnerArchiveRelocationRecipe {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text) as unknown;
  } catch {
    fail("recipe_conflict");
  }
  let canonical: ReturnType<typeof canonicalRecipe>;
  try {
    canonical = canonicalRecipe(value);
  } catch {
    fail("recipe_conflict");
  }
  if (
    canonical.text !== snapshot.text ||
    canonical.recipe.workflowRelocationId !== workflowRelocationId ||
    canonical.recipe.recipeHash !== expectedRecipeHash
  )
    fail("recipe_conflict");
  return canonical.recipe;
}

function sameInode(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameInode(left, right) &&
    left.links === right.links &&
    left.sha256 === right.sha256 &&
    left.text === right.text
  );
}

async function finishPublication(args: {
  directory: string;
  directoryIdentity: { device: number; inode: number };
  path: string;
  workflowRelocationId: string;
  expectedRecipeHash: string;
  expectedText?: string;
}): Promise<{ recipe: OwnerArchiveRelocationRecipe; reused: boolean }> {
  await assertDirectory(args.directory, args.directoryIdentity);
  const tempName = tempPath(args.path);
  let final = await inspectEither(args.path);
  let temp = await inspectEither(tempName);
  if (final !== undefined) {
    const recipe = parsedSnapshot(
      final,
      args.workflowRelocationId,
      args.expectedRecipeHash,
    );
    if (args.expectedText !== undefined && final.text !== args.expectedText)
      fail("recipe_conflict");
    if (temp !== undefined) {
      if (
        final.links !== 2 ||
        temp.links !== 2 ||
        !sameInode(final, temp) ||
        final.sha256 !== temp.sha256
      )
        fail("recipe_conflict");
      await assertDirectory(args.directory, args.directoryIdentity);
      const confirmFinal = await inspectFile(args.path, 2);
      const confirmTemp = await inspectFile(tempName, 2);
      if (
        confirmFinal === undefined ||
        confirmTemp === undefined ||
        !sameSnapshot(final, confirmFinal) ||
        !sameSnapshot(temp, confirmTemp)
      )
        fail("recipe_conflict");
      await unlink(tempName).catch(() => fail("unsafe_store"));
      await syncDirectory(args.directory);
      final = await inspectFile(args.path, 1);
      if (final === undefined || final.sha256 !== temp.sha256)
        fail("recipe_conflict");
    } else {
      if (final.links !== 1) fail("recipe_conflict");
      await assertDirectory(args.directory, args.directoryIdentity);
      const confirmFinal = await inspectFile(args.path, 1);
      if (confirmFinal === undefined || !sameSnapshot(final, confirmFinal))
        fail("recipe_conflict");
    }
    return { recipe, reused: true };
  }
  if (temp === undefined) fail("recipe_missing");
  const recipe = parsedSnapshot(
    temp,
    args.workflowRelocationId,
    args.expectedRecipeHash,
  );
  if (
    temp.links !== 1 ||
    (args.expectedText !== undefined && temp.text !== args.expectedText)
  )
    fail("recipe_conflict");
  await assertDirectory(args.directory, args.directoryIdentity);
  if ((await inspectEither(args.path)) !== undefined) fail("recipe_conflict");
  const confirmTemp = await inspectFile(tempName, 1);
  if (confirmTemp === undefined || !sameSnapshot(temp, confirmTemp))
    fail("recipe_conflict");
  await link(tempName, args.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail("recipe_conflict");
    fail("unsafe_store");
  });
  await syncDirectory(args.directory);
  return await finishPublication(args).then((result) => ({
    ...result,
    reused: false,
  }));
}

export async function persistOwnerArchiveRelocationRecipe(args: {
  directory: string;
  recipe: unknown;
}): Promise<{
  path: string;
  recipe: OwnerArchiveRelocationRecipe;
  reused: boolean;
}> {
  const directory = resolve(args.directory);
  const canonical = canonicalRecipe(args.recipe);
  const path = recipePath(directory, canonical.recipe.workflowRelocationId);
  const directoryIdentity = await requireProtectedDirectory(directory);
  const existing = await inspectEither(path);
  if (existing !== undefined) {
    const result = await finishPublication({
      directory,
      directoryIdentity,
      path,
      workflowRelocationId: canonical.recipe.workflowRelocationId,
      expectedRecipeHash: canonical.recipe.recipeHash,
      expectedText: canonical.text,
    });
    return { path, ...result };
  }
  const temp = tempPath(path);
  if ((await inspectEither(temp)) === undefined) {
    const handle = await open(temp, "wx", FILE_MODE).catch(() =>
      fail("unsafe_store"),
    );
    let created: Stats;
    try {
      created = await handle.stat();
      if (
        !created.isFile() ||
        created.isSymbolicLink() ||
        created.uid !== uid() ||
        (created.mode & 0o777) !== FILE_MODE ||
        created.nlink !== 1 ||
        created.size !== 0
      )
        fail("unsafe_store");
      await handle.writeFile(canonical.text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const prepared = await inspectFile(temp, 1);
    if (
      prepared === undefined ||
      prepared.device !== created.dev ||
      prepared.inode !== created.ino ||
      prepared.text !== canonical.text
    )
      fail("recipe_conflict");
  }
  const result = await finishPublication({
    directory,
    directoryIdentity,
    path,
    workflowRelocationId: canonical.recipe.workflowRelocationId,
    expectedRecipeHash: canonical.recipe.recipeHash,
    expectedText: canonical.text,
  });
  return { path, ...result };
}

export async function readOwnerArchiveRelocationRecipe(args: {
  directory: string;
  workflowRelocationId: string;
  expectedRecipeHash: string;
}): Promise<{ path: string; recipe: OwnerArchiveRelocationRecipe }> {
  const directory = resolve(args.directory);
  if (!SHA256.test(args.expectedRecipeHash)) fail("invalid_input");
  const path = recipePath(directory, args.workflowRelocationId);
  const directoryIdentity = await requireProtectedDirectory(directory);
  const result = await finishPublication({
    directory,
    directoryIdentity,
    path,
    workflowRelocationId: args.workflowRelocationId,
    expectedRecipeHash: args.expectedRecipeHash,
  });
  return { path, recipe: result.recipe };
}
