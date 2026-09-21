import { admin, memory } from "@repo/kith-store";
import {
  applyAuthorizedCorrection,
  reprocessDocuments,
  setDocumentClassification,
} from "@repo/kith-store/extraction";
import {
  getAuthorizedReadSpaceIds,
  requireSpaceAccess,
} from "@repo/kith-store/identity";

import type { WithMcpPrincipal } from "./principal";

type InvestmentAction =
  | {
      action: "create";
      spaceId: string;
      name: string;
      category?: string | null;
      signedOn?: string | null;
      status?: admin.InvestmentStatus;
      notes?: string | null;
    }
  | {
      action: "update";
      investmentId: string;
      name?: string;
      category?: string | null;
      signedOn?: string | null;
      status?: admin.InvestmentStatus;
      notes?: string | null;
    }
  | { action: "archive" | "restore"; investmentId: string };

type EntryAction =
  | ({ action: "create" } & Omit<admin.CreateEntryArgs, "principal">)
  | {
      action: "update";
      investmentId: string;
      entryId: string;
      entryType?: admin.InvestmentEntryType;
      entryDate?: string;
      amount?: string;
      currency?: string;
      exchangeRate?: string | null;
      note?: string | null;
      documentId?: string | null;
      dateIsEstimated?: boolean;
    }
  | { action: "delete"; investmentId: string; entryId: string };

