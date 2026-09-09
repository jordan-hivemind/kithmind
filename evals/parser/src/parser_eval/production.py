"""Inert, bounded Docling conversion for a privately captured PDF.

The parent must create the capture inside a network-denied, resource-bounded
subprocess. This module checks that prerequisite is declared, but Python flags
and a declaration do not provide operating-system isolation.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import inspect
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import convert_worker
from .convert_worker import (
    MAX_INPUT_BYTES,
    _convert_docling,
    _provenance_whitespace_only,
)
from .manifest import ManifestError, load_manifest, verify_manifest
from .normalize import codepoint_to_utf16, normalize_text

MAX_PAGES = 64
MAX_RETAINED_UTF8_BYTES = 1024 * 1024
MAX_SERIALIZED_BUNDLE_BYTES = 4 * 1024 * 1024
MAX_LOSSLESS_JSON_BYTES = 64 * 1024 * 1024
EXPECTED_PYTHON = (3, 12, 12)
# Critical runtime components are pinned by evals/parser/uv.lock.
EXPECTED_RUNTIME_VERSIONS = {
    "docling": "2.126.0",
    "docling-core": "2.95.0",
    "docling-ibm-models": "4.0.2",
    "docling-parse": "7.17.0",
    "onnxruntime": "1.23.2",
    "rapidocr": "3.9.2",
    "pypdfium2": "5.13.0",
    "numpy": "2.5.3",
}
MAX_TABLE_STRUCTURE_BYPASS_SOURCES = 32
MAX_TABLE_STRUCTURE_BYPASS_PAGES = 64
OPAQUE_INPUT_NAME = re.compile(r"^pdf-[a-f0-9]{64}\.pdf$")

ERROR_CODES = frozenset(
    {
        "execution_prerequisite_missing",
        "invalid_input",
        "input_digest_mismatch",
        "invalid_opaque_name",
        "runtime_mismatch",
        "model_assets_invalid",
        "conversion_failed",
        "conversion_output_invalid",
        "page_limit_exceeded",
        "retained_text_too_large",
        "lossless_output_too_large",
        "bundle_too_large",
    }
)


class ProductionFailure(ValueError):
    """Safe failure carrying no path, source text, or parser detail."""

    def __init__(self, code: str):
        if code not in ERROR_CODES:
            raise ValueError("invalid production parser error code")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ParentExecutionBoundary:
    """Parent attestation. It is a prerequisite, never proof of isolation."""

    network_denied: bool
    resource_bounded: bool


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProductionFailure("conversion_output_invalid") from exc


def _implementation_sha256() -> str:
    digest = hashlib.sha256()
    for name in ("production.py", "convert_worker.py", "normalize.py"):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update((Path(__file__).parent / name).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _verify_runtime_and_artifacts(artifacts: Path, model_lock: Path) -> dict[str, Any]:
    if sys.version_info[:3] != EXPECTED_PYTHON:
        raise ProductionFailure("runtime_mismatch")
    try:
        versions = {
            name: importlib.metadata.version(name) for name in EXPECTED_RUNTIME_VERSIONS
        }
    except importlib.metadata.PackageNotFoundError as exc:
        raise ProductionFailure("runtime_mismatch") from exc
    if versions != EXPECTED_RUNTIME_VERSIONS:
        raise ProductionFailure("runtime_mismatch")
    try:
        manifest = load_manifest(model_lock)
        verify_manifest(artifacts, manifest)
    except (ManifestError, OSError, ValueError) as exc:
        raise ProductionFailure("model_assets_invalid") from exc
    return manifest


def _same_json(left: Any, right: Any) -> bool:
    return _canonical_json_bytes(left) == _canonical_json_bytes(right)


def _locator_page(locator: dict[str, Any], key: str) -> int | None:
    value = locator.get(key)
    if not isinstance(value, dict):
        return None
    page = value.get("page_no")
    return page if isinstance(page, int) and not isinstance(page, bool) else None


def _item_provenance_pages(
    value: Any, source_text: str | None = None
) -> list[int] | None:
    multiple = isinstance(value, list)
    provenance = value if isinstance(value, list) else [value]
    if not 1 <= len(provenance) <= 256 or (multiple and len(provenance) < 2):
        return None
    pages = []
    prior_end = 0
    for index, span in enumerate(provenance):
        if not isinstance(span, dict):
            return None
        page = span.get("page_no")
        charspan = span.get("charspan")
        if (
            type(page) is not int
            or not isinstance(charspan, list)
            or len(charspan) != 2
            or any(type(offset) is not int for offset in charspan)
            or not 0 <= charspan[0] < charspan[1]
            or (index and charspan[0] < prior_end)
            or (
                multiple
                and source_text is not None
                and (
                    charspan[1] > len(source_text)
                    or not _provenance_whitespace_only(
                        source_text[prior_end : charspan[0]]
                    )
                )
            )
        ):
            return None
        pages.append(page)
        prior_end = charspan[1]
    if (
        multiple
        and source_text is not None
        and not _provenance_whitespace_only(source_text[prior_end:])
    ):
        return None
    return pages


def _raw_cross_page_slices(
    item: Any, maximum_page: int
) -> list[tuple[int, int, int, int, int]] | None:
    if not isinstance(item, dict) or not isinstance(item.get("text"), str):
        return None
    text = item["text"]
    provenance = item.get("prov")
    if not isinstance(provenance, list) or not 2 <= len(provenance) <= 256:
        return None
    prior_end = 0
    prior_page = 0
    groups: list[tuple[int, int, int]] = []
    for index, span in enumerate(provenance):
        if not isinstance(span, dict):
            return None
        page = span.get("page_no")
        charspan = span.get("charspan")
        if (
            type(page) is not int
            or not 1 <= page <= maximum_page
            or page < prior_page
            or not isinstance(charspan, list)
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
        text_start = 0 if ordinal == 0 else provenance[provenance_start]["charspan"][0]
        text_end = (
            len(text)
            if ordinal + 1 == len(groups)
            else provenance[groups[ordinal + 1][1]]["charspan"][0]
        )
        if not normalize_text(text[text_start:text_end]).strip("\n"):
            return None
        slices.append(
            (page, provenance_start, provenance_end, text_start, text_end)
        )
    return slices


def _body_text_refs(lossless: dict[str, Any]) -> set[str]:
    """Return text items reachable through Docling's traversed body tree."""
    body = lossless.get("body")
    if not isinstance(body, dict):
        raise ProductionFailure("conversion_output_invalid")
    collection_names = (
        "groups",
        "texts",
        "pictures",
        "tables",
        "key_value_items",
        "form_items",
        "field_regions",
        "field_items",
    )
    collections = {
        name: lossless.get(name) for name in collection_names
    }
    refs: set[str] = set()
    pending: list[tuple[Any, str | None]] = [(body, None)]
    visited: set[str] = set()
    visited_count = 0
    while pending:
        node, node_ref = pending.pop()
        if not isinstance(node, dict):
            raise ProductionFailure("conversion_output_invalid")
        visited_count += 1
        if visited_count > 50_000:
            raise ProductionFailure("conversion_output_invalid")
        if (
            node_ref is not None
            and node_ref.startswith("#/texts/")
            and node.get("content_layer", "body") == "body"
        ):
            refs.add(node_ref)
        children = node.get("children")
        if not isinstance(children, list):
            raise ProductionFailure("conversion_output_invalid")
        if node_ref is not None and node_ref.startswith("#/pictures/"):
            captions = node.get("captions")
            if not isinstance(captions, list):
                raise ProductionFailure("conversion_output_invalid")
            caption_refs = {
                caption.get("$ref")
                for caption in captions
                if isinstance(caption, dict) and isinstance(caption.get("$ref"), str)
            }
            if len(caption_refs) != len(captions):
                raise ProductionFailure("conversion_output_invalid")
        for child in reversed(children):
            if not isinstance(child, dict) or not isinstance(child.get("$ref"), str):
                raise ProductionFailure("conversion_output_invalid")
            child_ref = child["$ref"]
            match = re.fullmatch(
                r"#/([a-z_]+)/(0|[1-9][0-9]{0,6})", child_ref
            )
            if match is None or match.group(1) not in collections:
                raise ProductionFailure("conversion_output_invalid")
            collection = collections[match.group(1)]
            index = int(match.group(2))
            if (
                not isinstance(collection, list)
                or index >= len(collection)
                or not isinstance(collection[index], dict)
            ):
                raise ProductionFailure("conversion_output_invalid")
            if child_ref in visited:
                raise ProductionFailure("conversion_output_invalid")
            visited.add(child_ref)
            pending.append((collection[index], child_ref))
    return refs


