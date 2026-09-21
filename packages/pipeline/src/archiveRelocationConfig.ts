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
  const oldBackup = before.pdfDocQa?.archive.independentBackup;
  const newBackup = after.pdfDocQa?.archive.independentBackup;
  const oldRepository =
    oldBackup && "repository" in oldBackup ? oldBackup.repository : undefined;
  const newRepository =
    newBackup && "repository" in newBackup ? newBackup.repository : undefined;
  if (
    !oldRepository ||
    !newRepository ||
    oldRepository.rootPath === newRepository.rootPath
  ) {
    throw new Error("Archive relocation requires a changed remote root path");
  }
  const comparison = structuredClone(after);
  const comparisonBackup = comparison.pdfDocQa?.archive.independentBackup;
  if (!comparisonBackup || !("repository" in comparisonBackup)) {
    throw new Error("Archive relocation requires a remote backup");
  }
  comparisonBackup.repository!.rootPath = oldRepository.rootPath;
  if (!isDeepStrictEqual(before, comparison)) {
    throw new Error("Archive relocation may change only the remote root path");
  }
  return {
    previousBinding: journalBindingForConfig(before),
    proposedBinding: journalBindingForConfig(after),
  };
}
