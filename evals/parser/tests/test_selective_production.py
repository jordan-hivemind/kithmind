from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from parser_eval.production import ParentExecutionBoundary, ProductionFailure
from parser_eval.selective_production import (
    _coverage,
    _stable_pdfium_document_id,
    convert_selective_captured_pdf,
    select_pdf_pages,
)


def _pdf(page_count: int) -> bytes:
    from reportlab.pdfgen.canvas import Canvas

    output = BytesIO()
    canvas = Canvas(output)
    for page in range(1, page_count + 1):
        canvas.drawString(72, 720, f"Synthetic original page {page}")
        canvas.showPage()
    canvas.save()
    return output.getvalue()


def _texts(data: bytes) -> list[str]:
    from pypdf import PdfReader

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


def test_selected_pdf_and_coverage_are_deterministic_for_identical_requests() -> None:
    data = _pdf(500)
    source_sha256 = hashlib.sha256(data).hexdigest()

    first, first_count = select_pdf_pages(data, (137, 138))
    second, second_count = select_pdf_pages(data, (137, 138))
    first_sha256 = hashlib.sha256(first).hexdigest()
    second_sha256 = hashlib.sha256(second).hexdigest()

    assert first == second
    assert first_sha256 == second_sha256
    assert _coverage(
        source_sha256=source_sha256,
        selected_pdf_sha256=first_sha256,
        source_page_count=first_count,
        original_pages=(137, 138),
    ) == _coverage(
        source_sha256=source_sha256,
        selected_pdf_sha256=second_sha256,
        source_page_count=second_count,
        original_pages=(137, 138),
    )


def test_document_id_stabilization_only_changes_the_final_trailer() -> None:
    content_id = b"A" * 32
    trailer_id = b"B" * 32
    value = (
        b"%PDF-1.7\nstream\n/ID[<"
        + content_id
        + b"><"
        + content_id
        + b">]\nendstream\ntrailer\n<</Size 2/ID[<"
        + trailer_id
        + b"><"
        + trailer_id
        + b">]>>\nstartxref\n42\n%%EOF\n"
    )

    stabilized = _stable_pdfium_document_id(value, b"source", (1,))

    assert stabilized.count(content_id) == 2
    assert trailer_id not in stabilized
    assert len(stabilized) == len(value)


def test_select_pdf_pages_rejects_invalid_page_boundaries() -> None:
    cases = ((1, 1), (2, 1), (1, 3), (True,))
    for original_pages in cases:
        try:
            select_pdf_pages(_pdf(2), original_pages)
        except ProductionFailure as exc:
            assert exc.code == "invalid_input"
        else:
            raise AssertionError(f"accepted invalid pages: {original_pages!r}")


def test_selective_conversion_rejects_a_source_hash_mismatch() -> None:
    data = _pdf(2)
    result = convert_selective_captured_pdf(
        data=data,
        expected_sha256="0" * 64,
        opaque_input_name=f"pdf-{'0' * 64}.pdf",
        original_pages=[1],
        artifacts=Path("artifacts"),
        model_lock=Path("model-assets.lock.json"),
        parent_boundary=ParentExecutionBoundary(
            network_denied=True, resource_bounded=True
        ),
    )

    assert result == {"state": "failed", "code": "input_digest_mismatch"}


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


def test_selective_launcher_writes_only_the_distinct_wrapper() -> None:
    source_root = Path(__file__).parents[1] / "src" / "parser_eval"
    data = b"%PDF-synthetic-selective-launcher"
    source_sha256 = hashlib.sha256(data).hexdigest()
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        package = root / "parser_eval"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        for name in ("production_launcher.py", "selective_production_launcher.py"):
            shutil.copy2(source_root / name, package / name)
        (package / "production.py").write_text(
            "class ParentExecutionBoundary:\n"
            "    def __init__(self, **_kwargs): pass\n",
            encoding="utf-8",
        )
        (package / "selective_production.py").write_text(
            '''
def convert_selective_captured_pdf(**arguments):
    pages = arguments["original_pages"]
    raw = {}
    selected = {
        "pages": [{"page": index + 1} for index, _page in enumerate(pages)],
        "extractionFingerprint": {"fingerprint": "c" * 64},
    }
    coverage = {
        "sourcePageCount": 500,
        "originalPages": pages,
        "selectedPdfSha256": "d" * 64,
        "fingerprint": "e" * 64,
    }
    return {
        "state": "complete",
        "rawArtifact": {
            "json": raw,
        "sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "byteLength": 2,
            "parserFingerprint": {"fingerprint": "b" * 64, "modelManifestSha256": "a" * 64},
        },
        "normalizedBundle": {
            "schemaVersion": 1,
            "artifactKind": "selective_pdf_pages_v1",
            "sourceSha256": arguments["expected_sha256"],
            "selectiveImplementationSha256": "f" * 64,
            "coverage": coverage,
            "selectedBundle": selected,
            "artifactFingerprint": "1" * 64,
        },
        "selectedOriginalPages": pages,
        "sourcePageCount": 500,
        "selectedPdfSha256": "d" * 64,
        "coverageFingerprint": "e" * 64,
        "artifactFingerprint": "1" * 64,
        "selectiveImplementationSha256": "f" * 64,
    }
''',
            encoding="utf-8",
        )
        source = root / "source.pdf"
        source.write_bytes(data)
        output = root / "output"
        output.mkdir()
        raw_path = output / "selective-lossless.json"
        bundle_path = output / "selective-bundle.json"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "parser_eval.selective_production_launcher",
                "--mode",
                "convert-selective",
                "--cpu-seconds",
                "2",
                "--file-bytes",
                str(1024 * 1024),
                "--open-files",
                "64",
                "--input",
                str(source),
                "--expected-sha256",
                source_sha256,
                "--output-directory",
                str(output),
                "--raw-output",
                str(raw_path),
                "--bundle-output",
                str(bundle_path),
                "--artifacts",
                "/artifacts",
                "--model-lock",
                "/model-lock",
                "--conversion-timeout-seconds",
                "1",
                "--selected-original-pages",
                "[137,138]",
            ],
            check=False,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": temporary},
        )
        assert result.returncode == 0
        assert result.stderr == ""
        response = json.loads(result.stdout)
        assert response["selectedOriginalPages"] == [137, 138]
        assert response["sourcePageCount"] == 500
        assert json.loads(bundle_path.read_text())["artifactKind"] == (
            "selective_pdf_pages_v1"
        )


@unittest.skipUnless(
    all(
        importlib.util.find_spec(name) is not None
        for name in ("pypdf", "pypdfium2", "reportlab")
    ),
    "selective PDF fixture dependencies are unavailable",
)
class SelectiveProductionTest(unittest.TestCase):
    def test_bounded_selection(self) -> None:
        test_selected_work_is_bounded_when_appendix_grows_from_20_to_500_pages()

    def test_deterministic_identity(self) -> None:
        test_selected_pdf_and_coverage_are_deterministic_for_identical_requests()

    def test_trailer_binding(self) -> None:
        test_document_id_stabilization_only_changes_the_final_trailer()

    def test_invalid_pages(self) -> None:
        test_select_pdf_pages_rejects_invalid_page_boundaries()

    def test_source_hash_mismatch(self) -> None:
        test_selective_conversion_rejects_a_source_hash_mismatch()

    def test_original_page_mapping(self) -> None:
        test_original_pages_137_and_138_are_bound_to_the_original_source()

    def test_launcher_boundary(self) -> None:
        test_selective_launcher_writes_only_the_distinct_wrapper()