def _validate_citable_locator(
    locator: dict[str, Any], page_number: int, lossless: dict[str, Any], text: str
) -> None:
    kind = locator.get("kind")
    if kind == "docling_item":
        item_ref = locator.get("itemRef")
        provenance = locator.get("provenance")
        provenance_pages = _item_provenance_pages(provenance)
        if (
            not isinstance(item_ref, str)
            or provenance_pages is None
            or any(page != page_number for page in provenance_pages)
        ):
            raise ProductionFailure("conversion_output_invalid")
        texts = lossless.get("texts")
        matches = (
            []
            if not isinstance(texts, list)
            else [
                item
                for item in texts
                if isinstance(item, dict)
                and item.get("self_ref") == item_ref
                and isinstance(item.get("prov"), list)
                and _same_json(
                    item["prov"],
                    provenance if isinstance(provenance, list) else [provenance],
                )
                and isinstance(item.get("text"), str)
                and _item_provenance_pages(provenance, item["text"]) is not None
            ]
        )
        if (
            len(matches) != 1
            or not isinstance(matches[0].get("text"), str)
            or normalize_text(matches[0]["text"]).strip("\n") != text
        ):
            raise ProductionFailure("conversion_output_invalid")
        return
    if kind == "docling_item_slice":
        item_ref = locator.get("itemRef")
        provenance = locator.get("provenance")
        provenance_indexes = locator.get("provenanceIndexes")
        item_text_charspan = locator.get("itemTextCharspan")
        if (
            not isinstance(item_ref, str)
            or not isinstance(provenance, list)
            or not isinstance(provenance_indexes, list)
            or len(provenance_indexes) != 2
            or any(type(offset) is not int for offset in provenance_indexes)
            or not isinstance(item_text_charspan, list)
            or len(item_text_charspan) != 2
            or any(type(offset) is not int for offset in item_text_charspan)
            or locator.get("doclingCharspanSemantics")
            != "item_local_python_codepoints"
        ):
            raise ProductionFailure("conversion_output_invalid")
        texts = lossless.get("texts")
        matches = (
            []
            if not isinstance(texts, list)
            else [
                item
                for item in texts
                if isinstance(item, dict)
                and item.get("self_ref") == item_ref
                and _same_json(item.get("prov"), provenance)
                and isinstance(item.get("text"), str)
            ]
        )
        if len(matches) != 1:
            raise ProductionFailure("conversion_output_invalid")
        provenance_pages = [
            span.get("page_no") for span in provenance if isinstance(span, dict)
        ]
        maximum_page = max(
            (page for page in provenance_pages if type(page) is int),
            default=page_number,
        )
        expected = _raw_cross_page_slices(matches[0], maximum_page)
        target = (
            page_number,
            provenance_indexes[0],
            provenance_indexes[1],
            item_text_charspan[0],
            item_text_charspan[1],
        )
        if (
            expected is None
            or target not in expected
            or normalize_text(
                matches[0]["text"][item_text_charspan[0] : item_text_charspan[1]]
            ).strip("\n")
            != text
        ):
            raise ProductionFailure("conversion_output_invalid")
        return
    if kind == "docling_table_row":
        provenance = locator.get("tableProvenance")
        cells = locator.get("cells")
        if (
            _locator_page(locator, "tableProvenance") != page_number
            or not isinstance(cells, list)
            or not cells
            or any(
                not isinstance(cell, dict)
                or not isinstance(cell.get("start_row_offset_idx"), int)
                or isinstance(cell.get("start_row_offset_idx"), bool)
                for cell in cells
            )
            or len({cell["start_row_offset_idx"] for cell in cells}) != 1
        ):
            raise ProductionFailure("conversion_output_invalid")
        tables = lossless.get("tables")
        if not isinstance(tables, list):
            raise ProductionFailure("conversion_output_invalid")
        matches = 0
        for table in tables:
            if not isinstance(table, dict) or not isinstance(table.get("prov"), list):
                continue
            if len(table["prov"]) != 1 or not _same_json(table["prov"][0], provenance):
                continue
            data = table.get("data")
            raw_cells = data.get("table_cells") if isinstance(data, dict) else None
            if not isinstance(raw_cells, list):
                continue
            row = cells[0]["start_row_offset_idx"]
            raw_row = [
                cell
                for cell in raw_cells
                if isinstance(cell, dict) and cell.get("start_row_offset_idx") == row
            ]
            if sorted(map(_canonical_json_bytes, raw_row)) != sorted(
                map(_canonical_json_bytes, cells)
            ):
                continue
            ordered = sorted(
                cells, key=lambda cell: cell.get("start_col_offset_idx", -1)
            )
            for cell in ordered:
                start, end = (
                    cell.get("start_col_offset_idx"),
                    cell.get("end_col_offset_idx"),
                )
                if (
                    type(start) is not int
                    or type(end) is not int
                    or not 0 <= start < end <= 4096
                    or not isinstance(cell.get("text"), str)
                ):
                    raise ProductionFailure("conversion_output_invalid")
            values = [""] * max(cell["end_col_offset_idx"] for cell in ordered)
            for cell in ordered:
                for column in range(
                    cell["start_col_offset_idx"], cell["end_col_offset_idx"]
                ):
                    values[column] = normalize_text(cell["text"])
            if normalize_text(" | ".join(values)).strip("\n") != text:
                raise ProductionFailure("conversion_output_invalid")
            matches += 1
        if matches != 1:
            raise ProductionFailure("conversion_output_invalid")
        return
    raise ProductionFailure("conversion_output_invalid")


