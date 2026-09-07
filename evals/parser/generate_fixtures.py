#!/usr/bin/env python3
"""Generate deterministic synthetic parser fixtures and authored labels."""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from json import JSONDecodeError, dump, loads
from pathlib import Path
from typing import Any

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase import ttfonts
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

HERE = Path(__file__).parent
OUT = HERE / "fixtures"
ASSETS = HERE / "assets"
TEXT_FONT_PATH = ASSETS / "NotoSans.ttf"
TEXT_FONT_SHA256 = "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"
TEXT_FONT_NAME = "NotoSans"
SYMBOL_FONT_PATH = ASSETS / "NotoSansSymbols2-Regular.ttf"
SYMBOL_FONT_SHA256 = "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21"
SYMBOL_FONT_NAME = "NotoSansSymbols2"
RASTER_MANIFEST_PATH = ASSETS / "scan-rasters.v1.json"
RASTER_MANIFEST_SHA256 = "5cb42cd8780b80346c74fc83ecdce613203c82835a293c9ce54e493a1db569dd"


def _to_unicode_cmap(font_name: str, subset: list[int]) -> str:
    """Write valid UTF-16BE CMap values, including supplementary characters."""
    entries = [
        f"<{index:02X}> <{chr(codepoint).encode('utf-16-be').hex().upper()}>"
        for index, codepoint in enumerate(subset)
    ]
    return "\n".join(
        [
            "/CIDInit /ProcSet findresource begin",
            "12 dict begin",
            "begincmap",
            "/CIDSystemInfo",
            f"<< /Registry ({font_name})",
            f"/Ordering ({font_name})",
            "/Supplement 0",
            ">> def",
            f"/CMapName /{font_name} def",
            "/CMapType 2 def",
            "1 begincodespacerange",
            f"<00> <{len(subset) - 1:02X}>",
            "endcodespacerange",
            f"{len(subset)} beginbfchar",
            *entries,
            "endbfchar",
            "endcmap",
            "CMapName currentdict /CMap defineresource pop",
            "end",
            "end",
        ]
    )


