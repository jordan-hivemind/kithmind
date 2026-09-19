// SENS-1. Two separate things share this module, and they do not interact:
//
//   `model.ts`        sensitivity as a LABEL on kinds, fields, items and roots,
//                     and the one opt-in ceiling expressed in terms of it.
//   `identifiers.ts`  the identifier detector, used ONLY to scrub logs, error
//                     strings and feed payloads (`sinks.ts`). It never touches
//                     stored data or tool results.

export * from "./identifiers.js";
export * from "./model.js";
export * from "./sinks.js";
