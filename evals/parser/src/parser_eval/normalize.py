"""Deterministic page text and evidence offset helpers."""

from __future__ import annotations

import unicodedata


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def codepoint_to_utf16(value: str, offset: int) -> int:
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or not 0 <= offset <= len(value)
    ):
        raise ValueError("invalid code-point offset")
    return utf16_length(value[:offset])


def utf16_slice(value: str, start: int, end: int) -> str:
    if any(
        isinstance(offset, bool) or not isinstance(offset, int)
        for offset in (start, end)
    ):
        raise ValueError("invalid UTF-16 offset")
    encoded = value.encode("utf-16-le")
    if not 0 <= start <= end <= len(encoded) // 2:
        raise ValueError("invalid UTF-16 range")
    try:
        return encoded[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise ValueError("range splits a surrogate pair") from exc


def exact_occurrence(value: str, quote: str, occurrence: int) -> tuple[int, int] | None:
    if occurrence < 1:
        raise ValueError("occurrence must be positive")
    cursor = 0
    found = -1
    for _ in range(occurrence):
        found = value.find(quote, cursor)
        if found < 0:
            return None
        cursor = found + len(quote)
    return codepoint_to_utf16(value, found), codepoint_to_utf16(
        value, found + len(quote)
    )
