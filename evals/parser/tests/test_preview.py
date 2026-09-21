from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import unittest
import zipfile
from unittest import mock

from parser_eval.preview import (
    PDF_MEDIA_TYPE,
    XLSX_MEDIA_TYPE,
    PreviewExecutionBoundary,
    preview_captured_document,
)


BOUNDARY = PreviewExecutionBoundary(network_denied=True, resource_bounded=True)
PDF_TEST_DEPENDENCIES_AVAILABLE = all(
    importlib.util.find_spec(name) is not None
    for name in ("PIL", "pdfplumber", "reportlab")
)


def _pdf(page_count: int, *, image_page: int | None = None) -> bytes:
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    output = io.BytesIO()
    document = canvas.Canvas(output, pagesize=(300, 300), pageCompression=0)
    raster = io.BytesIO()
    Image.new("RGB", (2, 2), "black").save(raster, format="PNG")
    for page_number in range(1, page_count + 1):
        if page_number == image_page:
            document.drawImage(ImageReader(io.BytesIO(raster.getvalue())), 20, 20)
        else:
            document.drawString(20, 250, f"stable original page {page_number}")
        document.showPage()
    document.save()
    return output.getvalue()


def _xlsx(
    workbook_xml: bytes,
    *,
    worksheet: bytes = b'<worksheet><c><v>PRIVATE-CELL-VALUE</v></c></worksheet>',
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("[Content_Types].xml", b"<Types/>")
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)
    return output.getvalue()


def _preview(
    data: bytes,
    media_type: str,
    windows: object,
    *,
    expected_sha256: str | None = None,
) -> dict[str, object]:
    return preview_captured_document(
        data=data,
        expected_sha256=expected_sha256 or hashlib.sha256(data).hexdigest(),
        media_type=media_type,
        requested_windows=windows,
        parent_boundary=BOUNDARY,
        timeout_seconds=10,
    )


@unittest.skipUnless(
    PDF_TEST_DEPENDENCIES_AVAILABLE,
    "PDF preview fixture dependencies are not installed",
)
class PdfPreviewTests(unittest.TestCase):
    def test_more_than_64_pages_inspects_only_requested_original_pages(self) -> None:
        original = _pdf(65)
        expanded = _pdf(75)
        windows = [
            {"startPage": 1, "pageCount": 1},
            {"startPage": 65, "pageCount": 1},
        ]

        original_result = _preview(original, PDF_MEDIA_TYPE, windows)
        expanded_result = _preview(expanded, PDF_MEDIA_TYPE, windows)

        self.assertEqual(original_result["state"], "complete")
        self.assertEqual(expanded_result["state"], "complete")
        self.assertEqual(original_result["pageCount"], 65)
        self.assertEqual(expanded_result["pageCount"], 75)
        self.assertEqual(original_result["inspectedPageNumbers"], [1, 65])
        self.assertEqual(expanded_result["inspectedPageNumbers"], [1, 65])
        self.assertEqual(len(original_result["units"]), 2)
        self.assertEqual(len(expanded_result["units"]), 2)
        self.assertIn("original page 65", original_result["units"][1]["text"])
        self.assertIn("original page 65", expanded_result["units"][1]["text"])

    def test_native_text_and_image_only_states_are_typed(self) -> None:
        data = _pdf(2, image_page=2)
        result = _preview(
            data,
            PDF_MEDIA_TYPE,
            [{"startPage": 1, "pageCount": 2}],
        )

        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["provisional"], True)
        self.assertEqual(
            [unit["state"] for unit in result["units"]],
            ["text_available", "image_only"],
        )
        self.assertEqual(result["units"][1]["text"], "")
        self.assertEqual(
            result["method"]["name"], "pdfplumber_native_text_preview"
        )
        self.assertEqual(len(result["method"]["fingerprint"]), 64)

    def test_request_bounds_duplicates_and_missing_pages_are_refused(self) -> None:
        data = _pdf(4)
        requests = [
            [],
            [{"startPage": 0, "pageCount": 1}],
            [{"startPage": 1, "pageCount": 9}],
            [
                {"startPage": 1, "pageCount": 2},
                {"startPage": 2, "pageCount": 1},
            ],
            [{"startPage": 5, "pageCount": 1}],
            [{"startPage": True, "pageCount": 1}],
            [{"startPage": 1, "pageCount": 1, "extra": 1}],
        ]
        for request in requests:
            with self.subTest(request=request):
                result = _preview(data, PDF_MEDIA_TYPE, request)
                self.assertEqual(result["state"], "failed")
                self.assertIn(
                    result["code"],
                    ("invalid_preview_request", "preview_budget_exceeded"),
                )

    def test_hash_mismatch_and_malformed_pdf_are_typed_failures(self) -> None:
        data = _pdf(1)
        mismatch = _preview(
            data,
            PDF_MEDIA_TYPE,
            [{"startPage": 1, "pageCount": 1}],
            expected_sha256="0" * 64,
        )
        malformed = _preview(
            b"not a pdf",
            PDF_MEDIA_TYPE,
            [{"startPage": 1, "pageCount": 1}],
        )

        self.assertEqual(mismatch, {"state": "failed", "code": "input_digest_mismatch"})
        self.assertEqual(malformed, {"state": "failed", "code": "malformed_document"})

    def test_text_is_bounded(self) -> None:
        from reportlab.pdfgen import canvas

        output = io.BytesIO()
        document = canvas.Canvas(output, pagesize=(300, 300), pageCompression=0)
        text = document.beginText(10, 290)
        for _ in range(200):
            text.textLine("many native characters " * 12)
        document.drawText(text)
        document.showPage()
        document.save()

        result = _preview(
            output.getvalue(),
            PDF_MEDIA_TYPE,
            [{"startPage": 1, "pageCount": 1}],
        )

        self.assertEqual(result["state"], "complete")
        self.assertLessEqual(len(result["units"][0]["text"]), 384)
        self.assertTrue(result["units"][0]["textTruncated"])