def require_pinned_assets() -> dict[str, dict[str, Any]]:
    expected = {
        TEXT_FONT_PATH: TEXT_FONT_SHA256,
        SYMBOL_FONT_PATH: SYMBOL_FONT_SHA256,
    }
    for font_path, expected_hash in expected.items():
        try:
            font_bytes = font_path.read_bytes()
        except OSError as exc:
            raise RuntimeError(f"cannot read vendored fixture font: {exc}") from exc
        if sha256(font_bytes).hexdigest() != expected_hash:
            raise RuntimeError(f"vendored fixture font hash mismatch: {font_path.name}")

    try:
        manifest_bytes = RASTER_MANIFEST_PATH.read_bytes()
    except OSError as exc:
        raise RuntimeError(f"cannot read canonical raster manifest: {exc}") from exc
    if sha256(manifest_bytes).hexdigest() != RASTER_MANIFEST_SHA256:
        raise RuntimeError("canonical raster manifest hash mismatch")
    try:
        manifest = loads(manifest_bytes)
    except (UnicodeDecodeError, JSONDecodeError) as exc:
        raise RuntimeError("canonical raster manifest is not valid UTF-8 JSON") from exc
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "rasters"}
        or manifest.get("schemaVersion") != 1
        or not isinstance(manifest.get("rasters"), list)
        or len(manifest["rasters"]) != 2
    ):
        raise RuntimeError("canonical raster manifest has an unsupported shape")
    rasters: dict[str, dict[str, Any]] = {}
    expected_fields = {
        "id",
        "file",
        "sha256",
        "width",
        "height",
        "mode",
        "authoredRows",
        "missingValue",
        "missingValueText",
    }
    for value in manifest["rasters"]:
        if not isinstance(value, dict) or set(value) != expected_fields:
            raise RuntimeError("canonical raster entry has an unsupported shape")
        raster_id = value.get("id")
        filename = value.get("file")
        digest = value.get("sha256")
        rows = value.get("authoredRows")
        missing_value = value.get("missingValue")
        missing_text = value.get("missingValueText")
        if (
            raster_id not in {"image-clear", "image-partial"}
            or raster_id in rasters
            or not isinstance(filename, str)
            or Path(filename).name != filename
            or not isinstance(digest, str)
            or len(digest) != 64
            or not isinstance(rows, list)
            or not rows
            or any(not isinstance(row, str) or not row for row in rows)
            or not isinstance(missing_value, bool)
            or missing_value != (missing_text is not None)
            or (missing_text is not None and not isinstance(missing_text, str))
            or value.get("width") != 1600
            or value.get("height") != 2100
            or value.get("mode") != "RGB"
        ):
            raise RuntimeError("canonical raster entry is invalid")
        raster_path = ASSETS / filename
        try:
            raster_bytes = raster_path.read_bytes()
        except OSError as exc:
            raise RuntimeError(f"cannot read canonical raster: {filename}") from exc
        if sha256(raster_bytes).hexdigest() != digest:
            raise RuntimeError(f"canonical raster hash mismatch: {filename}")
        try:
            with Image.open(BytesIO(raster_bytes)) as image:
                image.load()
                if image.format != "PNG" or image.mode != "RGB" or image.size != (1600, 2100):
                    raise RuntimeError(f"canonical raster format mismatch: {filename}")
        except OSError as exc:
            raise RuntimeError(f"cannot decode canonical raster: {filename}") from exc
        rasters[raster_id] = value
    if set(rasters) != {"image-clear", "image-partial"}:
        raise RuntimeError("canonical raster manifest is incomplete")

    # ReportLab 4.4.3 emits non-BMP ToUnicode values as invalid odd-length hex.
    # Keep its deterministic subset embedding and supply a standards-compliant CMap.
    ttfonts.makeToUnicodeCMap = _to_unicode_cmap
    pdfmetrics.registerFont(TTFont(TEXT_FONT_NAME, TEXT_FONT_PATH))
    pdfmetrics.registerFont(TTFont(SYMBOL_FONT_NAME, SYMBOL_FONT_PATH))
    return rasters


def fixture_canvas(name: str) -> Canvas:
    canvas = Canvas(
        str(OUT / name),
        pagesize=letter,
        invariant=1,
        pageCompression=1,
    )
    canvas.setTitle("Synthetic parser fixture")
    canvas.setAuthor("Kith Mind synthetic fixture generator")
    canvas.setCreator("Kith Mind")
    return canvas


def draw_lines(canvas: Canvas, rows: list[str], y: float = 740) -> None:
    for row in rows:
        font_name = SYMBOL_FONT_NAME if any(ord(character) > 0xFFFF for character in row) else TEXT_FONT_NAME
        canvas.setFont(font_name, 11)
        canvas.drawString(54, y, row)
        y -= 20


def write_text_pdf(name: str, pages: list[list[str]]) -> None:
    canvas = fixture_canvas(name)
    for page in pages:
        draw_lines(canvas, page)
        canvas.showPage()
    canvas.save()


def write_image_pdf(
    name: str,
    rows: list[str],
    raster: dict[str, Any],
    *,
    missing_value_text: str | None = None,
) -> None:
    if (
        raster.get("id") != name
        or raster.get("authoredRows") != rows
        or raster.get("missingValueText") != missing_value_text
    ):
        raise RuntimeError(f"authored raster metadata mismatch: {name}")
    encoded = BytesIO((ASSETS / raster["file"]).read_bytes())
    canvas = fixture_canvas(f"{name}.pdf")
    canvas.drawImage(
        ImageReader(encoded),
        36,
        36,
        width=540,
        height=720,
        preserveAspectRatio=True,
        anchor="c",
    )
    canvas.save()