export function postgresManagement(withPrincipal: WithMcpPrincipal) {
  return {
    capabilities: async () =>
      await withPrincipal(
        async ({ principal }) => ({
          credentialType: principal.credentialId
            ? "api_key_or_oauth"
            : "web_session",
          capabilities: [...principal.capabilities],
          canRead: principal.capabilities.includes("read"),
          canWrite: principal.capabilities.includes("write"),
          canIngest: principal.capabilities.includes("ingest"),
          maxSensitivity: principal.maxSensitivity ?? "restricted",
          spaceGrantCount: principal.credentialSpaceIds?.length ?? null,
          sourceAccountGrantCount:
            principal.credentialSourceAccountIds?.length ?? null,
        }),
        { readOnly: true },
      ),

    listEntities: async (args: {
      spaceIds?: readonly string[];
      kind?: memory.EntityKind;
      name?: string;
      limit?: number;
      cursor?: string;
    }) =>
      await withPrincipal(
        async ({ ctx, principal }) => {
          const spaces = await getAuthorizedReadSpaceIds(
            ctx,
            principal,
            args.spaceIds,
          );
          return await memory.listEntities(ctx, spaces, args);
        },
        { readOnly: true },
      ),

    manageEntity: async (args: {
      entityId: string;
      aliases: readonly string[];
    }) =>
      await withPrincipal(async ({ ctx, principal }) => ({
        entity: await memory.setEntityAliases(ctx, { principal, ...args }),
      })),

    manageProfileEntity: async (
      args:
        | {
            action: "create";
            spaceId: string;
            kind: memory.ProfileKind;
            name: string;
            aliases?: readonly string[];
          }
        | {
            action: "update";
            entityId: string;
            name?: string;
            aliases?: readonly string[];
          }
        | {
            action: "link_me";
            spaceId: string;
            entityId: string;
          }
        | {
            action: "link_document";
            entityId: string;
            sourceItemId: string;
          }
        | {
            action: "merge";
            sourceEntityId: string;
            targetEntityId: string;
          },
    ) =>
      await withPrincipal(async ({ ctx, principal }) => {
        switch (args.action) {
          case "create":
            return {
              action: args.action,
              ...(await memory.createNamedEntity(ctx, { principal, ...args })),
            };
          case "update":
            return {
              action: args.action,
              entity: await memory.updateNamedEntity(ctx, {
                principal,
                ...args,
              }),
            };
          case "link_me":
            return {
              action: args.action,
              entity: await memory.linkMeToPerson(ctx, { principal, ...args }),
            };
          case "link_document":
            return {
              action: args.action,
              ...(await memory.linkProfileDocument(ctx, {
                principal,
                ...args,
              })),
            };
          case "merge":
            return {
              action: args.action,
              ...(await memory.mergeEntities(ctx, { principal, ...args })),
            };
        }
      }),

    manageInvestment: async (args: InvestmentAction) =>
      await withPrincipal(async ({ ctx, principal }) => {
        if (args.action === "create") {
          const investmentId = await admin.createInvestment(ctx, {
            principal,
            ...args,
          });
          return { action: args.action, investmentId };
        }
        if (args.action === "update") {
          await admin.updateInvestment(ctx, { principal, ...args });
        } else {
          await admin.archiveInvestment(ctx, {
            principal,
            investmentId: args.investmentId,
            archived: args.action === "archive",
          });
        }
        return { action: args.action, investmentId: args.investmentId };
      }),

    manageEntry: async (args: EntryAction) =>
      await withPrincipal(async ({ ctx, principal }) => {
        if (args.action === "create") {
          const result = await admin.createInvestmentEntry(ctx, {
            principal,
            ...args,
          });
          return {
            action: args.action,
            investmentId: args.investmentId,
            entryId: result.id,
            created: result.created,
          };
        }
        if (args.action === "update") {
          await admin.updateInvestmentEntry(ctx, { principal, ...args });
        } else {
          await admin.deleteInvestmentEntry(ctx, { principal, ...args });
        }
        return {
          action: args.action,
          investmentId: args.investmentId,
          entryId: args.entryId,
        };
      }),

    listDocumentLinks: async (args: {
      spaceIds?: readonly string[];
      investmentIds?: readonly string[];
      entryIds?: readonly string[];
      sourceItemId?: string;
      states?: readonly admin.LinkState[];
    }) =>
      await withPrincipal(
        async ({ ctx, principal }) => {
          const spaces = await getAuthorizedReadSpaceIds(
            ctx,
            principal,
            args.spaceIds,
          );
          if (spaces.length === 0) return [];
          return await admin.listInvestmentDocumentLinks(ctx, spaces, args);
        },
        { readOnly: true },
      ),

    manageDocumentLink: async (args: {
      action: "confirm" | "reject";
      linkId: string;
      reason?: string | null;
    }) =>
      await withPrincipal(async ({ ctx, principal }) => {
        const result =
          args.action === "confirm"
            ? await admin.confirmInvestmentDocumentLink(ctx, {
                principal,
                linkId: args.linkId,
              })
            : await admin.rejectInvestmentDocumentLink(ctx, {
                principal,
                linkId: args.linkId,
                reason: args.reason,
              });
        return { action: args.action, linkId: args.linkId, ...result };
      }),

    listAttention: async (
      args: Omit<Parameters<typeof admin.listAttention>[1], "principal">,
    ) =>
      await withPrincipal(
        async ({ ctx, principal }) => {
          const page = await admin.listAttention(ctx, { ...args, principal });
          const mutes = await admin.listAttentionMutes(ctx, {
            principal,
            spaceIds: args.spaceIds,
          });
          return { ...page, mutes };
        },
        { readOnly: true },
      ),

    manageAttention: async (
      args:
        | { action: "dismiss"; id: string; reason: admin.DismissReason }
        | { action: "undo_dismiss"; id: string }
        | { action: "snooze"; id: string; until: string }
        | {
            action: "bulk_dismiss";
            spaceId: string;
            filter: admin.AttentionFilter;
            reason: admin.DismissReason;
          }
        | {
            action: "bulk_snooze";
            spaceId: string;
            filter: admin.AttentionFilter;
            until: string;
          }
        | {
            action: "mute";
            spaceId: string;
            scopeKind: admin.MuteScopeKind;
            scopeValue: string;
            reason?: string | null;
          }
        | { action: "unmute"; id: string },
    ) =>
      await withPrincipal(async ({ ctx, principal }) => {
        switch (args.action) {
          case "dismiss":
            await admin.dismissAttention(ctx, { principal, ...args });
            return { action: args.action, id: args.id };
          case "undo_dismiss":
            await admin.undoDismissAttention(ctx, { principal, id: args.id });
            return { action: args.action, id: args.id };
          case "snooze":
            await admin.snoozeAttention(ctx, { principal, ...args });
            return { action: args.action, id: args.id };
          case "bulk_dismiss":
            return {
              action: args.action,
              ...(await admin.bulkDismissAttention(ctx, {
                principal,
                ...args,
              })),
            };
          case "bulk_snooze":
            return {
              action: args.action,
              ...(await admin.bulkSnoozeAttention(ctx, { principal, ...args })),
            };
          case "mute":
            return {
              action: args.action,
              id: await admin.addAttentionMute(ctx, { principal, ...args }),
            };
          case "unmute":
            await admin.removeAttentionMute(ctx, { principal, id: args.id });
            return { action: args.action, id: args.id };
        }
      }),

    manageFact: async (
      args:
        | {
            action: "update";
            spaceId: string;
            factId: string;
            value: memory.FactValueInput;
            sourceType?: memory.FactSourceType;
            changeReason?: string;
            changeKind?: "changed" | "corrected";
            validFrom?: number;
          }
        | { action: "retire"; spaceId: string; factId: string },
    ) =>
      await withPrincipal(async ({ ctx, principal }) => {
        await requireSpaceAccess(ctx, principal, args.spaceId, "write");
        if (args.action === "update") {
          const result = await memory.updateFact(
            ctx,
            principal.userId,
            args.spaceId,
            args.factId,
            args,
          );
          return { action: args.action, ...result };
        }
        await memory.retireFact(ctx, args.spaceId, args.factId);
        return { action: args.action, factId: args.factId };
      }),

    manageThought: async (
      args:
        | {
            action: "update";
            spaceId: string;
            thoughtId: string;
            content: string;
            type: memory.ThoughtType;
            topics: readonly string[];
            people: readonly string[];
          }
        | {
            action: "retract";
            spaceId: string;
            thoughtId: string;
            reason?: string;
          },
    ) =>
      await withPrincipal(async ({ ctx, principal }) => {
        await requireSpaceAccess(ctx, principal, args.spaceId, "write");
        if (args.action === "update") {
          const thoughtId = await memory.updateThought(
            ctx,
            principal.userId,
            args.spaceId,
            args.thoughtId,
            args,
          );
          return {
            action: args.action,
            thoughtId,
            previousThoughtId: args.thoughtId,
          };
        }
        await memory.deleteThought(
          ctx,
          args.spaceId,
          args.thoughtId,
          args.reason,
        );
        return { action: args.action, thoughtId: args.thoughtId };
      }),

    listAccountOverrides: async (spaceId: string) =>
      await withPrincipal(
        async ({ ctx, principal }) => {
          await requireSpaceAccess(ctx, principal, spaceId, "read");
          return await admin.listAccountOverrides(ctx, { spaceId });
        },
        { readOnly: true },
      ),

    manageAccountOverride: async (args: {
      spaceId: string;
      accountId: string;
      displayName?: string | null;
      accountLast4?: string | null;
      accountType?: string | null;
      closed?: boolean;
    }) =>
      await withPrincipal(async ({ ctx, principal }) => {
        await admin.setAccountOverride(ctx, { principal, ...args });
        const found = await admin.listAccountOverrides(ctx, {
          spaceId: args.spaceId,
        });
        return {
          accountId: args.accountId,
          override:
            found.find((item) => item.accountId === args.accountId) ?? null,
        };
      }),

    correctExtractedValue: async (args: {
      spaceId: string;
      sourceItemId: string;
      fieldName: string;
      correctedValue: unknown;
      reason?: string;
    }) =>
      await withPrincipal(
        async ({ ctx, principal }) =>
          await applyAuthorizedCorrection(ctx, {
            principal,
            ...args,
          }),
      ),

    manageDocumentExtraction: async (
      args:
        | {
            action: "set_classification";
            spaceId: string;
            sourceItemId: string;
            kind: string;
          }
        | {
            action: "clear_classification";
            spaceId: string;
            sourceItemId: string;
          }
        | {
            action: "reprocess";
            spaceId: string;
            sourceItemIds: readonly string[];
          },
    ) =>
      await withPrincipal(async ({ ctx, principal }) => {
        if (args.action === "reprocess") {
          return await reprocessDocuments(ctx, { principal, ...args });
        }
        return await setDocumentClassification(ctx, {
          principal,
          spaceId: args.spaceId,
          sourceItemId: args.sourceItemId,
          kind: args.action === "set_classification" ? args.kind : null,
        });
      }),
  };
}

export type McpManagement = ReturnType<typeof postgresManagement>;
