import { join, resolve } from "node:path";

import {
  ArchiveCatalogError,
  openArchiveCatalog,
  type ArchiveCatalog,
} from "./archiveCatalog.js";
import {
  parseOwnerArchiveRelocationRecipe,
  prepareOwnerArchiveRelocationRecipe,
  relocationIntentFromRecipe,
  type OwnerArchiveRelocationRecipe,
} from "./archiveRelocationRecipe.js";
import {
  persistOwnerArchiveRelocationRecipe,
  readOwnerArchiveRelocationRecipe,
} from "./archiveRelocationRecipeStore.js";
import { requireArchiveRelocationPreviousConfigFiles } from "./archiveRelocationRebind.js";
import { ArchiveRelocationSession } from "./archiveRelocationSession.js";
import type {
  ArchiveRelocationEvidence,
  ArchiveRelocationState,
} from "./archiveRelocationWorkflow.js";
import { validateArchiveRelocationState } from "./archiveRelocationWorkflow.js";
import { parseConfig } from "./config.js";
import { Journal } from "./journal.js";
import type { JournalCodec, JsonValue } from "./journalTypes.js";

export class ArchiveRelocationRecipeSessionError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "baseline_changed"
      | "phase_conflict"
      | "mapping_conflict",
  ) {
    super(`Archive relocation recipe session failed: ${code}`);
    this.name = "ArchiveRelocationRecipeSessionError";
  }
}

function fail(code: ArchiveRelocationRecipeSessionError["code"]): never {
  throw new ArchiveRelocationRecipeSessionError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid_input");
  return value as Record<string, unknown>;
}

function embeddedConfigs(value: unknown): {
  previousConfig: unknown;
  proposedConfig: unknown;
} {
  const draft = record(value);
  const local = record(draft.localBindings);
  if (
    typeof local.previousConfigText !== "string" ||
    typeof local.proposedConfigText !== "string"
  )
    fail("invalid_input");
  try {
    return {
      previousConfig: JSON.parse(local.previousConfigText) as unknown,
      proposedConfig: JSON.parse(local.proposedConfigText) as unknown,
    };
  } catch {
    fail("invalid_input");
  }
}

function exactSnapshot(
  recipe: OwnerArchiveRelocationRecipe,
  snapshot: Awaited<
    ReturnType<ArchiveCatalog["snapshotRemoteBoundaryForRelocation"]>
  >,
): boolean {
  return (
    JSON.stringify(snapshot) ===
    JSON.stringify({
      authorityDigest: recipe.body.processing.catalogAuthorityDigest,
      catalogRevision: recipe.body.processing.catalogRevision,
      oldBoundary: recipe.body.processing.oldBoundary,
      artifacts: recipe.body.processing.artifacts,
      artifactBindings: recipe.body.processing.artifactBindings,
    })
  );
}

async function requireOriginalBaseline<
  C extends JsonValue,
  R extends JsonValue,
>(
  session: ArchiveRelocationSession<C, R>,
  recipe: OwnerArchiveRelocationRecipe,
  previousConfig: unknown,
  proposedConfig: unknown,
): Promise<void> {
  await requireArchiveRelocationPreviousConfigFiles({
    configPath: recipe.body.localBindings.previousConfigPath,
    proposedConfigPath: recipe.body.localBindings.proposedConfigPath,
    previousConfigText: recipe.body.localBindings.previousConfigText,
    proposedConfigText: recipe.body.localBindings.proposedConfigText,
  });
  const status = await session.journal.archiveRelocationRebindStatus({
    previousConfig,
    proposedConfig,
  });
  if (
    status.state !== "previous" ||
    status.stateSha256 !==
      recipe.body.localBindings.previousJournalStateSha256 ||
    session.journal.watcherId !== recipe.body.localBindings.previousWatcherId ||
    session.journal.credentialStatus !== "current"
  )
    fail("baseline_changed");
  const snapshot = await session.catalog.snapshotRemoteBoundaryForRelocation({
    expectedJournal: session.journal,
    oldBoundary: recipe.body.processing.oldBoundary,
    newBoundary: recipe.body.processing.newBoundary,
  });
  if (!exactSnapshot(recipe, snapshot)) fail("baseline_changed");
}

async function exactMapping(
  catalog: ArchiveCatalog,
  recipe: OwnerArchiveRelocationRecipe,
  verifiedAt: number,
): Promise<boolean> {
  let persisted: Awaited<
    ReturnType<ArchiveCatalog["requireBoundaryRelocation"]>
  >;
  try {
    persisted = await catalog.requireBoundaryRelocation(
      recipe.catalogRelocationId,
    );
  } catch (error) {
    if (
      error instanceof ArchiveCatalogError &&
      error.code === "catalog_not_found"
    )
      return false;
    throw error;
  }
  const { verifiedAt: _verifiedAt, ...relocation } = persisted.relocation;
  if (
    persisted.relocation.verifiedAt !== verifiedAt ||
    JSON.stringify(relocation) !==
      JSON.stringify({
        relocationId: recipe.catalogRelocationId,
        oldBoundary: recipe.body.processing.oldBoundary,
        newBoundary: recipe.body.processing.newBoundary,
        artifacts: recipe.body.processing.artifacts,
      })
  )
    fail("mapping_conflict");
  return true;
}

