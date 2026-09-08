"""One bounded PDF conversion child. Heavy parser imports stay in this module."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import socket
import sys
from io import BytesIO
from pathlib import Path
from typing import Any

from .normalize import normalize_text

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_PAGES = 64
MAX_RESULT_BYTES = 64 * 1024 * 1024


def _provenance_whitespace_only(value: str) -> bool:
    """Match the Unicode White_Space property without runtime-specific extras."""
    return all(
        0x0009 <= ord(char) <= 0x000D
        or ord(char)
        in {
            0x0020,
            0x0085,
            0x00A0,
            0x1680,
            0x2028,
            0x2029,
            0x202F,
            0x205F,
            0x3000,
        }
        or 0x2000 <= ord(char) <= 0x200A
        for char in value
    )


def _locator(provenance: Any) -> dict[str, Any]:
    if hasattr(provenance, "model_dump"):
        return provenance.model_dump(mode="json", exclude_none=True)
    return {}


def _append_segment(
    page: dict[str, Any], text: str, segment_id: str, locator: Any
) -> None:
    value = normalize_text(text).strip("\n")
    if not value:
        return
    if page["text"]:
        page["text"] += "\n"
    start = len(page["text"])
    page["text"] += value
    page["segments"].append(
        {
            "id": segment_id,
            "text": value,
            "startCodepoint": start,
            "endCodepoint": len(page["text"]),
            "citable": True,
            "locator": locator,
        }
    )


def _same_page_text_provenance(
    provenance: list[Any], text: str, pages: dict[int, dict[str, Any]]
) -> int | None:
    """Return the page when every span truthfully covers one item's text."""
    if not 1 <= len(provenance) <= 256:
        return None
    page_numbers = {getattr(prov, "page_no", None) for prov in provenance}
    if len(page_numbers) != 1:
        return None
    page_number = next(iter(page_numbers))
    if page_number not in pages:
        return None
    if len(provenance) == 1:
        return (
            page_number
            if tuple(getattr(provenance[0], "charspan", ()) or ()) != (0, 0)
            else None
        )
    prior_end = 0
    for prov in provenance:
        charspan = tuple(getattr(prov, "charspan", ()) or ())
        if (
            len(charspan) != 2
            or any(type(offset) is not int for offset in charspan)
            or not 0 <= prior_end <= charspan[0] < charspan[1] <= len(text)
            or not _provenance_whitespace_only(text[prior_end : charspan[0]])
        ):
            return None
        prior_end = charspan[1]
    if not _provenance_whitespace_only(text[prior_end:]):
        return None
    return page_number


def _cross_page_text_slices(
    provenance: list[Any], text: str, pages: dict[int, dict[str, Any]]
) -> list[tuple[int, int, int, int, int]] | None:
    """Return page, provenance-index, and raw-text bounds for each page slice."""
    if not 2 <= len(provenance) <= 256:
        return None
    prior_end = 0
    prior_page = 0
    groups: list[tuple[int, int, int]] = []
    for index, prov in enumerate(provenance):
        page = getattr(prov, "page_no", None)
        charspan = tuple(getattr(prov, "charspan", ()) or ())
        if (
            type(page) is not int
            or page not in pages
            or page < prior_page
            or len(charspan) != 2
            or any(type(offset) is not int for offset in charspan)
            or not 0 <= prior_end <= charspan[0] < charspan[1] <= len(text)
            or not _provenance_whitespace_only(text[prior_end : charspan[0]])
        ):
            return None
        if not groups or groups[-1][0] != page:
            groups.append((page, index, index + 1))
        else:
            groups[-1] = (page, groups[-1][1], index + 1)
        prior_end = charspan[1]
        prior_page = page
    if (
        len(groups) < 2
        or not _provenance_whitespace_only(text[prior_end:])
        or any(left[0] >= right[0] for left, right in zip(groups, groups[1:]))
    ):
        return None
    slices = []
    for ordinal, (page, provenance_start, provenance_end) in enumerate(groups):
        text_start = 0 if ordinal == 0 else provenance[provenance_start].charspan[0]
        text_end = (
            len(text)
            if ordinal + 1 == len(groups)
            else provenance[groups[ordinal + 1][1]].charspan[0]
        )
        if not normalize_text(text[text_start:text_end]).strip("\n"):
            return None
        slices.append(
            (page, provenance_start, provenance_end, text_start, text_end)
        )
    return slices


