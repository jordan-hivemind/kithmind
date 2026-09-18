// F1-76 phase 3. The same-institution symbol rule, and the closed vocabulary
// every decision it makes is recorded under.
//
// The problem it exists for: this institution's statements name an equity
// holding by symbol and name only, and its activity feed mints the same
// instrument with a symbol and a cusip and no name. So a statement holding can
// never reach the cusip or isin tier, never matches on (symbol AND name), and
// always lands in the symbol-only tier, which is flagged for review
// (`weak_instrument_match`). On the owner's archive that is 1,330 instruments
// carrying an open weak match, 1,319 of them already holding a cusip nobody
// disputes.
//
// The owner's decision (2026-09-18) is to accept such a match as strong, under
// its own identity kind, when all three conditions hold:
//
//   1. the symbol maps to exactly one instrument in this archive;
//   2. that instrument's cusip or isin was established by the same
//      institution's own data;
//   3. the holding being matched comes from that same institution.
//
// The institution is then vouching for both halves. Anything the rule refuses
// stays flagged exactly as before, and the review queue remains the fallback.
//
// Nothing here is silent in either direction. An acceptance is written as its
// own durable review item, a refusal keeps an open item, and both carry a
// closed `reason_code` rather than only free text, so "how many, and why" is a
// query rather than a grep.

/**
 * The rule's name, recorded on every decision it makes. Versioned because the
 * decision is the owner's policy rather than a fact about the data: a later
 * rule must be distinguishable from this one in rows this one already wrote.
 */
export const INSTITUTION_SYMBOL_RULE = "same_institution_symbol_v1";

/**
 * Why the rule refused a symbol-only match, as a closed enum. Each value names
 * exactly one condition that did not hold, checked in this order, so a refusal
 * always reports the first thing that was wrong rather than a summary.
 *
 * Conditions 2 and 3 are one test against stored data, not two. This archive
 * records no per-column provenance on `instruments`, so the only thing that can
 * say which institution established an identifier is which institutions'
 * rows reference it. From that vantage "the identifier came from another
 * institution" and "the holding came from another institution" are the same
 * inequality between one vouching institution and the pull's own, and
 * inventing two codes for one test would be a distinction the data cannot
 * support. `instrument_referenced_by_several_institutions` is the genuinely
 * separate case: provenance is ambiguous rather than foreign.
 */
export const INSTITUTION_SYMBOL_REFUSAL_REASONS = [
  "symbol_matches_several_instruments",
  "instrument_has_no_strong_identifier",
  "instrument_has_no_institution_evidence",
  "instrument_vouched_by_another_institution",
  "instrument_referenced_by_several_institutions",
] as const;

export type InstitutionSymbolRefusalReason =
  (typeof INSTITUTION_SYMBOL_REFUSAL_REASONS)[number];

/**
 * A match this archive had accepted under the rule, withdrawn because later
 * imported data stopped satisfying it -- a second instrument appeared under the
 * same symbol, or another institution's rows started referencing the matched
 * instrument. Its own reason rather than one of the refusals above: what a
 * reader needs to know is that an acceptance was reversed, which no refusal
 * code says.
 */
export const INSTITUTION_SYMBOL_INVALIDATED =
  "institution_symbol_match_invalidated";

/** Every value `review_items.reason_code` may take (pgSchema.ts migration 13
 * spells the same list as a CHECK, so an unrecognized code is refused by the
 * database rather than stored and later counted as something it is not). */
export const INSTRUMENT_MATCH_REASON_CODES = [
  INSTITUTION_SYMBOL_RULE,
  INSTITUTION_SYMBOL_INVALIDATED,
  ...INSTITUTION_SYMBOL_REFUSAL_REASONS,
] as const;

export type InstrumentMatchReasonCode =
  (typeof INSTRUMENT_MATCH_REASON_CODES)[number];

/**
 * One fixed sentence of plain language per reason, and one recommended action,
 * for a review queue to show beside the item. Literals only: no instrument
 * name, no symbol, no identifier, no institution, nothing read out of the
 * archive, so a queue can print these without becoming a second place the
 * owner's data lives.
 */
