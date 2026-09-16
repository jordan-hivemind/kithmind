// `@repo/kith-store/ingestion`: the inline-UTF-8 lane.
//
// `inline.ts` is the lane's fixed identity (fingerprints, chunk boundary, plan
// and the two digests). `input.ts` is admission's validation and destination
// resolution. `inlineWork.ts` is the pipeline itself: admit, claim, stage,
// activate, fail, recover. `urlQueue.ts` is the queue-only `ingest_url`
// endpoint. `errors.ts` classifies a refusal for the transport.
export * from "./inline.js";
export * from "./input.js";
export * from "./inlineWork.js";
export * from "./urlQueue.js";
export * from "./errors.js";
