from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from parser_eval.production import ParentExecutionBoundary
from parser_eval.selective_production import (
    convert_selective_captured_pdf,
    select_pdf_pages,
)


def _pdf(page_count: int) -> bytes:
    output = BytesIO()
    canvas = Canvas(output)
    for page in range(1, page_count + 1):
        canvas.drawString(72, 720, f"Synthetic original page {page}")
        canvas.showPage()
    canvas.save()
    return output.getvalue()


def _texts(data: bytes) -> list[str]:
    return [page.extract_text().strip() for page in PdfReader(BytesIO(data)).pages]


def test_selected_work_is_bounded_when_appendix_grows_from_20_to_500_pages() -> None:
    short_selected, short_count = select_pdf_pages(_pdf(20), (1, 2))
    long_selected, long_count = select_pdf_pages(_pdf(500), (1, 2))

    assert short_count == 20
    assert long_count == 500
    assert _texts(short_selected) == [
        "Synthetic original page 1",
        "Synthetic original page 2",
    ]
    assert _texts(long_selected) == _texts(short_selected)
    assert len(long_selected) < len(short_selected) * 2


def test_original_pages_137_and_138_are_bound_to_the_original_source() -> None:
    data = _pdf(500)
    source_sha256 = hashlib.sha256(data).hexdigest()

    def convert_subset(**arguments):
        assert arguments["expected_sha256"] == hashlib.sha256(
            arguments["data"]
        ).hexdigest()
        assert _texts(arguments["data"]) == [
            "Synthetic original page 137",
            "Synthetic original page 138",
        ]
        return {
            "state": "complete",
            "normalizedBundle": {
                "sourceSha256": arguments["expected_sha256"],
                "pages": [{"page": 1}, {"page": 2}],
                "extractionFingerprint": {"fingerprint": "c" * 64},
            },
            "rawArtifact": {
                "sha256": "b" * 64,
                "byteLength": 2,
                "json": {},
                "parserFingerprint": {"fingerprint": "d" * 64},
            },
            "tableStructureBypassPages": [],
        }

    with patch(
        "parser_eval.selective_production.convert_captured_pdf",
        side_effect=convert_subset,
    ) as converter:
        result = convert_selective_captured_pdf(
            data=data,
            expected_sha256=source_sha256,
            opaque_input_name=f"pdf-{source_sha256}.pdf",
            original_pages=[137, 138],
            artifacts=Path("artifacts"),
            model_lock=Path("model-assets.lock.json"),
            parent_boundary=ParentExecutionBoundary(
                network_denied=True, resource_bounded=True
            ),
        )

    assert result["state"] == "complete"
    assert converter.call_count == 1
    wrapper = result["normalizedBundle"]
    coverage = wrapper["coverage"]
    assert wrapper["artifactKind"] == "selective_pdf_pages_v1"
    assert wrapper["sourceSha256"] == source_sha256
    assert coverage["sourceSha256"] == source_sha256
    assert coverage["sourcePageCount"] == 500
    assert coverage["originalPages"] == [137, 138]
    assert coverage["selectedPdfSha256"] == wrapper["selectedBundle"][
        "sourceSha256"
    ]
    assert result["coverageFingerprint"] == coverage["fingerprint"]
    assert result["artifactFingerprint"] == wrapper["artifactFingerprint"]
    assert "pages" not in wrapper