def _safe_page(
    page: Any, lossless: dict[str, Any], seen_locators: set[bytes]
) -> dict[str, Any]:
    if not isinstance(page, dict):
        raise ProductionFailure("conversion_output_invalid")
    page_number = page.get("page")
    page_text = page.get("text")
    segments = page.get("segments")
    if (
        not isinstance(page_number, int)
        or isinstance(page_number, bool)
        or page_number < 1
        or not isinstance(page_text, str)
        or not isinstance(segments, list)
    ):
        raise ProductionFailure("conversion_output_invalid")
    safe_segments: list[dict[str, Any]] = []
    prior_end = 0
    for segment in segments:
        if not isinstance(segment, dict):
            raise ProductionFailure("conversion_output_invalid")
        identifier = segment.get("id")
        text = segment.get("text")
        start = segment.get("startCodepoint")
        end = segment.get("endCodepoint")
        locator = segment.get("locator")
        citable = segment.get("citable")
        if (
            not isinstance(identifier, str)
            or not identifier
            or len(identifier.encode("utf-8")) > 512
            or not isinstance(text, str)
            or not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or not isinstance(citable, bool)
            or not isinstance(locator, dict)
            or not 0 <= prior_end <= start <= end <= len(page_text)
            or page_text[start:end] != text
        ):
            raise ProductionFailure("conversion_output_invalid")
        if citable:
            _validate_citable_locator(locator, page_number, lossless, text)
            locator_identity = _canonical_json_bytes(locator)
            if locator_identity in seen_locators:
                raise ProductionFailure("conversion_output_invalid")
            seen_locators.add(locator_identity)
        else:
            # The selected normalizer omits ambiguous items and reports a gap.
            # It never inserts unproven text into a retained page.
            raise ProductionFailure("conversion_output_invalid")
        prior_end = end
        safe_segments.append(
            {
                "id": identifier,
                "text": text,
                "startUtf16": codepoint_to_utf16(page_text, start),
                "endUtf16": codepoint_to_utf16(page_text, end),
                "citable": citable,
                "locator": locator,
            }
        )
    if page_text != "\n".join(segment["text"] for segment in safe_segments):
        raise ProductionFailure("conversion_output_invalid")
    return {"page": page_number, "text": page_text, "segments": safe_segments}


