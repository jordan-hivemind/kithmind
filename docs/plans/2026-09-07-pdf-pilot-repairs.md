# PDF pilot repairs

Status: implemented and locally verified. Source: P2-2 pilot; tracked as P2-18.

A local document pilot exposed malformed parser responses, output-limit
failures, masked conversion errors, and ambiguous text provenance. Successful
text extraction alone is not successful ingestion. Admission still requires
validated source locators, complete mapping, and all configured bounds.

## Scope

- Keep launcher stdout exclusively machine-readable, including when parser
  dependencies write native logs. Preserve network denial and resource limits.
- Preserve bounded, allowlisted parser failure reasons across process exit.
  Unexpected exits and arbitrary output remain failures.
- Resolve legitimate provenance cases from retained parser evidence. Do not
  invent source locations, silently omit substantive text, or waive mapping gaps.
- Measure remaining document capacity after these repairs. Any unsupported
  document remains an explicit failure, without truncation or partial activation.
- Preserve existing parser artifact and extraction identity semantics. A changed
  normalizer requires a new extraction fingerprint; old evidence remains valid.

## Acceptance

Synthetic regressions cover protocol noise, malformed responses, abnormal
termination, structured failures and provenance edge cases. Run the required
repository checks and independent review. Repeat the local pilot and report
parser acceptance separately from mapper admission, citation spot-checks and
hosted publication. Private documents and derived content never enter public
fixtures. Existing source files remain unchanged.

This work does not modify the separate financial transaction database plan.

## Capacity boundary

This patch retains the current 32-page, 128-evidence-span and 256 KiB
retained-text limits. Increasing page count alone does not make a long PDF
admissible. The primary document stores every evidence ID and is limited to
16 KiB; the payload manifest is limited to 64 KiB and payload verification
reads are bounded at 8 MiB. Evidence capacity requires a separately reviewed
storage change with aggregate byte budgets and legacy compatibility. It is
tracked separately from these parser correctness repairs.

CPU exhaustion reported by SIGXCPU is surfaced as `cpu_limit_exceeded`.
The existing CPU, wall-time and memory bounds remain enforced.

An oversized document must report its specific limit failure. It must not
be truncated, silently split into independent documents, or marked indexed.

## Implemented behavior

The launcher reserves a separate descriptor for its JSON response before
importing parser libraries. Ordinary Python and native stdout/stderr are
discarded; parser artifacts remain in protected files. Process output and
resource limits still apply. Only an exact allowlisted failure envelope paired
with exit code 2 carries a specific parser failure through to the worker.

Same-page multi-span text retains the exact ordered raw provenance list. The
Python and TypeScript validators require nonoverlapping spans, full substantive
text coverage, and identical Unicode White_Space rules for separator gaps.
Cross-page, reordered, altered or incompletely covered text remains rejected.
Existing single-span evidence stays compatible. The normalization change
versions the extraction fingerprint without changing the raw parser identity.

## Verification result

The local pilot improved from zero to four documents passing both parser and
citation-mapping admission. All selected source files remained unchanged.
Other documents remained rejected for resource exhaustion, cross-page item
provenance, or document/evidence capacity. Hosted publication was not part of
this local test.

All four repository checks pass. The Python suite passes without Docling
installed, and the local Node suite exercises real conversion with the pinned
models. Independent review resolved exit-status pairing and Unicode-whitespace
parity before acceptance.