def _docling_normalized(
    document: Any, page_count: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    from docling_core.types.doc import TableItem, TextItem

    pages = {
        page: {"page": page, "text": "", "segments": []}
        for page in range(1, page_count + 1)
    }
    tables: list[dict[str, Any]] = []
    gaps: list[dict[str, Any]] = []
    table_ordinal_by_page: dict[int, int] = {}
    for item_index, (item, _level) in enumerate(document.iterate_items()):
        provenance = list(getattr(item, "prov", []) or [])
        if isinstance(item, TableItem):
            page_numbers = {getattr(prov, "page_no", None) for prov in provenance}
            citable = (
                len(provenance) == 1
                and len(page_numbers) == 1
                and next(iter(page_numbers), None) in pages
            )
            if not citable:
                gaps.append({"kind": "ambiguous_table_provenance", "item": item_index})
                continue
            page_number = next(iter(page_numbers))
            table_ordinal = table_ordinal_by_page.get(page_number, 0)
            table_ordinal_by_page[page_number] = table_ordinal + 1
            cells = list(getattr(item.data, "table_cells", []) or [])
            raw_rows: dict[int, list[Any]] = {}
            for cell in cells:
                raw_rows.setdefault(cell.start_row_offset_idx, []).append(cell)
            rows: list[dict[str, Any]] = []
            data_ordinal = 0
            for row_index in sorted(raw_rows):
                row_cells = sorted(
                    raw_rows[row_index], key=lambda cell: cell.start_col_offset_idx
                )
                max_column = max(
                    (cell.end_col_offset_idx for cell in row_cells), default=0
                )
                values = [""] * max_column
                for cell in row_cells:
                    for column in range(
                        cell.start_col_offset_idx, cell.end_col_offset_idx
                    ):
                        if column < len(values):
                            values[column] = normalize_text(cell.text)
                is_header = bool(row_cells) and all(
                    bool(cell.column_header) for cell in row_cells
                )
                ordinal = -1 if is_header else data_ordinal
                if not is_header:
                    data_ordinal += 1
                row_text = " | ".join(values)
                segment_id = (
                    f"docling-table-{page_number}-{table_ordinal}-row-{row_index}"
                )
                _append_segment(
                    pages[page_number],
                    row_text,
                    segment_id,
                    {
                        "kind": "docling_table_row",
                        "tableProvenance": _locator(provenance[0]),
                        "cells": [
                            cell.model_dump(mode="json", exclude_none=True)
                            for cell in row_cells
                        ],
                    },
                )
                rows.append(
                    {
                        "ordinal": ordinal,
                        "sourceRowOffset": row_index,
                        "header": is_header,
                        "values": values,
                        "segmentId": segment_id,
                    }
                )
            tables.append(
                {
                    "page": page_number,
                    "ordinal": table_ordinal,
                    "citable": True,
                    "provenance": _locator(provenance[0]),
                    "rows": rows,
                }
            )
            continue
        if isinstance(item, TextItem):
            # Empty parser items carry no content to retain and therefore do not
            # create a mapping gap, regardless of their provenance shape.
            if not normalize_text(item.text).strip("\n"):
                continue
            page_number = _same_page_text_provenance(provenance, item.text, pages)
            if page_number is not None:
                _append_segment(
                    pages[page_number],
                    item.text,
                    f"docling-item-{item_index}",
                    {
                        "kind": "docling_item",
                        "itemRef": str(getattr(item, "self_ref", "")),
                        "provenance": (
                            _locator(provenance[0])
                            if len(provenance) == 1
                            else [_locator(prov) for prov in provenance]
                        ),
                        "doclingCharspanSemantics": "item_local_python_codepoints_not_evidence",
                    },
                )
                continue
            slices = _cross_page_text_slices(provenance, item.text, pages)
            if slices is None:
                gaps.append({"kind": "ambiguous_text_provenance", "item": item_index})
                continue
            raw_provenance = [_locator(prov) for prov in provenance]
            for slice_ordinal, (
                page,
                provenance_start,
                provenance_end,
                text_start,
                text_end,
            ) in enumerate(slices):
                _append_segment(
                    pages[page],
                    item.text[text_start:text_end],
                    f"docling-item-{item_index}-slice-{slice_ordinal}",
                    {
                        "kind": "docling_item_slice",
                        "itemRef": str(getattr(item, "self_ref", "")),
                        "provenance": raw_provenance,
                        "provenanceIndexes": [provenance_start, provenance_end],
                        "itemTextCharspan": [text_start, text_end],
                        "doclingCharspanSemantics": "item_local_python_codepoints",
                    },
                )
    return list(pages.values()), tables, gaps


def _convert_docling(
    data: bytes,
    name: str,
    artifacts: Path,
    timeout: float,
    table_structure: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from docling.datamodel.accelerator_options import (
        AcceleratorDevice,
        AcceleratorOptions,
    )
    from docling.datamodel.base_models import ConversionStatus, InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling_core.types.io import DocumentStream

    options = PdfPipelineOptions(
        artifacts_path=artifacts,
        document_timeout=timeout,
        accelerator_options=AcceleratorOptions(
            num_threads=4, device=AcceleratorDevice.CPU
        ),
        enable_remote_services=False,
        allow_external_plugins=False,
        do_ocr=True,
        ocr_options=RapidOcrOptions(lang=["english"], backend="onnxruntime"),
        do_table_structure=table_structure,
        do_picture_classification=False,
        do_picture_description=False,
        do_chart_extraction=False,
        do_code_enrichment=False,
        do_formula_enrichment=False,
    )
    converter = DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )
    result = converter.convert(
        DocumentStream(name=name, stream=BytesIO(data)),
        raises_on_error=False,
        max_num_pages=MAX_PAGES,
        max_file_size=MAX_INPUT_BYTES,
    )
    if result.status is not ConversionStatus.SUCCESS:
        errors = [
            error.model_dump(mode="json", exclude_none=True) for error in result.errors
        ]
        raise RuntimeError(
            f"docling conversion status {result.status.value}: {errors!r}"
        )
    page_count = len(result.pages)
    pages, tables, gaps = _docling_normalized(result.document, page_count)
    raw = result.document.export_to_dict(mode="json")
    return {"pages": pages, "tables": tables, "mappingGaps": gaps}, raw


def _convert_pdfplumber(data: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    import pdfplumber

    pages: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    raw_pages: list[dict[str, Any]] = []
    with pdfplumber.open(BytesIO(data)) as pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise RuntimeError("PDF exceeds page bound")
        for page_index, pdf_page in enumerate(pdf.pages, 1):
            page = {"page": page_index, "text": "", "segments": []}
            found_tables = pdf_page.find_tables()
            table_boxes = [table.bbox for table in found_tables]
            words = pdf_page.extract_words(keep_blank_chars=False) or []
            outside_words = []
            for word in words:
                center_x = (word["x0"] + word["x1"]) / 2
                center_y = (word["top"] + word["bottom"]) / 2
                if not any(
                    x0 <= center_x <= x1 and top <= center_y <= bottom
                    for x0, top, x1, bottom in table_boxes
                ):
                    outside_words.append(word)
            line_groups: list[list[dict[str, Any]]] = []
            for word in sorted(
                outside_words, key=lambda item: (item["top"], item["x0"])
            ):
                if not line_groups or abs(line_groups[-1][0]["top"] - word["top"]) > 3:
                    line_groups.append([word])
                else:
                    line_groups[-1].append(word)
            blocks: list[tuple[float, int, str, str, dict[str, Any]]] = []
            for line_index, words_in_line in enumerate(line_groups):
                ordered = sorted(words_in_line, key=lambda item: item["x0"])
                line = " ".join(str(word["text"]) for word in ordered)
                blocks.append(
                    (
                        float(min(word["top"] for word in ordered)),
                        0,
                        line,
                        f"pdfplumber-page-{page_index}-line-{line_index}",
                        {
                            "kind": "pdfplumber_native_words",
                            "page": page_index,
                            "words": ordered,
                        },
                    )
                )
            extracted_tables = [table.extract() for table in found_tables]
            for table_index, (table_object, raw_table) in enumerate(
                zip(found_tables, extracted_tables)
            ):
                rows = []
                for source_row, values_value in enumerate(raw_table):
                    values = [normalize_text(value or "") for value in values_value]
                    is_header = source_row == 0
                    segment_id = (
                        f"pdfplumber-table-{page_index}-{table_index}-row-{source_row}"
                    )
                    blocks.append(
                        (
                            float(table_object.bbox[1]) + source_row / 1000,
                            1,
                            " | ".join(values),
                            segment_id,
                            {
                                "kind": "pdfplumber_table_row",
                                "page": page_index,
                                "tableBbox": table_object.bbox,
                                "sourceRowOffset": source_row,
                            },
                        )
                    )
                    rows.append(
                        {
                            "ordinal": -1 if is_header else source_row - 1,
                            "sourceRowOffset": source_row,
                            "header": is_header,
                            "values": values,
                            "segmentId": segment_id,
                        }
                    )
                tables.append(
                    {
                        "page": page_index,
                        "ordinal": table_index,
                        "citable": True,
                        "provenance": {"kind": "pdfplumber_table", "page": page_index},
                        "rows": rows,
                    }
                )
            for _top, _kind_order, block_text, segment_id, locator in sorted(
                blocks, key=lambda block: (block[0], block[1], block[3])
            ):
                _append_segment(page, block_text, segment_id, locator)
            pages.append(page)
            raw_pages.append(
                {
                    "page": page_index,
                    "nativeText": normalize_text(pdf_page.extract_text() or ""),
                    "words": words,
                    "tables": extracted_tables,
                    "tableBboxes": table_boxes,
                }
            )
    return {"pages": pages, "tables": tables, "mappingGaps": []}, {"pages": raw_pages}


def convert(
    candidate: str, input_path: Path, artifacts: Path | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    data = input_path.read_bytes()
    if not data.startswith(b"%PDF-") or len(data) > MAX_INPUT_BYTES:
        raise RuntimeError("input is not a bounded PDF")
    if candidate == "docling-standard-cpu-ocr":
        if artifacts is None:
            raise RuntimeError("Docling artifacts are required")
        normalized, raw = _convert_docling(data, input_path.name, artifacts, 150.0)
    elif candidate == "pdfplumber-native-text":
        normalized, raw = _convert_pdfplumber(data)
    else:
        raise RuntimeError("unsupported candidate")
    normalized.update(
        {
            "schemaVersion": 1,
            "candidate": candidate,
            "status": "success",
            "sourceSha256": hashlib.sha256(data).hexdigest(),
        }
    )
    return normalized, raw


def _write_json(path: Path, value: Any) -> None:
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    if len(encoded) > MAX_RESULT_BYTES:
        raise RuntimeError("conversion output exceeds 64 MiB")
    path.write_bytes(encoded)


def probe_network() -> int:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
    except OSError as exc:
        if exc.errno in {errno.EPERM, errno.EACCES}:
            return 0
        return 3
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--candidate", choices=("docling-standard-cpu-ocr", "pdfplumber-native-text")
    )
    parser.add_argument("--input", type=Path)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--raw-output", type=Path)
    parser.add_argument("--probe-network", action="store_true")
    args = parser.parse_args(argv)
    if args.probe_network:
        return probe_network()
    if not all((args.candidate, args.input, args.output, args.raw_output)):
        parser.error("conversion arguments are required")
    os.umask(0o077)
    try:
        normalized, raw = convert(args.candidate, args.input, args.artifacts)
        _write_json(args.output, normalized)
        _write_json(args.raw_output, raw)
    except Exception as exc:
        print(
            json.dumps(
                {"state": "failed", "code": "conversion_failed", "detail": str(exc)}
            )[:8192]
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
