"""Bounded exact-page PDF artifacts that cannot enter full-document publication."""

from __future__ import annotations

import hashlib
import re
from io import BytesIO
from pathlib import Path
from typing import Any

from .production import (
    MAX_INPUT_BYTES,
    MAX_SERIALIZED_BUNDLE_BYTES,
    OPAQUE_INPUT_NAME,
    ParentExecutionBoundary,
    ProductionFailure,
    _canonical_json_bytes,
    convert_captured_pdf,
)

MAX_SELECTED_PAGES = 64


def select_pdf_pages(
    data: bytes, original_pages: tuple[int, ...]
) -> tuple[bytes, int]:
    """Copy exact one-based original pages into a dense bounded PDF."""
    import pypdfium2

    source = pypdfium2.PdfDocument(data)
    selected = pypdfium2.PdfDocument.new()
    try:
        source_page_count = len(source)
        if (
            not 1 <= len(original_pages) <= MAX_SELECTED_PAGES
            or any(
                type(page) is not int or not 1 <= page <= source_page_count
                for page in original_pages
            )
            or any(
                left >= right
                for left, right in zip(original_pages, original_pages[1:])
            )
        ):
            raise ProductionFailure("invalid_input")
        selected.import_pages(source, pages=[page - 1 for page in original_pages])
        output = BytesIO()
        selected.save(output)
        value = output.getvalue()
        if not value.startswith(b"%PDF-") or len(selected) != len(original_pages):
            raise ProductionFailure("conversion_output_invalid")
        return value, source_page_count
    finally:
        selected.close()
        source.close()


def _implementation_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _coverage(
    *,
    source_sha256: str,
    selected_pdf_sha256: str,
    source_page_count: int,
    original_pages: tuple[int, ...],
) -> dict[str, Any]:
    fields = {
        "schemaVersion": 1,
        "sourceSha256": source_sha256,
        "selectedPdfSha256": selected_pdf_sha256,
        "sourcePageCount": source_page_count,
        "originalPages": list(original_pages),
    }
    return {
        **fields,
        "fingerprint": hashlib.sha256(
            b"kith-selective-pdf-coverage:v1\0" + _canonical_json_bytes(fields)
        ).hexdigest(),
    }


def convert_selective_captured_pdf(
    *,
    data: bytes,
    expected_sha256: str,
    opaque_input_name: str,
    original_pages: Any,
    artifacts: Path,
    model_lock: Path,
    parent_boundary: ParentExecutionBoundary,
    timeout_seconds: float = 480.0,
    table_structure: str = "on",
) -> dict[str, Any]:
    """Convert only requested pages and bind them to the original PDF."""
    try:
        if (
            not isinstance(data, bytes)
            or not data.startswith(b"%PDF-")
            or not 0 < len(data) <= MAX_INPUT_BYTES
            or not isinstance(expected_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
            or hashlib.sha256(data).hexdigest() != expected_sha256
        ):
            raise ProductionFailure("input_digest_mismatch")
        if (
            opaque_input_name != f"pdf-{expected_sha256}.pdf"
            or not OPAQUE_INPUT_NAME.fullmatch(opaque_input_name)
            or not isinstance(original_pages, (list, tuple))
        ):
            raise ProductionFailure("invalid_input")
        requested = tuple(original_pages)
        selected_data, source_page_count = select_pdf_pages(data, requested)
        selected_sha256 = hashlib.sha256(selected_data).hexdigest()
        converted = convert_captured_pdf(
            data=selected_data,
            expected_sha256=selected_sha256,
            opaque_input_name=f"pdf-{selected_sha256}.pdf",
            artifacts=artifacts,
            model_lock=model_lock,
            parent_boundary=parent_boundary,
            timeout_seconds=timeout_seconds,
            table_structure=table_structure,
        )
        if converted.get("state") != "complete":
            return converted
        selected_bundle = converted.get("normalizedBundle")
        raw = converted.get("rawArtifact")
        if not isinstance(selected_bundle, dict) or not isinstance(raw, dict):
            raise ProductionFailure("conversion_output_invalid")
        pages = selected_bundle.get("pages")
        extraction = selected_bundle.get("extractionFingerprint")
        if (
            not isinstance(pages, list)
            or len(pages) != len(requested)
            or not isinstance(extraction, dict)
            or not isinstance(extraction.get("fingerprint"), str)
            or not isinstance(raw.get("sha256"), str)
        ):
            raise ProductionFailure("conversion_output_invalid")
        coverage = _coverage(
            source_sha256=expected_sha256,
            selected_pdf_sha256=selected_sha256,
            source_page_count=source_page_count,
            original_pages=requested,
        )
        implementation_sha256 = _implementation_sha256()
        artifact_fields = [
            implementation_sha256,
            coverage["fingerprint"],
            raw["sha256"],
            extraction["fingerprint"],
        ]
        bundle = {
            "schemaVersion": 1,
            "artifactKind": "selective_pdf_pages_v1",
            "sourceSha256": expected_sha256,
            "selectiveImplementationSha256": implementation_sha256,
            "coverage": coverage,
            "selectedBundle": selected_bundle,
            "artifactFingerprint": hashlib.sha256(
                b"kith-selective-pdf-artifact:v1\0"
                + _canonical_json_bytes(artifact_fields)
            ).hexdigest(),
        }
        if len(_canonical_json_bytes(bundle)) > MAX_SERIALIZED_BUNDLE_BYTES:
            raise ProductionFailure("bundle_too_large")
        return {
            "state": "complete",
            "normalizedBundle": bundle,
            "rawArtifact": raw,
            "selectedOriginalPages": list(requested),
            "sourcePageCount": source_page_count,
            "selectedPdfSha256": selected_sha256,
            "coverageFingerprint": coverage["fingerprint"],
            "artifactFingerprint": bundle["artifactFingerprint"],
            "selectiveImplementationSha256": implementation_sha256,
        }
    except ProductionFailure as exc:
        return {"state": "failed", "code": exc.code}
    except Exception:
        return {"state": "failed", "code": "conversion_failed"}
