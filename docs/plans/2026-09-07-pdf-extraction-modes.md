# Explicit PDF extraction modes

Status: implementation in progress, tracked as P2-20.

The P2-19 pilot exposed visible worksheet fields missing from Docling's raw
output. A private single-page comparison recovered all three labeled fields and
all native text/numeric tokens when table-structure recognition was disabled.
The same model/runtime with table recognition enabled omitted those fields.
This justifies evaluating a second mode; it does not establish a better global
default or guarantee complete extraction for arbitrary PDFs.

## Mode selection and identity

Add an optional `pdfDocQa.parser.tableStructure` setting with exactly `on` or
`off`; omission selects `on`. Apply it to the whole document through Docling's
`do_table_structure` option. Keep OCR and the existing sandbox/resource budgets.
Do not automatically merge outputs or select a mode using a one-cell heuristic.

A new parser fingerprint descriptor version records the selected mode. Preserve
strict validation and inspection of the existing descriptor version, whose
configuration implies table structure enabled. The raw Docling JSON and exact
item/table/page citation contracts remain unchanged. Extraction identity includes
the parser fingerprint, so different modes cannot share an extraction identity.

Pass mode selection through configuration validation, profile preparation,
launcher arguments and conversion. Validate that both preparation and conversion
return the requested mode, including rejection when a legacy descriptor is
returned for an `off` request. Invalid modes must fail before parsing. Existing
profile mismatch and archived-work transition rules still apply; changing a
setting must not resume incomplete work under a different identity.

## Evaluation and acceptance

- Verify legacy descriptor inspection, strict new descriptor validation, distinct
  mode fingerprints, argument propagation and mismatched-mode rejection.
- Run actual local conversions with both modes on synthetic text, table, scan
  and Unicode fixtures. Check source fields and label/value associations, not
  only aggregate token counts. Validate exact raw-to-normalized provenance.
- Repeat the private pilot with the alternative mode and compare it with the
  retained table-on outputs. Preserve originals and keep private evidence out of
  the repository. Check the missing worksheet fields and previously selected
  invoice fields, plus representative ordinary table associations.
- Keep table-on as the default. Adopt another mode for the owner pilot only when
  its measured results justify that selection; report unresolved omissions.
- Complete independent review and all four repository checks before release.

This work does not claim automatic source-completeness certification. Native text
can help audit digital PDFs; it cannot establish completeness for image-only or
mixed pages. If the alternative loses meaningful associations or leaves known
omissions, keep that document in review and evaluate another explicit strategy.

Owner publication still depends on independent backup and recoverable keys.
The independent financial archive and its plans remain outside this change.