class XlsxPreviewTests(unittest.TestCase):
    workbook_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Current" sheetId="1"/>
    <sheet name="Archive" sheetId="2" state="hidden"/>
    <sheet name="System" sheetId="3" state="veryHidden"/>
  </sheets>
</workbook>"""

    def test_reads_workbook_metadata_without_opening_cells(self) -> None:
        data = _xlsx(self.workbook_xml)
        opened: list[str] = []
        real_open = zipfile.ZipFile.open

        def recording_open(archive, name, *args, **kwargs):
            opened.append(name.filename if isinstance(name, zipfile.ZipInfo) else name)
            return real_open(archive, name, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, "open", recording_open):
            result = _preview(data, XLSX_MEDIA_TYPE, [])

        self.assertEqual(result["state"], "complete")
        self.assertEqual(opened, ["xl/workbook.xml"])
        self.assertEqual(result["sheetCount"], 3)
        self.assertEqual(
            result["sheets"],
            [
                {"name": "Current", "visibility": "visible"},
                {"name": "Archive", "visibility": "hidden"},
                {"name": "System", "visibility": "veryHidden"},
            ],
        )
        self.assertNotIn("PRIVATE-CELL-VALUE", json.dumps(result))
        self.assertEqual(
            result["method"]["name"], "xlsx_workbook_metadata_preview"
        )

    def test_xlsx_refuses_windows_malformed_xml_and_entities(self) -> None:
        cases = [
            (
                _xlsx(self.workbook_xml),
                [{"startPage": 1, "pageCount": 1}],
                "invalid_preview_request",
            ),
            (_xlsx(b"<workbook>"), [], "malformed_document"),
            (
                _xlsx(
                    b'<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
                    + self.workbook_xml
                ),
                [],
                "xlsx_xml_unsafe",
            ),
        ]
        for data, windows, code in cases:
            with self.subTest(code=code):
                self.assertEqual(
                    _preview(data, XLSX_MEDIA_TYPE, windows),
                    {"state": "failed", "code": code},
                )

    def test_xlsx_rejects_duplicate_entries_and_compression_bomb_ratio(self) -> None:
        duplicate = io.BytesIO()
        with zipfile.ZipFile(duplicate, "w") as archive:
            archive.writestr("xl/workbook.xml", self.workbook_xml)
            with self.assertWarns(UserWarning):
                archive.writestr("xl/workbook.xml", self.workbook_xml)
        bomb = io.BytesIO()
        with zipfile.ZipFile(
            bomb, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            archive.writestr("xl/workbook.xml", b" " * (128 * 1024))

        for data in (duplicate.getvalue(), bomb.getvalue()):
            with self.subTest(size=len(data)):
                self.assertEqual(
                    _preview(data, XLSX_MEDIA_TYPE, []),
                    {"state": "failed", "code": "xlsx_archive_unsafe"},
                )


@unittest.skipUnless(
    PDF_TEST_DEPENDENCIES_AVAILABLE,
    "PDF preview fixture dependencies are not installed",
)
class BoundaryTests(unittest.TestCase):
    def test_parent_execution_attestations_are_required(self) -> None:
        data = _pdf(1)
        result = preview_captured_document(
            data=data,
            expected_sha256=hashlib.sha256(data).hexdigest(),
            media_type=PDF_MEDIA_TYPE,
            requested_windows=[{"startPage": 1, "pageCount": 1}],
            parent_boundary=PreviewExecutionBoundary(
                network_denied=False,
                resource_bounded=True,
            ),
            timeout_seconds=10,
        )

        self.assertEqual(
            result, {"state": "failed", "code": "invalid_preview_request"}
        )


if __name__ == "__main__":
    unittest.main()
