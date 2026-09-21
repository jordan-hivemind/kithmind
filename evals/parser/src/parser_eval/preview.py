"""Bounded, provisional previews for already captured PDF and XLSX sources.

The caller must run this module behind the production launcher's network,
process, memory, CPU, and wall-clock boundary. Preview output is routing input;
it is not indexed evidence and does not assert complete document extraction.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import time
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from xml.etree import ElementTree

PDF_MEDIA_TYPE = "application/pdf"
XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
SUPPORTED_MEDIA_TYPES = frozenset((PDF_MEDIA_TYPE, XLSX_MEDIA_TYPE))

MAX_PREVIEW_WINDOWS = 4
MAX_PREVIEW_UNITS = 8
MAX_TEXT_BYTES_PER_UNIT = 2 * 1024
MAX_TEXT_CHARACTERS_PER_UNIT = 384
MAX_TOTAL_TEXT_BYTES = 4 * 1024
MAX_TOTAL_TEXT_CHARACTERS = 768
MAX_XLSX_ENTRIES = 1024
MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024
MAX_WORKBOOK_XML_BYTES = 256 * 1024
MAX_XLSX_COMPRESSION_RATIO = 100
MAX_XLSX_SHEETS = 32
MAX_XLSX_SHEET_NAME_CHARACTERS = 512
MAX_PREVIEW_SECONDS = 30.0

_SHA256_CHARACTERS = frozenset("0123456789abcdef")
_WORKBOOK_PATH = "xl/workbook.xml"
_WORKBOOK_NAMESPACES = frozenset(
    (
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "http://purl.oclc.org/ooxml/spreadsheetml/main",
    )
)
_VISIBILITY = frozenset(("visible", "hidden", "veryHidden"))


@dataclass(frozen=True)
class PreviewExecutionBoundary:
    """Parent attestations required before parsing untrusted source bytes."""

    network_denied: bool
    resource_bounded: bool


class _PreviewFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _implementation_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _method(name: str, dependencies: dict[str, str]) -> dict[str, Any]:
    descriptor = {
        "schemaVersion": 1,
        "name": name,
        "implementationSha256": _implementation_sha256(),
        "dependencies": dependencies,
    }
    return {
        **descriptor,
        "fingerprint": hashlib.sha256(_canonical(descriptor)).hexdigest(),
    }


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in _SHA256_CHARACTERS for character in value)
    )


def _requested_pages(windows: object) -> list[int]:
    if not isinstance(windows, list) or not 0 < len(windows) <= MAX_PREVIEW_WINDOWS:
        raise _PreviewFailure("invalid_preview_request")
    pages: list[int] = []
    seen: set[int] = set()
    for window in windows:
        if not isinstance(window, dict) or set(window) != {"startPage", "pageCount"}:
            raise _PreviewFailure("invalid_preview_request")
        start = window["startPage"]
        count = window["pageCount"]
        if (
            type(start) is not int
            or type(count) is not int
            or start < 1
            or count < 1
            or count > MAX_PREVIEW_UNITS
        ):
            raise _PreviewFailure("invalid_preview_request")
        for page in range(start, start + count):
            if page in seen:
                raise _PreviewFailure("invalid_preview_request")
            seen.add(page)
            pages.append(page)
            if len(pages) > MAX_PREVIEW_UNITS:
                raise _PreviewFailure("preview_budget_exceeded")
    return pages


def _truncate_text(
    value: str,
    *,
    byte_limit: int,
    character_limit: int,
) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= byte_limit and len(value) <= character_limit:
        return value, False
    candidate = value[:character_limit]
    encoded = candidate.encode("utf-8")
    if len(encoded) > byte_limit:
        encoded = encoded[:byte_limit]
        candidate = encoded.decode("utf-8", errors="ignore")
    return candidate, True


def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise _PreviewFailure("preview_budget_exceeded")


def _preview_pdf(
    data: bytes,
    windows: object,
    deadline: float,
) -> dict[str, Any]:
    pages = _requested_pages(windows)
    try:
        dependency_versions = {
            "pdfplumber": importlib.metadata.version("pdfplumber"),
            "pdfminer.six": importlib.metadata.version("pdfminer.six"),
            "pypdfium2": importlib.metadata.version("pypdfium2"),
        }
    except importlib.metadata.PackageNotFoundError as exc:
        raise _PreviewFailure("preview_runtime_mismatch") from exc
    if dependency_versions != {
        "pdfplumber": "0.11.7",
        "pdfminer.six": "20250506",
        "pypdfium2": "5.13.0",
    }:
        raise _PreviewFailure("preview_runtime_mismatch")

    try:
        import pdfplumber

        with pdfplumber.open(BytesIO(data)) as document:
            page_count = len(document.pages)
            if any(page > page_count for page in pages):
                raise _PreviewFailure("invalid_preview_request")
            units: list[dict[str, Any]] = []
            remaining_bytes = MAX_TOTAL_TEXT_BYTES
            remaining_characters = MAX_TOTAL_TEXT_CHARACTERS
            for page_number in pages:
                _check_deadline(deadline)
                page = document.pages[page_number - 1]
                try:
                    native_text = page.extract_text() or ""
                    has_image = bool(page.images)
                except Exception:
                    units.append(
                        {
                            "pageNumber": page_number,
                            "state": "unknown",
                            "text": "",
                            "textTruncated": False,
                        }
                    )
                    continue
                native_text = native_text.strip()
                if native_text:
                    text, truncated = _truncate_text(
                        native_text,
                        byte_limit=min(MAX_TEXT_BYTES_PER_UNIT, remaining_bytes),
                        character_limit=min(
                            MAX_TEXT_CHARACTERS_PER_UNIT,
                            remaining_characters,
                        ),
                    )
                    if not text:
                        raise _PreviewFailure("preview_budget_exceeded")
                    remaining_bytes -= len(text.encode("utf-8"))
                    remaining_characters -= len(text)
                    state = "text_available"
                else:
                    text = ""
                    truncated = False
                    state = "image_only" if has_image else "unknown"
                units.append(
                    {
                        "pageNumber": page_number,
                        "state": state,
                        "text": text,
                        "textTruncated": truncated,
                    }
                )
                _check_deadline(deadline)
    except _PreviewFailure:
        raise
    except Exception as exc:
        raise _PreviewFailure("malformed_document") from exc

    return {
        "pageCount": page_count,
        "inspectedPageNumbers": pages,
        "units": units,
        "method": _method(
            "pdfplumber_native_text_preview",
            dependency_versions,
        ),
    }


def _safe_zip_name(value: str) -> bool:
    if not value or "\\" in value or value.startswith("/"):
        return False
    path = PurePosixPath(value)
    return all(part not in ("", ".", "..") for part in path.parts)


def _bounded_workbook_xml(archive: zipfile.ZipFile) -> bytes:
    entries = archive.infolist()
    if not 0 < len(entries) <= MAX_XLSX_ENTRIES:
        raise _PreviewFailure("xlsx_archive_unsafe")
    names: set[str] = set()
    total_size = 0
    workbook: zipfile.ZipInfo | None = None
    for entry in entries:
        if (
            not _safe_zip_name(entry.filename)
            or entry.filename in names
            or entry.flag_bits & 0x1
            or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            or entry.file_size < 0
            or entry.file_size > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES
            or entry.compress_size < 0
        ):
            raise _PreviewFailure("xlsx_archive_unsafe")
        names.add(entry.filename)
        total_size += entry.file_size
        if total_size > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES:
            raise _PreviewFailure("xlsx_archive_unsafe")
        if entry.file_size and (
            entry.compress_size == 0
            or entry.file_size
            > max(1, entry.compress_size) * MAX_XLSX_COMPRESSION_RATIO
        ):
            raise _PreviewFailure("xlsx_archive_unsafe")
        if entry.filename == _WORKBOOK_PATH:
            workbook = entry
    if workbook is None or not 0 < workbook.file_size <= MAX_WORKBOOK_XML_BYTES:
        raise _PreviewFailure("malformed_document")
    with archive.open(workbook, "r") as source:
        value = source.read(MAX_WORKBOOK_XML_BYTES + 1)
        if source.read(1) or len(value) != workbook.file_size:
            raise _PreviewFailure("xlsx_archive_unsafe")
    return value


def _preview_xlsx(data: bytes, windows: object, deadline: float) -> dict[str, Any]:
    if windows not in (None, []):
        raise _PreviewFailure("invalid_preview_request")
    _check_deadline(deadline)
    try:
        with zipfile.ZipFile(BytesIO(data), "r") as archive:
            workbook_xml = _bounded_workbook_xml(archive)
    except _PreviewFailure:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise _PreviewFailure("malformed_document") from exc
    upper_xml = workbook_xml.upper()
    if b"<!DOCTYPE" in upper_xml or b"<!ENTITY" in upper_xml:
        raise _PreviewFailure("xlsx_xml_unsafe")
    try:
        root = ElementTree.fromstring(workbook_xml)
    except ElementTree.ParseError as exc:
        raise _PreviewFailure("malformed_document") from exc
    if not root.tag.startswith("{") or "}" not in root.tag:
        raise _PreviewFailure("malformed_document")
    namespace, local_name = root.tag[1:].split("}", 1)
    if namespace not in _WORKBOOK_NAMESPACES or local_name != "workbook":
        raise _PreviewFailure("malformed_document")
    sheets_element = root.find(f"{{{namespace}}}sheets")
    if sheets_element is None:
        raise _PreviewFailure("malformed_document")
    sheet_elements = sheets_element.findall(f"{{{namespace}}}sheet")
    if len(sheet_elements) > MAX_XLSX_SHEETS:
        raise _PreviewFailure("preview_budget_exceeded")
    sheets: list[dict[str, str]] = []
    seen_names: set[str] = set()
    total_name_characters = 0
    for sheet in sheet_elements:
        _check_deadline(deadline)
        name = sheet.get("name")
        visibility = sheet.get("state", "visible")
        if (
            not isinstance(name, str)
            or not 0 < len(name) <= 31
            or len(name.encode("utf-8")) > 124
            or name.casefold() in seen_names
            or visibility not in _VISIBILITY
        ):
            raise _PreviewFailure("malformed_document")
        total_name_characters += len(name)
        if total_name_characters > MAX_XLSX_SHEET_NAME_CHARACTERS:
            raise _PreviewFailure("preview_budget_exceeded")
        seen_names.add(name.casefold())
        sheets.append({"name": name, "visibility": visibility})
    _check_deadline(deadline)
    return {
        "sheetCount": len(sheets),
        "sheets": sheets,
        "method": _method(
            "xlsx_workbook_metadata_preview",
            {"python": platform.python_version()},
        ),
    }


def preview_captured_document(
    *,
    data: bytes,
    expected_sha256: str,
    media_type: str,
    requested_windows: object,
    parent_boundary: PreviewExecutionBoundary,
    timeout_seconds: float,
) -> dict[str, Any]:
    """Return a bounded routing preview with no indexed-evidence semantics."""

    try:
        if (
            not isinstance(data, bytes)
            or not data
            or not _valid_sha256(expected_sha256)
            or media_type not in SUPPORTED_MEDIA_TYPES
            or not parent_boundary.network_denied
            or not parent_boundary.resource_bounded
            or not isinstance(timeout_seconds, (int, float))
            or isinstance(timeout_seconds, bool)
            or not 0 < float(timeout_seconds) <= MAX_PREVIEW_SECONDS
        ):
            raise _PreviewFailure("invalid_preview_request")
        if hashlib.sha256(data).hexdigest() != expected_sha256:
            raise _PreviewFailure("input_digest_mismatch")
        deadline = time.monotonic() + float(timeout_seconds)
        if media_type == PDF_MEDIA_TYPE:
            preview = _preview_pdf(data, requested_windows, deadline)
        else:
            preview = _preview_xlsx(data, requested_windows, deadline)
        return {
            "state": "complete",
            "schemaVersion": 1,
            "provisional": True,
            "sourceSha256": expected_sha256,
            "mediaType": media_type,
            **preview,
        }
    except _PreviewFailure as exc:
        return {"state": "failed", "code": exc.code}
