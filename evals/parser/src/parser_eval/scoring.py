"""Pure scoring over frozen labels and normalized converter output."""

from __future__ import annotations

import math
from typing import Any

from .normalize import codepoint_to_utf16, normalize_text, utf16_slice


def _number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _bbox(value: Any) -> bool:
    if isinstance(value, list):
        return len(value) == 4 and all(_number(item) for item in value)
    return (
        isinstance(value, dict)
        and all(_number(value.get(key)) for key in ("l", "t", "r", "b"))
        and value["l"] <= value["r"]
    )


def _valid_locator(locator: Any, page_number: int) -> bool:
    if not isinstance(locator, dict):
        return False
    kind = locator.get("kind")
    if kind == "docling_item":
        provenance = locator.get("provenance")
        charspan = provenance.get("charspan") if isinstance(provenance, dict) else None
        return (
            isinstance(locator.get("itemRef"), str)
            and bool(locator["itemRef"])
            and locator.get("doclingCharspanSemantics")
            == "item_local_python_codepoints_not_evidence"
            and isinstance(provenance, dict)
            and provenance.get("page_no") == page_number
            and _bbox(provenance.get("bbox"))
            and isinstance(charspan, list)
            and len(charspan) == 2
            and all(
                not isinstance(item, bool) and isinstance(item, int) and item >= 0
                for item in charspan
            )
            and charspan[0] <= charspan[1]
            and charspan != [0, 0]
        )
    if kind == "docling_table_row":
        provenance = locator.get("tableProvenance")
        cells = locator.get("cells")
        return (
            isinstance(provenance, dict)
            and provenance.get("page_no") == page_number
            and _bbox(provenance.get("bbox"))
            and isinstance(cells, list)
            and 1 <= len(cells) <= 256
            and all(
                isinstance(cell, dict)
                and isinstance(cell.get("text"), str)
                and _bbox(cell.get("bbox"))
                and all(
                    not isinstance(cell.get(key), bool)
                    and isinstance(cell.get(key), int)
                    and cell[key] >= 0
                    for key in ("start_row_offset_idx", "start_col_offset_idx")
                )
                for cell in cells
            )
        )
    if kind == "pdfplumber_native_words":
        words = locator.get("words")
        return (
            locator.get("page") == page_number
            and isinstance(words, list)
            and 1 <= len(words) <= 512
            and all(
                isinstance(word, dict)
                and isinstance(word.get("text"), str)
                and all(_number(word.get(key)) for key in ("x0", "x1", "top", "bottom"))
                for word in words
            )
        )
    if kind == "pdfplumber_table_row":
        row = locator.get("sourceRowOffset")
        return (
            locator.get("page") == page_number
            and _bbox(locator.get("tableBbox"))
            and not isinstance(row, bool)
            and isinstance(row, int)
            and 0 <= row <= 10_000
        )
    return False


def _table_result(
    expected: dict[str, Any], tables: list[dict[str, Any]], page: int
) -> dict[str, Any]:
    target_row = expected["row"]
    matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for table in tables:
        if table.get("citable") is True and table.get("page") == page:
            for row in table.get("rows", []):
                if row.get("header") is not True and row.get("ordinal") == target_row:
                    matches.append((table, row))
    if len(matches) != 1:
        return {"passed": False, "reason": "table_row_missing"}
    table, row = matches[0]
    values = row.get("values")
    column = expected["column"]
    passed = (
        isinstance(values, list)
        and values == expected["rowValues"]
        and column < len(values)
        and values[column] == expected["cellValue"]
    )
    result: dict[str, Any] = {
        "passed": passed,
        "expectedTableId": expected["id"],
        "parserTableOrdinal": table.get("ordinal"),
        "parserRowOrdinal": row.get("ordinal"),
        "segmentId": row.get("segmentId"),
    }
    if not passed:
        result["reason"] = "table_association_mismatch"
    return result


