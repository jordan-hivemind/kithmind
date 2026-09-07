import { v } from "convex/values";

import { internalMutation, internalQuery } from "../../_generated/server";
import { principalRefValidator } from "../apiKeys/validators";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  getWorkerInventoryPage,
  getWorkerSourceStatus,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery";
import { parseWorkerRequest, type WorkerRequest } from "./protocol";

function operation<T extends WorkerRequest["operation"]>(
  value: unknown,
  expected: T,
): Extract<WorkerRequest, { operation: T }> {
  const request = parseWorkerRequest(value);
  if (request.operation !== expected)
    throw new Error("Invalid worker operation");
  return request as Extract<WorkerRequest, { operation: T }>;
}

export const sourceStatus = internalQuery({
  args: { principal: principalRefValidator, request: v.any(), now: v.number() },
  handler: async (ctx, args) =>
    await getWorkerSourceStatus(
      ctx,
      args.principal,
      operation(args.request, "source.status"),
      args.now,
    ),
});

export const sourceInventoryPage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await getWorkerInventoryPage(
      ctx,
      args.principal,
      operation(args.request, "source.inventoryPage"),
      Date.now(),
    ),
});

export const scanBegin = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await beginWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.begin"),
      Date.now(),
    ),
});

export const scanAppendPage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await appendWorkerScanPage(
      ctx,
      args.principal,
      operation(args.request, "scan.appendPage"),
      Date.now(),
    ),
});

export const scanSeal = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await sealWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.seal"),
      Date.now(),
    ),
});

export const scanReconcile = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await reconcileWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.reconcile"),
      Date.now(),
    ),
});

export const discoveryReserve = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    tokens: v.array(v.string()),
  },
  handler: async (ctx, args) =>
    await reserveDiscoveryWork(
      ctx,
      args.principal,
      operation(args.request, "discovery.reserve"),
      args.tokens,
      Date.now(),
    ),
});

export const discoveryAdmitUtf8 = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await admitDiscoveryUtf8(
      ctx,
      args.principal,
      operation(args.request, "discovery.admitUtf8"),
      Date.now(),
    ),
});
