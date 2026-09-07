# Synthetic parser evaluation

This directory contains a pinned, synthetic-only comparison of Docling's
standard CPU PDF pipeline with RapidOCR and a pdfplumber native-text baseline.
It does not ingest owner documents or publish records.

Run every command below from the evaluator directory:

```sh
cd evals/parser
```

The pinned tools are uv 0.10.2 and CPython 3.12.12. Scored conversion currently
requires macOS with `/usr/bin/sandbox-exec` available.

## Reproduce the authored fixtures

The generator uses a vendored font and a dependency group that excludes the
Docling runtime:

```sh
uv run --frozen --only-group fixture python generate_fixtures.py
uv run --frozen --only-group fixture python test_fixtures.py
```

## Prepare pinned models online

A public checkout already contains the reviewed model lock. Choose a fresh,
absent output directory; setup refuses to merge with or replace existing model
state:

```sh
uv run --frozen kith-parser-models --output artifacts/models --lock-output model-assets.lock.json
```

Setup downloads the locked revisions and verifies every runtime asset byte.
Model setup is the only networked phase. The ignored `artifacts/` directory is
local runtime state; the model lock is tracked.

### Maintainer-only first pin

The first reviewed pin is an explicit bootstrap operation. It resolves the
declared upstream revisions once, downloads the selected model files, and
writes their revisions, source URLs, license files, byte sizes, and hashes to
`model-assets.lock.json`:

```sh
uv run --frozen kith-parser-models --bootstrap --output artifacts/models --lock-output model-assets.lock.json
```

Bootstrap refuses an existing lock and is not part of normal reproduction.
Commit and review a bootstrapped lock before any scored run. Normal setup never
updates it.

## Run the fixed evaluation offline

```sh
uv run --frozen kith-parser-eval --labels fixtures/labels.v1.json --artifacts artifacts/models --model-lock model-assets.lock.json --output outputs/scored
```

Each converter child receives bounded local PDF bytes through its parser
adapter. Docling accepts PDF only, uses the explicit local artifact directory,
disables remote services and external plugins, and runs on CPU. On macOS every
converter child also runs under `sandbox-exec` with network access denied; a
negative socket probe must observe that denial before evaluation starts.
Environment offline flags are defense in depth and are not described as an OS
sandbox. Linux scored conversion is refused because equivalent network
isolation has not been implemented or verified.

The report retains normalized per-page text, verified UTF-16 evidence spans,
parser locators, full Docling JSON, table cells, model and dependency identity,
resources, and every scored failure. Docling item-local character spans and
bounding boxes remain locators. They are never copied into Brain evidence
offsets. Expected gaps are ground-truth annotations only; automatic unknown
field and record-coverage detection remains P2-10.

## Lightweight checks

These checks do not import Docling or download models:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_*.py'
```
