# PDF document-Q&A pipeline

## Status

The optional PDF path connects the filesystem runner to protected capture,
encrypted archives, parsing, durable journal replay, cloud admission, and
parsed staging and activation. The bounded synthetic lifecycle and recovery
checks have passed on macOS. Source binary ingestion is explicitly gated; do
not enable an owner source until its operational and backup checks pass. Existing text ingestion
continues without the optional PDF configuration.

The foundation converts one bounded, privately captured PDF with the pinned
parser runtime and returns two separate artifacts:

- a lossless parser artifact for private retention; and
- a bounded normalized page bundle with page-relative UTF-16 evidence spans
  and locators.

The converter requires a digest-bound opaque input name. It rejects malformed
or oversized input and unsafe conversion output. Its parent must supply the
actual network-denied, resource-bounded subprocess boundary. A Python flag or
the parent attestation alone is not that boundary.

The optional macOS parent helper supplies that boundary with a deny-default
OS sandbox, separate network/fork/exec probes, supported process limits, a
wall deadline, bounded output, and process monitoring. Each invocation uses
an empty private output directory. RSS is a sampled ceiling, not a strict
allocation cap. Unsupported platforms fail closed. Capture deadlines do not
guarantee cancellation of every pending kernel filesystem operation.

`prepare_pdf_profile` verifies the installed runtime and model assets and
computes the parser and extraction-configuration identities without parsing a
PDF. The scan can therefore identify its configuration before conversion.
After conversion, the final extraction fingerprint also binds the retained
parser artifact digest, using the shared derivation in the
[original-byte contract](plans/2026-09-07-original-byte-contract.md).

## What remains before use

Before owner files, confirm source recovery and monitoring, plus an independent backup destination that
survives loss of the source computer and primary archive. Passing parser or
unit tests alone does not establish this recovery boundary.

The [backup and restore guide](backup-and-restore.md) separates hosted data
recovery from encrypted archives, worker state, configuration, and keys.

The synthetic acceptance run published two PDFs, published nothing on an
unchanged scan, and resumed a corrected PDF from a durable pending upload.
Hosted reads verified the current and historical text and exact UTF-16 quote
hashes. All twelve archive copies decrypted to their expected original or
parser-artifact hashes. Six backup copies also restored with the source folder
and primary archive unavailable. The backup used a separate mounted filesystem
on the same computer, so it does not establish physical failure independence.

Owner-begun forget removed four configured archive copies, replayed the CLI
without changing its result, and finalized a content-free tombstone. A later
scan completed without reimporting the still-present forgotten source file.
Isolated native restore preserved the exact final schema and exported values,
including correction history and the tombstone. Copies deliberately made for
isolated restore or operator diagnostics are outside the configured worker's
forget operation.

The document-Q&A trial may publish verified pages and citations. It does not
automatically publish structured records. Field extraction, review, coverage,
and record activation remain later work.

The synthetic parser evaluation remains separate. Keep its fixtures, recipes,
and scored outputs unchanged; do not use evaluation labels or scoring code as
the production interface. See the [parser evaluation guide](../evals/parser/README.md).

## Single-owner configuration

Use the existing worker configuration and commands. Add `pdfDocQa` only for
an explicitly enabled PDF source. The JSON loader rejects unknown fields,
unpinned profiles and unsafe paths. Do not put private keys or passwords in
the configuration or repository.

| Configuration group                                      | Required values and purpose                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captureDirectory`, `parserOutputRoot`, `spoolDirectory` | Separate private local working directories. Capture and parser/spool plaintext are retained through durable activation, then removed by exact identity.                                                                          |
| `parser`                                                 | Absolute Python/launcher/package/model paths and the verified Python, launcher and model-lock digests. Profile preparation checks the installed runtime before scanning.                                                         |
| `profile`                                                | `pdf_docqa_v1`, parser and extraction-configuration identities, extractor/record/normalization/chunker fingerprints, and correction revision. Use measured runtime identities, never invented digests.                           |
| `archive.ageBinary`                                      | Verified pinned age executable.                                                                                                                                                                                                  |
| `archive.primary`                                        | Private archive directory, public age recipient, and recorded archive/recipient/key-domain/storage-domain fingerprints.                                                                                                          |
| `archive.independentBackup`                              | Separate directory and age recipient, restic executable/repository/expected repository ID, password-command selector, host and identity fingerprints. Private passwords are returned by the configured local credential command. |

The exact closed fields are defined in
[`PdfDocQaConfig`](../packages/pipeline/src/types.ts). Keep the source roots
separate from capture, parser, spool and archive directories. The source must
not ingest its own generated artifacts. Use a small explicitly selected folder
for the first trial.

```sh
pnpm brain:worker -- doctor --config /absolute/path/worker.json --json
pnpm brain:worker -- run --config /absolute/path/worker.json
```

A completed document assessment means the configured document inventory was
processed. It does not establish medical or financial record/date coverage.
The PDF path publishes no automatic structured records. Hosted text and
citations remain readable when the local worker is offline; opening original
bytes or reprocessing can require the desktop and archive keys.

Changing parser or archive configuration is not a routine restart. The journal
binding rejects an incompatible profile. Preserve the original configuration
and catalog for explicit recovery; automatic profile migration is deferred.
An interrupted encryption whose output identity was never recorded requires
review and preserves that temporary ciphertext. Do not delete or adopt it by
filename alone.

## Focused verification

Run these from the repository root:

```sh
PYTHONPATH=evals/parser/src python3 -m unittest discover -s evals/parser/tests -p 'test_*.py'
pnpm --filter @repo/pipeline test:once
pnpm --filter @repo/db test:once
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

The first command is the lightweight Python stdlib suite. It does not download
Docling models. The final four commands are the repository-wide required
checks.

## Pinned external tools

The archive helpers use external executables rather than reimplementing their
formats. The selected releases are [age v1.3.2](https://github.com/FiloSottile/age/releases/tag/v1.3.2)
and [restic v0.19.1](https://github.com/restic/restic/releases/tag/v0.19.1).
Release verification passed using age Sigsum proofs with verifier v0.13.1
and policy `sigsum-generic-2025-1`, and restic signatures with the
release signing key `CF8F18F2844575973F79D4E191A6868BD3F7A907`.

The tested macOS-arm64 artifacts have these SHA-256 values:

| Artifact                       | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| age v1.3.2 release archive     | `e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5` |
| `age`                          | `4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e` |
| `age-keygen`                   | `c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea` |
| restic v0.19.1 release archive | `7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143` |
| `restic`                       | `06582569ff2f10e1935a6f12187c76db02f0bae99e6e54098f2cdc374766d768` |

Verify the distribution for your own platform using the
[age proof instructions](https://github.com/FiloSottile/age/blob/v1.3.2/SIGSUM.md)
and [restic signature instructions](https://restic.readthedocs.io/en/stable/020_installation.html).
Worker integration and recovery acceptance remain separate checks.