def draw_table(canvas: Canvas, header: list[str], rows: list[list[str]], *, y: float) -> None:
    x = 54
    widths = [170, 130, 130]
    height = 28
    values = [header, *rows]
    canvas.setFont(TEXT_FONT_NAME, 10)
    for index, row in enumerate(values):
        top = y - index * height
        canvas.rect(x, top - height, sum(widths), height, stroke=1, fill=0)
        cursor = x
        for column, width in enumerate(widths):
            canvas.line(cursor, top, cursor, top - height)
            canvas.drawString(cursor + 6, top - 18, row[column])
            cursor += width
        canvas.line(cursor, top, cursor, top - height)


def write_financial_pdf() -> None:
    canvas = fixture_canvas("financial-statement.pdf")
    draw_lines(
        canvas,
        [
            "SYNTHETIC TWO-PAGE FINANCIAL STATEMENT",
            "Period: 2026-01",
            "Summary total: USD 130.00",
            "Line items - page 1 of 2",
        ],
    )
    draw_table(
        canvas,
        ["Type", "Currency", "Amount"],
        [["Fee", "USD", "65.00"], ["Fee", "USD", "65.00"]],
        y=620,
    )
    canvas.showPage()
    draw_lines(
        canvas,
        [
            "SYNTHETIC TWO-PAGE FINANCIAL STATEMENT",
            "Line items - continued, page 2 of 2",
        ],
    )
    draw_table(
        canvas,
        ["Type", "Currency", "Amount"],
        [["Refund", "EUR", "-10.00"], ["Refund", "USD", "-10.00"]],
        y=660,
    )
    canvas.setFont(TEXT_FONT_NAME, 11)
    canvas.drawString(54, 560, "Closing balance: USD 120.00")
    canvas.save()


