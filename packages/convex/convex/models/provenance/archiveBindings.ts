import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { sha256Utf8 } from "./model";

export type ArchiveRole = {
  subjectKind: "original_bytes" | "parser_output";
  copyRole: "primary" | "independent_backup";
};

export async function archiveSubjectKey(input: {
  sourceRevisionId: Id<"sourceRevisions">;
  parserArtifactId?: Id<"sourceParserArtifacts">;
  subjectKind: ArchiveRole["subjectKind"];
}): Promise<string> {
  return sha256Utf8(
    JSON.stringify([
      "archive-subject:v1",
      input.subjectKind,
      input.sourceRevisionId,
      input.parserArtifactId ?? null,
    ]),
  );
}

export async function bindInitialArchiveReceipt(
  ctx: MutationCtx,
  input: {
    receipt: Doc<"sourceArtifactArchiveReceipts">;
    expectedBindingEpoch?: number;
    userId: Id<"users">;
    actorCredentialId: Id<"apiKeys">;
    now: number;
  },
): Promise<Doc<"sourceArtifactArchiveBindings">> {
  const subjectKey = await archiveSubjectKey(input.receipt);
  const rows = await ctx.db
    .query("sourceArtifactArchiveBindings")
    .withIndex("by_source_subject_role", (q) =>
      q
        .eq("sourceAccountId", input.receipt.sourceAccountId)
        .eq("subjectKey", subjectKey)
        .eq("copyRole", input.receipt.copyRole),
    )
    .take(2);
  if (rows.length > 1)
    throw new Error("Archive binding identity is not unique");
  const existing = rows[0];
  if (existing) {
    if (
      existing.spaceId !== input.receipt.spaceId ||
      existing.sourceItemId !== input.receipt.sourceItemId ||
      existing.sourceRevisionId !== input.receipt.sourceRevisionId ||
      existing.parserArtifactId !== input.receipt.parserArtifactId ||
      existing.subjectKind !== input.receipt.subjectKind ||
      existing.receiptId !== input.receipt._id ||
      existing.archiveIdentityFingerprint !==
        input.receipt.archiveIdentityFingerprint ||
      (input.expectedBindingEpoch !== undefined &&
        existing.bindingEpoch !== input.expectedBindingEpoch)
    ) {
      throw new Error("Archive binding conflicts with current selection");
    }
    return existing;
  }
  if (
    input.expectedBindingEpoch !== undefined &&
    input.expectedBindingEpoch !== 0
  ) {
    throw new Error("Archive binding epoch is not current");
  }
  const id = await ctx.db.insert("sourceArtifactArchiveBindings", {
    spaceId: input.receipt.spaceId,
    sourceAccountId: input.receipt.sourceAccountId,
    sourceItemId: input.receipt.sourceItemId,
    sourceRevisionId: input.receipt.sourceRevisionId,
    ...(input.receipt.parserArtifactId === undefined
      ? {}
      : { parserArtifactId: input.receipt.parserArtifactId }),
    subjectKind: input.receipt.subjectKind,
    subjectKey,
    copyRole: input.receipt.copyRole,
    receiptId: input.receipt._id,
    archiveIdentityFingerprint: input.receipt.archiveIdentityFingerprint,
    bindingEpoch: 0,
    updatedAt: input.now,
    userId: input.userId,
    actorCredentialId: input.actorCredentialId,
  });
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Archive binding insert failed");
  return row;
}

export async function loadCurrentArchiveBinding(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    sourceRevisionId: Id<"sourceRevisions">;
    parserArtifactId?: Id<"sourceParserArtifacts">;
    subjectKind: ArchiveRole["subjectKind"];
    copyRole: ArchiveRole["copyRole"];
  },
): Promise<
  | {
      binding: Doc<"sourceArtifactArchiveBindings">;
      receipt: Doc<"sourceArtifactArchiveReceipts">;
    }
  | undefined
> {
  const subjectKey = await archiveSubjectKey(input);
  const rows = await ctx.db
    .query("sourceArtifactArchiveBindings")
    .withIndex("by_source_subject_role", (q) =>
      q
        .eq("sourceAccountId", input.sourceAccountId)
        .eq("subjectKey", subjectKey)
        .eq("copyRole", input.copyRole),
    )
    .take(2);
  if (rows.length > 1)
    throw new Error("Archive binding identity is not unique");
  const binding = rows[0];
  if (!binding) return undefined;
  const receipt = await ctx.db.get(binding.receiptId);
  if (
    !receipt ||
    binding.spaceId !== input.spaceId ||
    binding.sourceAccountId !== input.sourceAccountId ||
    binding.sourceItemId !== input.sourceItemId ||
    binding.sourceRevisionId !== input.sourceRevisionId ||
    binding.parserArtifactId !== input.parserArtifactId ||
    binding.subjectKind !== input.subjectKind ||
    binding.copyRole !== input.copyRole ||
    binding.subjectKey !== subjectKey ||
    !Number.isSafeInteger(binding.bindingEpoch) ||
    binding.bindingEpoch < 0 ||
    receipt.spaceId !== binding.spaceId ||
    receipt.sourceAccountId !== binding.sourceAccountId ||
    receipt.sourceItemId !== binding.sourceItemId ||
    receipt.sourceRevisionId !== binding.sourceRevisionId ||
    receipt.parserArtifactId !== binding.parserArtifactId ||
    receipt.subjectKind !== binding.subjectKind ||
    receipt.copyRole !== binding.copyRole ||
    receipt.archiveIdentityFingerprint !== binding.archiveIdentityFingerprint
  ) {
    throw new Error("Current archive binding is invalid");
  }
  return { binding, receipt };
}

export function requireIndependentArchivePair(
  primary: Doc<"sourceArtifactArchiveReceipts">,
  backup: Doc<"sourceArtifactArchiveReceipts">,
): void {
  if (
    primary._id === backup._id ||
    primary.archiveIdentityFingerprint === backup.archiveIdentityFingerprint ||
    primary.recipientFingerprint === backup.recipientFingerprint ||
    primary.repositoryKeyDomainFingerprint ===
      backup.repositoryKeyDomainFingerprint ||
    primary.storageFailureDomainFingerprint ===
      backup.storageFailureDomainFingerprint
  ) {
    throw new Error("Archive copies are not independently identified");
  }
}