function evidence(
  state: ArchiveRelocationState,
  recipe: OwnerArchiveRelocationRecipe,
): ArchiveRelocationEvidence {
  if (
    (state.phase !== "verified" &&
      state.phase !== "rebound" &&
      state.phase !== "resumed") ||
    state.newBoundary === undefined ||
    state.movedAt === undefined ||
    state.verifiedAt === undefined ||
    state.verifiedArtifacts === undefined
  )
    fail("phase_conflict");
  return {
    relocationId: recipe.workflowRelocationId,
    oldBoundary: state.intent.oldBoundary,
    newBoundary: state.newBoundary,
    movedAt: state.movedAt,
    verifiedAt: state.verifiedAt,
    verifiedArtifacts: state.verifiedArtifacts,
  };
}

export async function prepareRecipeArchiveRelocationSession<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  draft: unknown;
  recipeDirectory: string;
  credential: string;
  codec: JournalCodec<C, R>;
}): Promise<{
  recipePath: string;
  recipe: OwnerArchiveRelocationRecipe;
  session: ArchiveRelocationSession<C, R>;
}> {
  const configs = embeddedConfigs(args.draft);
  const previous = parseConfig(configs.previousConfig);
  const journal = await Journal.openExistingForArchiveRebind({
    directory: previous.journalDir,
    ...configs,
    credential: args.credential,
    codec: args.codec,
  });
  let transferred = false;
  try {
    const catalog = await openArchiveCatalog({ journal });
    const recipe = await prepareOwnerArchiveRelocationRecipe(args.draft, {
      journal,
      catalog,
    });
    await requireArchiveRelocationPreviousConfigFiles({
      configPath: recipe.body.localBindings.previousConfigPath,
      proposedConfigPath: recipe.body.localBindings.proposedConfigPath,
      previousConfigText: recipe.body.localBindings.previousConfigText,
      proposedConfigText: recipe.body.localBindings.proposedConfigText,
    });
    const persisted = await persistOwnerArchiveRelocationRecipe({
      directory: args.recipeDirectory,
      recipe,
    });
    const session = await ArchiveRelocationSession.adoptHeldForRecipe({
      journal,
      catalog,
      recipe: persisted.recipe,
    });
    transferred = true;
    return {
      recipePath: persisted.path,
      recipe: persisted.recipe,
      session,
    };
  } finally {
    if (!transferred) await journal.close();
  }
}

export async function resumeRecipeArchiveRelocationSession<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  recipeDirectory: string;
  workflowRelocationId: string;
  expectedRecipeHash: string;
  credential: string;
  codec: JournalCodec<C, R>;
}): Promise<{
  recipePath: string;
  recipe: OwnerArchiveRelocationRecipe;
  state: ArchiveRelocationState | undefined;
  session: ArchiveRelocationSession<C, R>;
}> {
  const stored = await readOwnerArchiveRelocationRecipe({
    directory: args.recipeDirectory,
    workflowRelocationId: args.workflowRelocationId,
    expectedRecipeHash: args.expectedRecipeHash,
  });
  const recipe = parseOwnerArchiveRelocationRecipe(stored.recipe);
  const previousConfig = JSON.parse(
    recipe.body.localBindings.previousConfigText,
  ) as unknown;
  const proposedConfig = JSON.parse(
    recipe.body.localBindings.proposedConfigText,
  ) as unknown;
  const journalDirectory = parseConfig(previousConfig).journalDir;
  const session = await ArchiveRelocationSession.open({
    previousConfig,
    proposedConfig,
    configPath: recipe.body.localBindings.previousConfigPath,
    proposedConfigPath: recipe.body.localBindings.proposedConfigPath,
    intentPath: resolve(journalDirectory, "archive-rebind-intent.json"),
    statePath: resolve(
      journalDirectory,
      `archive-relocation-${recipe.workflowRelocationId}.json`,
    ),
    workflowRelocationId: recipe.workflowRelocationId,
    catalogRelocationId: recipe.catalogRelocationId,
    repositoryRelativePath: recipe.body.processing.repositoryRelativePath,
    credential: args.credential,
    codec: args.codec,
  });
  try {
    const rawState = await session.store.read();
    const state = validateArchiveRelocationState(rawState);
    if (rawState !== undefined && state === undefined) fail("phase_conflict");
    if (
      state !== undefined &&
      JSON.stringify(state.intent) !==
        JSON.stringify(relocationIntentFromRecipe(recipe))
    )
      fail("phase_conflict");
    if (
      state === undefined ||
      state.phase === "prepared" ||
      state.phase === "source_verified" ||
      state.phase === "move_requested" ||
      state.phase === "moved"
    ) {
      await requireOriginalBaseline(
        session,
        recipe,
        previousConfig,
        proposedConfig,
      );
      return { recipePath: stored.path, recipe, state, session };
    }
    const mappingExists = await exactMapping(
      session.catalog,
      recipe,
      state.verifiedAt!,
    );
    if (!mappingExists) {
      if (state.phase !== "verified") fail("mapping_conflict");
      await requireOriginalBaseline(
        session,
        recipe,
        previousConfig,
        proposedConfig,
      );
      return { recipePath: stored.path, recipe, state, session };
    }
    const beforeRecovery = await session.journal.archiveRelocationRebindStatus({
      previousConfig,
      proposedConfig,
    });
    if (
      session.journal.credentialStatus !== "current" ||
      ((state.phase === "rebound" || state.phase === "resumed") &&
        beforeRecovery.state !== "proposed")
    )
      fail("phase_conflict");
    await session.rebindRootPath(evidence(state, recipe));
    const rebound = await session.journal.archiveRelocationRebindStatus({
      previousConfig,
      proposedConfig,
    });
    if (
      rebound.state !== "proposed" ||
      session.journal.credentialStatus !== "current"
    )
      fail("phase_conflict");
    return { recipePath: stored.path, recipe, state, session };
  } catch (error) {
    await session.close();
    throw error;
  }
}