def _normalized_bundle(
    normalized: Any, lossless: Any, source_sha256: str, fingerprint: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(normalized, dict) or not isinstance(lossless, dict):
        raise ProductionFailure("conversion_output_invalid")
    pages = normalized.get("pages")
    tables = normalized.get("tables")
    gaps = normalized.get("mappingGaps")
    if (
        not isinstance(pages, list)
        or not isinstance(tables, list)
        or not isinstance(gaps, list)
    ):
        raise ProductionFailure("conversion_output_invalid")
    if not 1 <= len(pages) <= MAX_PAGES:
        raise ProductionFailure("page_limit_exceeded")
    seen_locators: set[bytes] = set()
    safe_pages = [_safe_page(page, lossless, seen_locators) for page in pages]
    if [page["page"] for page in safe_pages] != list(range(1, len(safe_pages) + 1)):
        raise ProductionFailure("conversion_output_invalid")
    segment_ids = {segment["id"] for page in safe_pages for segment in page["segments"]}
    segment_count = sum(len(page["segments"]) for page in safe_pages)
    if len(segment_ids) != segment_count:
        raise ProductionFailure("conversion_output_invalid")
    actual_slices: dict[str, list[tuple[int, int, int, int, int]]] = {}
    for page in safe_pages:
        for segment in page["segments"]:
            locator = segment["locator"]
            if locator.get("kind") == "docling_item_slice":
                actual_slices.setdefault(locator["itemRef"], []).append(
                    (
                        page["page"],
                        locator["provenanceIndexes"][0],
                        locator["provenanceIndexes"][1],
                        locator["itemTextCharspan"][0],
                        locator["itemTextCharspan"][1],
                    )
                )
    expected_slices: dict[str, list[tuple[int, int, int, int, int]]] = {}
    raw_texts = lossless.get("texts")
    required_refs = _body_text_refs(lossless)
    # A directly encountered slice is always checked as a complete unit. The
    # v2 producer additionally inventories every traversed body text item,
    # while leaving furniture and other untraversed collections alone.
    required_refs.update(actual_slices)
    if isinstance(raw_texts, list):
        for item in raw_texts:
            if not isinstance(item, dict) or item.get("self_ref") not in required_refs:
                continue
            expected = _raw_cross_page_slices(item, len(safe_pages))
            if expected is not None:
                item_ref = item.get("self_ref")
                if not isinstance(item_ref, str) or item_ref in expected_slices:
                    raise ProductionFailure("conversion_output_invalid")
                expected_slices[item_ref] = expected
    if actual_slices != expected_slices:
        raise ProductionFailure("conversion_output_invalid")
    retained_bytes = sum(len(page["text"].encode("utf-8")) for page in safe_pages)
    if retained_bytes > MAX_RETAINED_UTF8_BYTES:
        raise ProductionFailure("retained_text_too_large")
    bundle = {
        "schemaVersion": 1,
        "candidate": "docling-standard-cpu-ocr",
        "sourceSha256": source_sha256,
        "parserFingerprint": fingerprint,
        "pages": safe_pages,
        # The document-Q&A profile publishes proven page text and locators.
        # Full table objects remain in rawArtifact for later playbook work.
        "mappingGaps": gaps,
    }
    if len(_canonical_json_bytes(bundle)) > MAX_SERIALIZED_BUNDLE_BYTES:
        raise ProductionFailure("bundle_too_large")
    return bundle


def _normalize_table_structure_bypass(
    value: Any,
) -> tuple[tuple[str, tuple[int, ...]], ...] | None:
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or not 1 <= len(value) <= MAX_TABLE_STRUCTURE_BYPASS_SOURCES
        or any(
            not isinstance(source_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", source_sha256)
            for source_sha256 in value
        )
    ):
        raise ProductionFailure("invalid_input")
    normalized: list[tuple[str, tuple[int, ...]]] = []
    for source_sha256 in sorted(value):
        pages = value[source_sha256]
        if (
            not isinstance(pages, (list, tuple))
            or not 1 <= len(pages) <= MAX_TABLE_STRUCTURE_BYPASS_PAGES
            or any(
                type(page) is not int or not 1 <= page <= convert_worker.MAX_PAGES
                for page in pages
            )
            or any(left >= right for left, right in zip(pages, pages[1:]))
        ):
            raise ProductionFailure("invalid_input")
        normalized.append((source_sha256, tuple(pages)))
    return tuple(normalized)


def _table_structure_bypass_descriptor(
    policy: tuple[tuple[str, tuple[int, ...]], ...]
) -> list[dict[str, Any]]:
    return [
        {"sourceSha256": source_sha256, "pages": list(pages)}
        for source_sha256, pages in policy
    ]


def _conversion_implementation_sha256() -> str:
    return hashlib.sha256(
        _canonical_json_bytes(
            {
                "convert": inspect.getsource(convert_worker._convert_docling),
                "pageCount": inspect.getsource(convert_worker._pdf_page_count),
                "selectiveTableModel": inspect.getsource(
                    convert_worker._SelectiveTableModel
                ),
                "serialize": inspect.getsource(_canonical_json_bytes),
            }
        )
    ).hexdigest()


def _fingerprint(
    manifest: dict[str, Any],
    timeout_seconds: float,
    table_structure: str = "on",
    table_structure_bypass: Any = None,
) -> dict[str, Any]:
    policy = _normalize_table_structure_bypass(table_structure_bypass)
    if policy is not None and table_structure != "on":
        raise ProductionFailure("invalid_input")
    configuration = {
        "maxInputBytes": MAX_INPUT_BYTES,
        "maxConversionPages": convert_worker.MAX_PAGES,
        "outputFormat": "docling_lossless_canonical_json_v1",
        "timeoutSeconds": timeout_seconds,
        "tableStructure": table_structure,
    }
    if policy is not None:
        configuration["tableStructureBypass"] = (
            _table_structure_bypass_descriptor(policy)
        )
    fields = {
        "schemaVersion": 3 if policy is not None else 2,
        "runtime": {
            "python": ".".join(map(str, EXPECTED_PYTHON)),
            "versions": EXPECTED_RUNTIME_VERSIONS,
        },
        "modelManifestSha256": manifest.get("manifestSha256"),
        # Raw conversion and serialization identity excludes the normalizer.
        "implementationSha256": _conversion_implementation_sha256(),
        "configuration": configuration,
    }
    if not isinstance(fields["modelManifestSha256"], str):
        raise ProductionFailure("model_assets_invalid")
    fields["fingerprint"] = hashlib.sha256(_canonical_json_bytes(fields)).hexdigest()
    return fields


def _extraction_configuration(parser: dict[str, Any]) -> dict[str, Any]:
    fields = {
        "schemaVersion": 1,
        "parserFingerprint": parser["fingerprint"],
        "implementationSha256": _implementation_sha256(),
        "configuration": {
            "mappingFormat": "docling_utf16_pages_v2",
            "maxPages": MAX_PAGES,
            "maxRetainedUtf8Bytes": MAX_RETAINED_UTF8_BYTES,
            "maxBundleBytes": MAX_SERIALIZED_BUNDLE_BYTES,
        },
    }
    fields["fingerprint"] = hashlib.sha256(_canonical_json_bytes(fields)).hexdigest()
    return fields


def derive_extraction_fingerprint(
    parser_fingerprint: str, raw_hash: str, configuration_fingerprint: str
) -> str:
    values = [parser_fingerprint, raw_hash, configuration_fingerprint]
    if any(
        not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
        for value in values
    ):
        raise ProductionFailure("invalid_input")
    return hashlib.sha256(
        b"kith-parsed-extraction:v1\0" + _canonical_json_bytes(values)
    ).hexdigest()


def _extraction_fingerprint(parser: dict[str, Any], raw_hash: str) -> dict[str, Any]:
    configuration = _extraction_configuration(parser)
    return {
        "schemaVersion": 2,
        "parserFingerprint": parser["fingerprint"],
        "parserArtifactSha256": raw_hash,
        "extractionConfigurationFingerprint": configuration["fingerprint"],
        "implementationSha256": configuration["implementationSha256"],
        "configuration": configuration["configuration"],
        "fingerprint": derive_extraction_fingerprint(
            parser["fingerprint"], raw_hash, configuration["fingerprint"]
        ),
    }


def prepare_pdf_profile(
    *,
    artifacts: Path,
    model_lock: Path,
    timeout_seconds: float = 480.0,
    table_structure: str = "on",
    table_structure_bypass: Any = None,
) -> dict[str, Any]:
    """Verify a configuration identity before scanning, without parsing a PDF.

    This does not establish a sandbox or authorize subsequent capture. The
    conversion parent must still enforce its actual execution boundary.
    """
    try:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 480
            or table_structure not in ("on", "off")
        ):
            raise ProductionFailure("invalid_input")
        policy = _normalize_table_structure_bypass(table_structure_bypass)
        if policy is not None and table_structure != "on":
            raise ProductionFailure("invalid_input")
        manifest = _verify_runtime_and_artifacts(artifacts, model_lock)
        parser = _fingerprint(
            manifest,
            float(timeout_seconds),
            table_structure,
            None if policy is None else dict(policy),
        )
        return {
            "state": "ready",
            "parserFingerprint": parser,
            "extractionConfiguration": _extraction_configuration(parser),
        }
    except ProductionFailure as exc:
        return {"state": "failed", "code": exc.code}
    except Exception:
        return {"state": "failed", "code": "conversion_output_invalid"}


