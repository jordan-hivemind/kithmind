# PDF pipeline development foundation

## Status

The P2-9 parser and archive helpers are currently inert. They are not wired
into the filesystem worker, remote worker protocol, or journal. The additive
database foundation preserves existing text ingestion; production PDF ingestion
remains disabled. Owner documents require the integration and recovery checks
below.

The foundation converts one bounded, privately captured PDF with the pinned
parser runtime and returns two separate artifacts:

- a lossless parser artifact for private retention; and
- a bounded normalized page bundle with page-relative UTF-16 evidence spans
  and locators.

The converter requires a digest-bound opaque input name. It rejects malformed
or oversized input and unsafe conversion output. Its parent must supply the
actual network-denied, resource-bounded subprocess boundary. A Python flag or
the parent attestation alone is not that boundary.

## What remains before use

The parent integration must still provide secure capture handling, operating
system sandboxing and resource limits, durable journal and replay behavior,
remote binary admission, private artifact retention, and authorized cleanup or
forget behavior. It must invoke the externally pinned archive executables and
bind their output to the source revision. This foundation does not make the
existing worker ready for PDFs.

The document-Q&A trial may publish verified pages and citations. It does not
automatically publish structured records. Field extraction, review, coverage,
and record activation remain later work.

The synthetic parser evaluation remains separate. Keep its fixtures, recipes,
and scored outputs unchanged; do not use evaluation labels or scoring code as
the production interface. See the [parser evaluation guide](../evals/parser/README.md).

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