def write_labels() -> None:
    labels = {
        "version": 1,
        "fixtures": [
            {
                "id": "financial-statement",
                "file": "financial-statement.pdf",
                "expectedPages": 2,
                "kind": "financial_statement",
                "assertions": [
                    {"id": "summary", "page": 1, "quote": "Summary total: USD 130.00"},
                    {
                        "id": "fee-row-0",
                        "page": 1,
                        "quote": "Fee | USD | 65.00",
                        "occurrence": 1,
                        "table": {
                            "id": "line-items-page-1",
                            "row": 0,
                            "column": 2,
                            "rowValues": ["Fee", "USD", "65.00"],
                            "cellValue": "65.00",
                        },
                    },
                    {
                        "id": "fee-row-1",
                        "page": 1,
                        "quote": "Fee | USD | 65.00",
                        "occurrence": 2,
                        "table": {
                            "id": "line-items-page-1",
                            "row": 1,
                            "column": 2,
                            "rowValues": ["Fee", "USD", "65.00"],
                            "cellValue": "65.00",
                        },
                    },
                    {
                        "id": "eur-refund",
                        "page": 2,
                        "quote": "Refund | EUR | -10.00",
                        "table": {
                            "id": "line-items-page-2",
                            "row": 0,
                            "column": 1,
                            "rowValues": ["Refund", "EUR", "-10.00"],
                            "cellValue": "EUR",
                        },
                    },
                ],
                "forbiddenValues": ["USD 130.01"],
            },
            {
                "id": "lab-report-unicode",
                "file": "lab-report-unicode.pdf",
                "expectedPages": 1,
                "kind": "lab_report",
                "assertions": [
                    {"id": "patient-a", "page": 1, "quote": "Patient: Alex Sample A"},
                    {"id": "draw-a", "page": 1, "quote": "Draw date: 2026-02-01"},
                    {"id": "micro", "page": 1, "quote": "Result: 25 µg/L"},
                    {"id": "astral", "page": 1, "quote": "Astral marker: 🌍 retained"},
                    {"id": "patient-b", "page": 1, "quote": "Patient: Blair Sample B"},
                    {"id": "draw-b", "page": 1, "quote": "Draw date: 2026-02-02"},
                    {"id": "accent", "page": 1, "quote": "Analyte: Café marker"},
                    {"id": "result-b", "page": 1, "quote": "Result: 8.2 mg/L"},
                ],
                "forbiddenValues": ["Patient: Alex Sample B"],
            },
            {
                "id": "vehicle-receipt",
                "file": "vehicle-receipt.pdf",
                "expectedPages": 1,
                "kind": "vehicle_receipt",
                "assertions": [
                    {"id": "service-date", "page": 1, "quote": "Service date: 2026-03-03"},
                    {"id": "service", "page": 1, "quote": "Oil change | USD 79.00"},
                    {"id": "total", "page": 1, "quote": "Total: USD 79.00"},
                ],
                "forbiddenValues": ["USD 79.01"],
            },
            {
                "id": "contract-continuation",
                "file": "contract-continuation.pdf",
                "expectedPages": 2,
                "kind": "contract",
                "assertions": [
                    {"id": "start", "page": 1, "quote": "Term begins: 2026-04-01"},
                    {
                        "id": "continuation",
                        "page": 2,
                        "quote": "Section 1. Payment is due within 30 days.",
                    },
                ],
                "forbiddenValues": ["within 31 days"],
            },
            {
                "id": "image-clear",
                "file": "image-clear.pdf",
                "expectedPages": 1,
                "kind": "image_clear",
                "assertions": [{"id": "amount", "page": 1, "quote": "Amount due: USD 42.00"}],
                "forbiddenValues": ["USD 42.01"],
            },
            {
                "id": "image-partial",
                "file": "image-partial.pdf",
                "expectedPages": 1,
                "kind": "image_partial",
                "assertions": [{"id": "reference", "page": 1, "quote": "Reference: PARTIAL-001"}],
                "forbiddenValues": ["TOTAL: USD 99.00"],
                "expectedGaps": [{"page": 1, "kind": "unreadable", "reason": "unknown_value"}],
            },
        ],
    }
    for fixture in labels["fixtures"]:
        fixture["sha256"] = sha256((OUT / fixture["file"]).read_bytes()).hexdigest()
    with (OUT / "labels.v1.json").open("w", encoding="utf-8") as output:
        dump(labels, output, ensure_ascii=False, indent=2)
        output.write("\n")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rasters = require_pinned_assets()
    write_financial_pdf()
    write_text_pdf(
        "lab-report-unicode.pdf",
        [[
            "SYNTHETIC LAB REPORT",
            "Patient: Alex Sample A",
            "Draw date: 2026-02-01",
            "Analyte: Vitamin D",
            "Result: 25 µg/L",
            "Astral marker: 🌍 retained",
            "Patient: Blair Sample B",
            "Draw date: 2026-02-02",
            "Analyte: Café marker",
            "Result: 8.2 mg/L",
        ]],
    )
    write_text_pdf(
        "vehicle-receipt.pdf",
        [[
            "SYNTHETIC VEHICLE SERVICE RECEIPT",
            "Vehicle: Example Sedan",
            "Service date: 2026-03-03",
            "Oil change | USD 79.00",
            "Brake inspection | USD 0.00",
            "Total: USD 79.00",
        ]],
    )
    write_text_pdf(
        "contract-continuation.pdf",
        [
            [
                "SYNTHETIC SHORT CONTRACT",
                "Agreement ID: CONTRACT-2026-01",
                "Term begins: 2026-04-01",
                "Section 1. Payment terms continue on next page.",
            ],
            [
                "SYNTHETIC SHORT CONTRACT - CONTINUATION",
                "Section 1. Payment is due within 30 days.",
                "Section 2. Notices must be in writing.",
            ],
        ],
    )
    write_image_pdf(
        "image-clear",
        [
            "SYNTHETIC CLEAR IMAGE SCAN",
            "Invoice 2026-05",
            "Amount due: USD 42.00",
            "Reference: CLEAR-001",
        ],
        rasters["image-clear"],
    )
    write_image_pdf(
        "image-partial",
        ["PARTIAL IMAGE SCAN", "Reference: PARTIAL-001"],
        rasters["image-partial"],
        missing_value_text="TOTAL: [value intentionally unavailable]",
    )
    write_labels()


if __name__ == "__main__":
    main()
