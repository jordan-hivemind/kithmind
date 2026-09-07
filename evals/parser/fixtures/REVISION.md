# Fixture revision

These fixtures were corrected before any scored parser run. The financial line
items are positioned grid cells across two pages with a repeated continuation
header; labels now cover both lab draw dates and result values plus the vehicle
service date. The partial image's readable text no longer overlaps its intended
unavailable-value region. No numeric pixels exist in that region, so this is a
missing-value negative fixture rather than a measurement of degraded-number OCR.
Its expected-gap annotation is ground truth and cannot count as automatic gap
detection.

The financial `table.row` label is the zero-based body-row index within the
table segment on the expected page, excluding the header. The page-two table is
an authored continuation, but the labels do not require the parser to infer a
cross-page table merge.

All text uses pinned vendored OFL fonts. The lab page includes BMP Unicode
(`µ`, `é`) and the supplementary-plane globe (`🌍`). The later patient assertion
therefore has different Python code-point and UTF-16 page offsets. The two scan
PDFs contain only one raster image each and no native text layer.

After the first scored run, Linux CI regenerated different bytes for the two
raster PDFs while reproducing the four native PDFs exactly. The two already-scored PDF files, labels, and hashes were not changed.
Their exact embedded RGB pixels were decoded into hashed canonical PNG assets,
and the generator now embeds those pixels instead of rasterizing fonts at run
time. The asset manifest preserves the authored rows and missing-value marker;
generation rejects metadata or asset hash mismatches. This is a portability
correction to fixture regeneration, not a corpus or scoring revision.
