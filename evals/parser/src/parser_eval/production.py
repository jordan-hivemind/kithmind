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

MAX_PAGES = 32
MAX_RETAINED_UTF8_BYTES = 256 * 1024
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


def _fingerprint(manifest: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
    fields = {
        "schemaVersion": 1,
        "runtime": {
            "python": ".".join(map(str, EXPECTED_PYTHON)),
            "versions": EXPECTED_RUNTIME_VERSIONS,
        },
        "modelManifestSha256": manifest.get("manifestSha256"),
        # Raw conversion and serialization identity excludes the normalizer.
        "implementationSha256": hashlib.sha256(
            _canonical_json_bytes(
                {
                    "convert": inspect.getsource(convert_worker._convert_docling),
                    "serialize": inspect.getsource(_canonical_json_bytes),
                }
            )
        ).hexdigest(),
        "configuration": {
            "maxInputBytes": MAX_INPUT_BYTES,
            "maxConversionPages": convert_worker.MAX_PAGES,
            "outputFormat": "docling_lossless_canonical_json_v1",
            "timeoutSeconds": timeout_seconds,
        },
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
            "mappingFormat": "docling_utf16_pages_v1",
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
    *, artifacts: Path, model_lock: Path, timeout_seconds: float = 150.0
) -> dict[str, Any]:
    """Verify a configuration identity before scanning, without parsing a PDF.

    This does not establish a sandbox or authorize subsequent capture. The
    conversion parent must still enforce its actual execution boundary.
    """
    try:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0 < timeout_seconds <= 150
        ):
            raise ProductionFailure("invalid_input")
        manifest = _verify_runtime_and_artifacts(artifacts, model_lock)
        parser = _fingerprint(manifest, float(timeout_seconds))
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
    timeout_seconds: float = 150.0,
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
            or not 0 < timeout_seconds <= 150
        ):
            raise ProductionFailure("invalid_input")

        manifest = _verify_runtime_and_artifacts(artifacts, model_lock)
        normalized, lossless = _convert_docling(
            data, opaque_input_name, artifacts, float(timeout_seconds)
        )
        raw_bytes = _canonical_json_bytes(lossless)
        if len(raw_bytes) > MAX_LOSSLESS_JSON_BYTES:
            raise ProductionFailure("lossless_output_too_large")
        fingerprint = _fingerprint(manifest, float(timeout_seconds))
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
        }
    except ProductionFailure as exc:
        return {"state": "failed", "code": exc.code}
    except Exception:
        return {"state": "failed", "code": "conversion_failed"}
