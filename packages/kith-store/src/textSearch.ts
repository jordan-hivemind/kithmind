// P2-39g4: the one keyword-query construction every full-text leg shares.
//
// There are three keyword legs in this package -- thoughts
// (`thoughts.content_search`), facts (`facts.search_text_search`) and document
// chunks (`chunks.text_search`) -- and before this slice each built its own
// predicate with `websearch_to_tsquery('english', $n)`. Section 4.2 of
// docs/plans/2026-09-12-postgres-consolidation.md asks for the frozen recall
// corpus to be rerun against PostgreSQL, and P2-39g3 did
// (docs/retrieval-parity-postgres.md). It measured keyword-mode recall@10 at
// 0.167: eight of nine queries returned nothing at all.
//
// The cause was not stemming. `websearch_to_tsquery` ANDs every significant
// token, so a query is answered only by a row containing *every* one of its
// non-stopword words. A short natural-language question routinely carries an
// ordinary word -- "go", "version", "status", "changed", "time", "recorded" --
// that is not in PostgreSQL's English stopword list and also never appears in
// the terse fact or thought it is asking about. "Rowan attends Brightwater
// School." does not contain "go"; "Atlas Memory is currently on v2.7.1" does
// not contain "version". One such word dropped the whole row. Convex's search
// index ranked on partial term overlap instead, so the port lost recall that
// the original had.
//
// This module restores partial overlap: the query's own stemmed lexemes,
// OR'd, ranked so that a row matching more of them sorts first. That is the
// same shape Convex's index scored, expressed in PostgreSQL's own terms.
// Section 4.2's rule is that a measured regression is fixed by adjusting the
// query or adding `pg_trgm`, never by lowering the bar; this is the first of
// those two, and it was enough. See docs/retrieval-parity-postgres.md for the
// before and after numbers.
//
// ## Why this construction
//
// The lexemes come from `to_tsvector('english', $n)` rather than from
// splitting the text in TypeScript, so the query is stemmed, normalized and
// stopword-filtered by exactly the same configuration and dictionary that
// built the indexed column. A word list assembled in JavaScript would drift
// from the index the first time either side's configuration changed.
//
// `quote_literal` renders each lexeme as a quoted tsquery token, so a lexeme
// holding a quote or an operator character cannot change the query's
// structure. The obvious shorter spelling,
// `replace(plainto_tsquery('english', $n)::text, '&', '|')`, is rejected for
// that reason: it rewrites every `&` in the rendered text, including one
// inside a lexeme, which would silently corrupt the term rather than OR it.
//
// The user's text never leaves the bind parameter. Everything above is
// evaluated server-side from `$n`; no fragment of it is interpolated into SQL
// here or by any caller.
//
// ## Why `ts_rank` with the default normalization
//
// Measured on the frozen corpus and on document-length text, not assumed:
//
//   - `ts_rank(vector, query)` (normalization 0) rises with the number of
//     distinct query lexemes a row matches and saturates repetition of a
//     single one. Three distinct query words beat one query word repeated
//     eight times. That is the ordering partial overlap needs.
//   - `ts_rank_cd` inverts it. Cover density counts covers, and under an OR
//     query every lexeme is its own cover, so one query word repeated eight
//     times scored 0.8 against 0.3 for a row matching three distinct query
//     words. A row that merely repeats one word would outrank the row that
//     answers the question.
//   - `ts_rank(..., 1)` and the other length-normalizing flags divide by
//     document length. On the frozen corpus that promoted the shorter
//     superseded "Rowan attends Lakeside School." over the longer current
//     "Rowan currently attends Redwood Academy...", and on document-length
//     text it dropped a long chunk matching three query terms below a short
//     one matching two. Length is not evidence of relevance here: a thought
//     is one sentence and a chunk is a page.
//
// So the rank function is unchanged from P2-39g1 and only the query it is
// given changed. Prefix matching on the final term (`:*`) was measured too
// and moved no query on the frozen corpus, so it is not added: it would be
// untested behavior, and the OR construction already covers the partial
// overlap the misses needed.
//
// An empty result is a real one. A query of nothing but stopwords yields no
// lexemes, `string_agg` returns NULL, and `@@ NULL` is NULL, so the leg
// returns no rows -- the same outcome `websearch_to_tsquery` produced for the
// same input, and not an error.
//
// This helper returns SQL fragments rather than running the query itself
// because each leg wraps them in its own space predicate, retrievability and
// status filters, per-space take and merge, none of which this module knows
// or changes.

import { ProofError } from "./errors.js";

/** A column reference: `content_search`, or `chunks.text_search` / `c.text_search`. */
const COLUMN = /^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/;

/** The text search configuration every indexed column in this schema is built with. */
export const TEXT_SEARCH_CONFIG = "english";

export type KeywordSearchSql = {
  /** The `WHERE` predicate: the column matches at least one query lexeme. */
  readonly match: string;
  /** The `ORDER BY` expression: higher means more query lexemes matched. */
  readonly rank: string;
};

/**
 * `tsvector @@ tsquery` and its `ts_rank`, over the OR of the bound query
 * text's own stemmed lexemes.
 *
 * `parameterIndex` is where the caller binds the raw query string. The same
 * position is read by both fragments, so a caller binds the text once.
 *
 * Both fragments carry the tsquery subquery in full. It does not reference the
 * scanned row, so PostgreSQL evaluates each one once for the statement rather
 * than once per row, and the GIN index on `column` still serves the match.
 */
export function keywordSearchSql(
  column: string,
  parameterIndex: number,
): KeywordSearchSql {
  if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 1) {
    throw new ProofError("invalid_parameter_index");
  }
  if (!COLUMN.test(column)) throw new ProofError("invalid_search_column");
  const tsquery =
    `(SELECT string_agg(quote_literal(lexeme), ' | ' ORDER BY lexeme) ` +
    `FROM unnest(to_tsvector('${TEXT_SEARCH_CONFIG}', $${parameterIndex})))::tsquery`;
  return {
    match: `${column} @@ ${tsquery}`,
    rank: `ts_rank(${column}, ${tsquery})`,
  };
}