def convert_captured_pdf(
    *,
    data: bytes,
    expected_sha256: str,
    opaque_input_name: str,
    artifacts: Path,
    model_lock: Path,
    parent_boundary: ParentExecutionBoundary,
    timeout_seconds: float = 480.0,
    table_structure: str = "on",
    table_structure_bypass: Any = None,
) -> dict[str, Any]:
    """Convert one private capture with pinned Docling.

    The raw parser artifact is separate from the bounded normalized staging
    bundle. Callers must retain both privately and never log either artifact.
    """

    try:
        if (
            not isinstance(parent_boundary, ParentExecutionBoundary)
            or not isinstance(parent_boundary.network_denied, bool)
            or not isinstance(parent_boundary.resource_bounded, bool)
            or not parent_boundary.network_denied
            or not parent_boundary.resource_bounded
        ):
            raise ProductionFailure("execution_prerequisite_missing")
        if (
            not isinstance(data, bytes)
            or not data.startswith(b"%PDF-")
            or len(data) == 0
            or len(data) > MAX_INPUT_BYTES
        ):
            raise ProductionFailure("invalid_input")
        if (
            not isinstance(expected_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
            or hashlib.sha256(data).hexdigest() != expected_sha256
        ):
            raise ProductionFailure("input_digest_mismatch")
        expected_name = f"pdf-{expected_sha256}.pdf"
        if opaque_input_name != expected_name or not OPAQUE_INPUT_NAME.fullmatch(
            opaque_input_name
        ):
            raise ProductionFailure("invalid_opaque_name")
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 480
            or table_structure not in ("on", "off")
        ):
            raise ProductionFailure("invalid_input")

        policy = _normalize_table_structure_bypass(table_structure_bypass)
        if policy is not None and table_structure != "on":
            raise ProductionFailure("invalid_input")
        selected_pages = () if policy is None else dict(policy).get(expected_sha256, ())
        manifest = _verify_runtime_and_artifacts(artifacts, model_lock)
        if selected_pages and max(selected_pages) > convert_worker._pdf_page_count(data):
            raise ProductionFailure("invalid_input")
        if policy is None:
            normalized, lossless = _convert_docling(
                data,
                opaque_input_name,
                artifacts,
                float(timeout_seconds),
                table_structure == "on",
            )
        else:
            normalized, lossless = _convert_docling(
                data,
                opaque_input_name,
                artifacts,
                float(timeout_seconds),
                table_structure == "on",
                policy,
                expected_sha256,
            )
        raw_bytes = _canonical_json_bytes(lossless)
        if len(raw_bytes) > MAX_LOSSLESS_JSON_BYTES:
            raise ProductionFailure("lossless_output_too_large")
        fingerprint = _fingerprint(
            manifest,
            float(timeout_seconds),
            table_structure,
            None if policy is None else dict(policy),
        )
        raw_hash = hashlib.sha256(raw_bytes).hexdigest()
        normalized_bundle = _normalized_bundle(
            normalized, lossless, expected_sha256, fingerprint
        )
        normalized_bundle["extractionFingerprint"] = _extraction_fingerprint(
            fingerprint, raw_hash
        )
        if len(_canonical_json_bytes(normalized_bundle)) > MAX_SERIALIZED_BUNDLE_BYTES:
            raise ProductionFailure("bundle_too_large")
        return {
            "state": "complete",
            "normalizedBundle": normalized_bundle,
            "rawArtifact": {
                "sha256": raw_hash,
                "parserFingerprint": fingerprint,
                "byteLength": len(raw_bytes),
                "json": lossless,
            },
            "tableStructureBypassPages": list(selected_pages),
        }
    except ProductionFailure as exc:
        return {"state": "failed", "code": exc.code}
    except Exception:
        return {"state": "failed", "code": "conversion_failed"}