def _mapped_evidence(
    page: dict[str, Any], quote: str, occurrence: int
) -> tuple[dict[str, int], str | None] | None:
    text = normalize_text(page.get("text", ""))
    matches: list[tuple[int, int, str]] = []
    citable_segments: list[tuple[int, int, str, str]] = []
    seen_ids: set[str] = set()
    page_number = page.get("page")
    if (
        isinstance(page_number, bool)
        or not isinstance(page_number, int)
        or page_number < 1
    ):
        return None
    for segment in page.get("segments", []):
        if segment.get("citable") is not True or not isinstance(
            segment.get("text"), str
        ):
            continue
        segment_text = normalize_text(segment["text"])
        segment_id = segment.get("id")
        start_cp = segment.get("startCodepoint")
        end_cp = segment.get("endCodepoint")
        if (
            isinstance(start_cp, bool)
            or not isinstance(start_cp, int)
            or isinstance(end_cp, bool)
            or not isinstance(end_cp, int)
            or not 0 <= start_cp <= end_cp <= len(text)
            or text[start_cp:end_cp] != segment_text
            or not isinstance(segment_id, str)
            or not segment_id
            or segment_id in seen_ids
            or not _valid_locator(segment.get("locator"), page_number)
        ):
            return None
        seen_ids.add(segment_id)
        citable_segments.append((start_cp, end_cp, segment_id, segment_text))
    citable_segments.sort()
    for index in range(1, len(citable_segments)):
        if citable_segments[index][0] < citable_segments[index - 1][1]:
            return None
    for start_cp, end_cp, segment_id, segment_text in citable_segments:
        cursor = 0
        while True:
            local = segment_text.find(quote, cursor)
            if local < 0:
                break
            absolute_start = start_cp + local
            absolute_end = absolute_start + len(quote)
            matches.append((absolute_start, absolute_end, segment_id))
            cursor = local + len(quote)
    matches.sort(key=lambda value: (value[0], value[1], value[2]))
    if occurrence < 1 or occurrence > len(matches):
        return None
    start_cp, end_cp, segment_id = matches[occurrence - 1]
    start = codepoint_to_utf16(text, start_cp)
    end = codepoint_to_utf16(text, end_cp)
    if utf16_slice(text, start, end) != quote:
        return None
    return {"start": start, "end": end}, segment_id or None


def score_fixture(
    fixture: dict[str, Any], conversion: dict[str, Any]
) -> dict[str, Any]:
    pages = conversion.get("pages", [])
    tables = conversion.get("tables", [])
    by_page = {page.get("page"): page for page in pages}
    assertions: list[dict[str, Any]] = []
    for expected in fixture["assertions"]:
        page = by_page.get(expected["page"], {"text": "", "segments": []})
        quote = normalize_text(expected["quote"])
        mapped = _mapped_evidence(page, quote, expected.get("occurrence", 1))
        result: dict[str, Any] = {
            "id": expected["id"],
            "page": expected["page"],
            "quote": quote,
            "passed": mapped is not None,
        }
        if mapped is None:
            result["reason"] = "exact_mapped_quote_missing"
        else:
            span, segment_id = mapped
            result["evidence"] = span
            result["locator"] = {"segmentId": segment_id}
        if "table" in expected:
            table_result = _table_result(expected["table"], tables, expected["page"])
            if mapped is not None and table_result.get("segmentId") != mapped[1]:
                table_result["passed"] = False
                table_result["reason"] = "table_evidence_segment_mismatch"
            result["table"] = table_result
            result["passed"] = result["passed"] and table_result["passed"]
        assertions.append(result)
    combined_text = "\n".join(
        normalize_text(by_page[page].get("text", "")) for page in sorted(by_page)
    )
    forbidden = [
        {"value": value, "passed": normalize_text(value) not in combined_text}
        for value in fixture["forbiddenValues"]
    ]
    return {
        "fixtureId": fixture["id"],
        "conversionSucceeded": conversion.get("status") == "success",
        "pageCountMatched": len(pages) == fixture["expectedPages"],
        "assertions": assertions,
        "forbiddenValueChecks": forbidden,
        "expectedGapAnnotations": fixture.get("expectedGaps", []),
        "automaticGapDetection": "not_implemented_p2_10",
        "passed": (
            conversion.get("status") == "success"
            and len(pages) == fixture["expectedPages"]
            and all(item["passed"] for item in assertions)
            and all(item["passed"] for item in forbidden)
        ),
    }
