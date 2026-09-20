// What an entry edit actually sends, and what it deliberately leaves out.
//
// ADM-8b, second review. Three fields on an entry are no longer inert:
//
//   * `documentId` writes a link (and a null one used to reject it),
//   * `entryDate` clears the estimated-date marker and releases every link's
//     claim on the date,
//   * `dateIsEstimated` is the marker itself.
//
// The drawer, meanwhile, sends the whole entry on every save, and the
// investments screen refreshes its rows from the change feed WHILE the drawer
// is open. Put those together and an unrelated edit -- fixing a note, rounding
// a cent -- carried a `documentId` and an `entryDate` the owner never touched,
// against a row that had moved underneath him. A matching document landing in
// that window was then rejected permanently by his next keystroke.
//
// So a patch carries a field only when the DRAFT differs from the value the
// drawer was OPENED with. Not from the live row, which is the version that
// moves; not unconditionally, which is the version that writes. What he did
// not touch, he does not send.
//
// A pure function, here rather than inside the component, because this is the
// rule that decides whether a financial date moves and it deserves a test
// that does not need a DOM.

/** The three fields this rule governs. Everything else on a draft is sent
 * every time, as it always was: those fields are idempotent and the store
 * re-validates them together. */
export type EntryPatchGuarded = {
  entryDate: string;
  documentId: string | null;
  dateIsEstimated: boolean;
};

/**
 * The subset of `draft` to send, given what the drawer held when it opened.
 *
 * `atOpen` is a snapshot taken once, when the row is loaded into the drawer.
 * Generic in the draft, so the caller's own narrow types (the entry type
 * union, for one) survive the round trip.
 */
export function entryPatchFields<T extends EntryPatchGuarded>(
  draft: T,
  atOpen: EntryPatchGuarded,
): Partial<T> {
  const patch: Partial<T> = { ...draft };
  // A date the owner did not retype is not a date he stated, and sending it
  // would clear the estimated marker and release every link's claim on it.
  if (draft.entryDate === atOpen.entryDate) delete patch.entryDate;
  if (draft.dateIsEstimated === atOpen.dateIsEstimated) {
    delete patch.dateIsEstimated;
  }
  // Only ever ADDS a document. A null it did not start from would be an
  // accident of timing, not a decision; removing a document is the Reject
  // action on the link itself.
  if (draft.documentId === atOpen.documentId || draft.documentId === null) {
    delete patch.documentId;
  }
  return patch;
}
