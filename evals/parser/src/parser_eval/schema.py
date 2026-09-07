"""Strict, bounded schema helpers for the authored parser corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

MAX_FIXTURES = 32
MAX_ASSERTIONS = 256
MAX_STRING = 4096
KINDS = {
    "financial_statement",
    "lab_report",
    "vehicle_receipt",
    "contract",
    "image_clear",
    "image_partial",
}


class ContractError(ValueError):
    pass


def _object(value: Any, where: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ContractError(f"{where} must be an object")
    extra = set(value) - allowed
    if extra:
        raise ContractError(f"{where} has unknown fields: {sorted(extra)}")
    return value


def _string(value: Any, where: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or len(value) > MAX_STRING:
        raise ContractError(f"{where} must be a bounded string")
    if nonempty and not value:
        raise ContractError(f"{where} must not be empty")
    return value


def _integer(value: Any, where: str, *, minimum: int = 0, maximum: int = 10_000) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ContractError(f"{where} must be an integer in [{minimum}, {maximum}]")
    return value


def _string_list(value: Any, where: str, *, maximum: int = MAX_ASSERTIONS) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ContractError(f"{where} must be a bounded array")
    return [_string(item, f"{where}[{index}]") for index, item in enumerate(value)]


def load_labels(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ContractError(
            f"cannot read labels: {exc.strerror or 'read failed'}"
        ) from exc
    if len(raw) > 1_048_576:
        raise ContractError("labels exceed 1 MiB")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("labels are not valid UTF-8 JSON") from exc
    root = _object(value, "labels", {"version", "fixtures"})
    if root.get("version") != 1:
        raise ContractError("labels.version must equal 1")
    fixtures = root.get("fixtures")
    if not isinstance(fixtures, list) or not 1 <= len(fixtures) <= MAX_FIXTURES:
        raise ContractError("labels.fixtures must be a nonempty bounded array")
    seen_fixture_ids: set[str] = set()
    seen_files: set[str] = set()
    assertion_count = 0
    for fixture_index, fixture_value in enumerate(fixtures):
        where = f"fixtures[{fixture_index}]"
        fixture = _object(
            fixture_value,
            where,
            {
                "id",
                "file",
                "sha256",
                "expectedPages",
                "kind",
                "assertions",
                "forbiddenValues",
                "expectedGaps",
            },
        )
        fixture_id = _string(fixture.get("id"), f"{where}.id")
        filename = _string(fixture.get("file"), f"{where}.file")
        if fixture_id in seen_fixture_ids or filename in seen_files:
            raise ContractError(f"{where} duplicates an id or file")
        seen_fixture_ids.add(fixture_id)
        seen_files.add(filename)
        relative = Path(filename)
        if (
            relative.is_absolute()
            or relative.name != filename
            or filename in {".", ".."}
        ):
            raise ContractError(f"{where}.file must be a plain relative filename")
        digest = _string(fixture.get("sha256"), f"{where}.sha256")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ContractError(f"{where}.sha256 must be lowercase SHA-256")
        pages = _integer(
            fixture.get("expectedPages"),
            f"{where}.expectedPages",
            minimum=1,
            maximum=64,
        )
        if fixture.get("kind") not in KINDS:
            raise ContractError(f"{where}.kind is unsupported")
        assertions = fixture.get("assertions")
        if not isinstance(assertions, list) or not assertions:
            raise ContractError(f"{where}.assertions must be a nonempty array")
        assertion_count += len(assertions)
        if assertion_count > MAX_ASSERTIONS:
            raise ContractError("too many assertions")
        seen_assertions: set[str] = set()
        for assertion_index, assertion_value in enumerate(assertions):
            awhere = f"{where}.assertions[{assertion_index}]"
            assertion = _object(
                assertion_value,
                awhere,
                {"id", "page", "quote", "occurrence", "field", "table"},
            )
            assertion_id = _string(assertion.get("id"), f"{awhere}.id")
            if assertion_id in seen_assertions:
                raise ContractError(f"{awhere}.id is duplicated")
            seen_assertions.add(assertion_id)
            _string(assertion.get("quote"), f"{awhere}.quote")
            _integer(assertion.get("page"), f"{awhere}.page", minimum=1, maximum=pages)
            if "occurrence" in assertion:
                _integer(
                    assertion["occurrence"],
                    f"{awhere}.occurrence",
                    minimum=1,
                    maximum=64,
                )
            if "field" in assertion:
                _string(assertion["field"], f"{awhere}.field")
            if "table" in assertion:
                table = _object(
                    assertion["table"],
                    f"{awhere}.table",
                    {"id", "row", "column", "rowValues", "cellValue"},
                )
                _string(table.get("id"), f"{awhere}.table.id")
                _integer(table.get("row"), f"{awhere}.table.row")
                column = _integer(table.get("column"), f"{awhere}.table.column")
                values = _string_list(
                    table.get("rowValues"), f"{awhere}.table.rowValues", maximum=64
                )
                cell = _string(table.get("cellValue"), f"{awhere}.table.cellValue")
                if column >= len(values) or values[column] != cell:
                    raise ContractError(f"{awhere}.table cell does not match rowValues")
        _string_list(fixture.get("forbiddenValues"), f"{where}.forbiddenValues")
        gaps = fixture.get("expectedGaps", [])
        if not isinstance(gaps, list) or len(gaps) > 64:
            raise ContractError(f"{where}.expectedGaps must be a bounded array")
        for gap_index, gap_value in enumerate(gaps):
            gwhere = f"{where}.expectedGaps[{gap_index}]"
            gap = _object(gap_value, gwhere, {"page", "kind", "reason"})
            _integer(gap.get("page"), f"{gwhere}.page", minimum=1, maximum=pages)
            if gap.get("kind") not in {"ocr", "unreadable"}:
                raise ContractError(f"{gwhere}.kind is unsupported")
            if gap.get("reason") != "unknown_value":
                raise ContractError(f"{gwhere}.reason is unsupported")
    return root


def verify_fixture_hashes(labels: dict[str, Any], fixture_dir: Path) -> None:
    for fixture in labels["fixtures"]:
        path = fixture_dir / fixture["file"]
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ContractError(f"cannot read fixture {fixture['file']}") from exc
        if len(data) > 16 * 1024 * 1024:
            raise ContractError(f"fixture {fixture['file']} exceeds 16 MiB")
        if hashlib.sha256(data).hexdigest() != fixture["sha256"]:
            raise ContractError(f"fixture hash mismatch: {fixture['file']}")
