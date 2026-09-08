import { isDeepStrictEqual } from "node:util";

import { journalBindingForConfig, parseConfig } from "./config.js";
import type { JournalBinding } from "./journalTypes.js";

/** Validate a proposed configuration change. This does not authorize a move,
 * prove recovery, write configuration, or rebind a journal. */
export function validateArchiveRelocationConfig(
  previous: unknown,
  proposed: unknown,
): { previousBinding: JournalBinding; proposedBinding: JournalBinding } {
  const before = parseConfig(previous);
  const after = parseConfig(proposed);
  const oldRepository = before.pdfDocQa?.archive.independentBackup.repository;
  const newRepository = after.pdfDocQa?.archive.independentBackup.repository;
  if (
    !oldRepository ||
    !newRepository ||
    oldRepository.rootPath === newRepository.rootPath
  ) {
    throw new Error("Archive relocation requires a changed remote root path");
  }
  const comparison = structuredClone(after);
  comparison.pdfDocQa!.archive.independentBackup.repository!.rootPath =
    oldRepository.rootPath;
  if (!isDeepStrictEqual(before, comparison)) {
    throw new Error("Archive relocation may change only the remote root path");
  }
  return {
    previousBinding: journalBindingForConfig(before),
    proposedBinding: journalBindingForConfig(after),
  };
}
