// Programmatic surface, for tests and any future caller that wants the
// pieces without the CLI. The CLI (`cli.ts`) is the product; this is what
// lets `test/*.test.mjs` import the mapping and db layers directly.

export * from "./config.js";
export * from "./db.js";
export * from "./importArchive.js";
export * from "./keychain.js";
export * from "./mapping.js";
export {
  DEFAULT_LINK_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  runHostedLink,
  runLink,
  type LinkDeps,
  type LinkOutcome,
} from "./link.js";
export { pullAll, pullItem, type ItemPullResult } from "./pull.js";