export const INSTRUMENT_MATCH_REASON_TEXT: Readonly<
  Record<
    InstrumentMatchReasonCode,
    { readonly explanation: string; readonly action: string }
  >
> = Object.freeze({
  [INSTITUTION_SYMBOL_RULE]: {
    explanation:
      "This holding matched an instrument by ticker symbol alone, and the match was accepted because the symbol names exactly one instrument and the same institution supplied both the holding and that instrument's identifier.",
    action:
      "No action needed. Reopen this item if the accepted match is wrong.",
  },
  [INSTITUTION_SYMBOL_INVALIDATED]: {
    explanation:
      "A match this archive had accepted automatically no longer holds, because later imported data changed what the ticker symbol or the identifier's provenance shows.",
    action:
      "Confirm or correct this match by hand. The automatic acceptance has been withdrawn.",
  },
  symbol_matches_several_instruments: {
    explanation:
      "More than one instrument in this archive carries this holding's ticker symbol, so the symbol alone cannot say which one the holding is.",
    action:
      "Confirm which instrument this holding is, or merge the instrument records that share the symbol.",
  },
  instrument_has_no_strong_identifier: {
    explanation:
      "The instrument this holding's ticker symbol matched carries no CUSIP or ISIN, so there is no identifier for the institution to have vouched for.",
    action:
      "Record the instrument's CUSIP or ISIN from a source that states it, then reparse.",
  },
  instrument_has_no_institution_evidence: {
    explanation:
      "No stored transaction or position references the matched instrument, so nothing in this archive says which institution's own data established its identifier.",
    action:
      "Import this institution's activity for the period and reparse, or confirm the match by hand.",
  },
  instrument_vouched_by_another_institution: {
    explanation:
      "The only institution whose stored rows reference the matched instrument is not the institution this holding came from, so that institution is not vouching for both halves of the match.",
    action:
      "Confirm or correct this match by hand. Another institution's identifier is not evidence about this one's holding.",
  },
  instrument_referenced_by_several_institutions: {
    explanation:
      "Rows from more than one institution reference the matched instrument, so this archive cannot say which institution's data established its identifier.",
    action: "Confirm or correct this match by hand.",
  },
});

/**
 * What one import or reparse decided about symbol-only instrument matches, so
 * neither an acceptance nor a refusal can happen without a number the operator
 * sees. Counted per distinct (institution, descriptor, matched instrument), not
 * per sighting: one statement restating the same holding every month is one
 * decision, and reporting 1,237 of them would say nothing.
 */
export type InstrumentMatchSummary = {
  /** Matches accepted under the rule. */
  accepted: number;
  /** Open `weak_instrument_match` items this run resolved because the rule now
   * accepts the match they flagged. */
  resolvedByRule: number;
  /** Accepted matches this run withdrew because later data stopped satisfying
   * the rule, each reflagged as an open item. */
  invalidated: number;
  /** Matches the rule refused, by which condition failed. Every one of these
   * leaves an open `weak_instrument_match` item behind. */
  refused: Record<InstitutionSymbolRefusalReason, number>;
};

export function emptyInstrumentMatchSummary(): InstrumentMatchSummary {
  return {
    accepted: 0,
    resolvedByRule: 0,
    invalidated: 0,
    refused: Object.fromEntries(
      INSTITUTION_SYMBOL_REFUSAL_REASONS.map((reason) => [reason, 0]),
    ) as Record<InstitutionSymbolRefusalReason, number>,
  };
}

/** Adds `from` into `into`, for a caller summing one document's decisions into
 * a whole run's (reparse imports one document per transaction). */
export function addInstrumentMatchSummary(
  into: InstrumentMatchSummary,
  from: InstrumentMatchSummary,
): void {
  into.accepted += from.accepted;
  into.resolvedByRule += from.resolvedByRule;
  into.invalidated += from.invalidated;
  for (const reason of INSTITUTION_SYMBOL_REFUSAL_REASONS) {
    into.refused[reason] += from.refused[reason];
  }
}
