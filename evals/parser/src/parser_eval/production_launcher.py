"""Bounded subprocess entry point for one production PDF conversion.

This launcher is invoked only inside the parent-created macOS sandbox. It
applies supported process limits before importing the production converter and
emits one small JSON result. It never writes source or parser content to stdio.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import resource
import socket
import sys
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_RAW_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 4 * 1024 * 1024
SHA256 = frozenset("0123456789abcdef")
_PROTOCOL_STDOUT: int | None = None


def _configure_machine_stdio() -> None:
    """Reserve one protocol descriptor and discard ordinary native log writes.

    Several parser dependencies contain native code which can write straight to
    descriptors 1 and 2, bypassing ``sys.stdout`` and ``sys.stderr``. The parent
    accepts exactly one JSON result on stdout, so keep a private duplicate for
    that result and point both ordinary descriptors at /dev/null before
    importing the production converter. This prevents document-derived
    dependency logs from entering the parent's bounded stderr capture.
    """

    global _PROTOCOL_STDOUT
    if _PROTOCOL_STDOUT is not None:
        return
    sys.stdout.flush()
    sys.stderr.flush()
    protocol = os.dup(sys.stdout.fileno())
    null = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null, sys.stdout.fileno())
        os.dup2(null, sys.stderr.fileno())
    finally:
        os.close(null)
    _PROTOCOL_STDOUT = protocol


def _write_protocol(value: bytes) -> None:
    if _PROTOCOL_STDOUT is None:
        raise RuntimeError("protocol stdout is unavailable")
    offset = 0
    while offset < len(value):
        written = os.write(_PROTOCOL_STDOUT, value[offset:])
        if written <= 0:
            raise OSError("protocol write did not progress")
        offset += written


def _safe_result(value: dict[str, Any], exit_code: int = 0) -> int:
    data = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")
    if len(data) > 16 * 1024:
        data = b'{"code":"launcher_failed","state":"failed"}'
        exit_code = 2
    _write_protocol(data + b"\n")
    return exit_code


def _positive_integer(value: str, maximum: int) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("invalid integer") from exc
    if parsed < 1 or parsed > maximum:
        raise argparse.ArgumentTypeError("integer is out of range")
    return parsed


def _apply_limits(cpu_seconds: int, file_bytes: int, open_files: int) -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_bytes, file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (open_files, open_files))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _absolute(path: str) -> Path:
    value = Path(path)
    if not value.is_absolute() or "\x00" in path:
        raise ValueError("path is invalid")
    return value


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _write_exclusive(path: Path, value: bytes, maximum: int) -> None:
    if not 0 < len(value) <= maximum:
        raise ValueError("output is outside its bound")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written <= 0:
                raise OSError("output write did not progress")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _network_probe() -> int:
    denied = 0
    for address in (("127.0.0.1", 9), ("203.0.113.1", 9)):
        candidate: socket.socket | None = None
        try:
            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            candidate.settimeout(0.25)
            candidate.connect(address)
        except OSError as exc:
            if exc.errno in (errno.EPERM, errno.EACCES):
                denied += 1
        finally:
            if candidate is not None:
                candidate.close()
    if denied != 2:
        return _safe_result({"state": "failed", "code": "network_not_denied"}, 2)
    return _safe_result({"state": "complete", "probe": "network_denied"})


def _process_probe() -> int:
    if not hasattr(os, "fork"):
        return _safe_result({"state": "failed", "code": "fork_probe_unavailable"}, 2)
    try:
        child = os.fork()
    except OSError as exc:
        if exc.errno in (errno.EPERM, errno.EACCES):
            return _safe_result({"state": "complete", "probe": "fork_denied"})
        return _safe_result({"state": "failed", "code": "fork_probe_failed"}, 2)
    if child == 0:
        os._exit(0)
    os.waitpid(child, 0)
    return _safe_result({"state": "failed", "code": "fork_not_denied"}, 2)


def _exec_probe() -> int:
    try:
        os.execv("/bin/echo", ["echo", "unexpected executable access"])
    except OSError as exc:
        if exc.errno in (errno.EPERM, errno.EACCES):
            return _safe_result({"state": "complete", "probe": "exec_denied"})
        return _safe_result({"state": "failed", "code": "exec_probe_failed"}, 2)
    return _safe_result({"state": "failed", "code": "exec_not_denied"}, 2)


def _profile(args: argparse.Namespace) -> int:
    from parser_eval.production import prepare_pdf_profile

    artifacts = _absolute(args.artifacts)
    model_lock = _absolute(args.model_lock)
    result = prepare_pdf_profile(
        artifacts=artifacts,
        model_lock=model_lock,
        timeout_seconds=float(args.conversion_timeout_seconds),
    )
    if result.get("state") != "ready":
        code = result.get("code")
        if not isinstance(code, str) or not code or len(code) > 64:
            code = "profile_failed"
        return _safe_result({"state": "failed", "code": code}, 2)
    parser = result.get("parserFingerprint")
    extraction = result.get("extractionConfiguration")
    if (
        not isinstance(parser, dict)
        or not isinstance(parser.get("fingerprint"), str)
        or not isinstance(extraction, dict)
        or not isinstance(extraction.get("fingerprint"), str)
    ):
        return _safe_result(
            {"state": "failed", "code": "profile_output_invalid"}, 2
        )
    return _safe_result(
        {
            "state": "ready",
            "parserFingerprint": parser,
            "extractionConfiguration": extraction,
        }
    )


def _convert(args: argparse.Namespace) -> int:
    from parser_eval.production import ParentExecutionBoundary, convert_captured_pdf

    input_path = _absolute(args.input)
    raw_path = _absolute(args.raw_output)
    bundle_path = _absolute(args.bundle_output)
    output_directory = _absolute(args.output_directory)
    artifacts = _absolute(args.artifacts)
    model_lock = _absolute(args.model_lock)
    expected_sha256 = args.expected_sha256
    if (
        len(expected_sha256) != 64
        or any(character not in SHA256 for character in expected_sha256)
        or raw_path.parent != output_directory
        or bundle_path.parent != output_directory
        or raw_path == bundle_path
    ):
        return _safe_result({"state": "failed", "code": "invalid_input"}, 2)
    with input_path.open("rb") as source:
        data = source.read(MAX_INPUT_BYTES + 1)
        if source.read(1):
            return _safe_result({"state": "failed", "code": "invalid_input"}, 2)
    if not 0 < len(data) <= MAX_INPUT_BYTES or _digest(data) != expected_sha256:
        return _safe_result(
            {"state": "failed", "code": "input_digest_mismatch"}, 2
        )
    result = convert_captured_pdf(
        data=data,
        expected_sha256=expected_sha256,
        opaque_input_name=f"pdf-{expected_sha256}.pdf",
        artifacts=artifacts,
        model_lock=model_lock,
        parent_boundary=ParentExecutionBoundary(
            network_denied=True, resource_bounded=True
        ),
        timeout_seconds=float(args.conversion_timeout_seconds),
    )
    data = b""
    if result.get("state") != "complete":
        code = result.get("code")
        if not isinstance(code, str) or not code or len(code) > 64:
            code = "conversion_failed"
        return _safe_result({"state": "failed", "code": code}, 2)

    raw = result.get("rawArtifact")
    bundle = result.get("normalizedBundle")
    if not isinstance(raw, dict) or not isinstance(bundle, dict):
        return _safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    raw_json = raw.get("json")
    parser = raw.get("parserFingerprint")
    extraction = bundle.get("extractionFingerprint")
    pages = bundle.get("pages")
    if (
        not isinstance(parser, dict)
        or not isinstance(parser.get("fingerprint"), str)
        or not isinstance(extraction, dict)
        or not isinstance(extraction.get("fingerprint"), str)
        or not isinstance(pages, list)
    ):
        return _safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    raw_bytes = _canonical(raw_json)
    bundle_bytes = _canonical(bundle)
    if (
        _digest(raw_bytes) != raw.get("sha256")
        or len(raw_bytes) != raw.get("byteLength")
    ):
        return _safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    _write_exclusive(raw_path, raw_bytes, MAX_RAW_BYTES)
    _write_exclusive(bundle_path, bundle_bytes, MAX_BUNDLE_BYTES)
    _sync_directory(output_directory)
    return _safe_result(
        {
            "state": "complete",
            "sourceSha256": expected_sha256,
            "rawSha256": _digest(raw_bytes),
            "rawByteLength": len(raw_bytes),
            "bundleSha256": _digest(bundle_bytes),
            "bundleByteLength": len(bundle_bytes),
            "parserFingerprint": parser["fingerprint"],
            "extractionFingerprint": extraction["fingerprint"],
            "modelManifestSha256": parser.get("modelManifestSha256"),
            "pageCount": len(pages),
        }
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--mode",
        choices=(
            "network-probe",
            "process-probe",
            "exec-probe",
            "profile",
            "convert",
        ),
        required=True,
    )
    parser.add_argument(
        "--cpu-seconds",
        type=lambda value: _positive_integer(value, 1800),
        required=True,
    )
    parser.add_argument(
        "--file-bytes",
        type=lambda value: _positive_integer(value, 80 * 1024 * 1024),
        required=True,
    )
    parser.add_argument(
        "--open-files",
        type=lambda value: _positive_integer(value, 1024),
        required=True,
    )
    parser.add_argument("--input")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--output-directory")
    parser.add_argument("--raw-output")
    parser.add_argument("--bundle-output")
    parser.add_argument("--artifacts")
    parser.add_argument("--model-lock")
    parser.add_argument(
        "--conversion-timeout-seconds",
        type=lambda value: _positive_integer(value, 480),
    )
    try:
        _configure_machine_stdio()
        args = parser.parse_args(argv)
        _apply_limits(args.cpu_seconds, args.file_bytes, args.open_files)
        if args.mode == "network-probe":
            return _network_probe()
        if args.mode == "process-probe":
            return _process_probe()
        if args.mode == "exec-probe":
            return _exec_probe()
        if args.mode == "profile":
            required = (
                args.artifacts,
                args.model_lock,
                args.conversion_timeout_seconds,
            )
            if any(value is None for value in required):
                return _safe_result(
                    {"state": "failed", "code": "invalid_input"}, 2
                )
            return _profile(args)
        required = (
            args.input,
            args.expected_sha256,
            args.output_directory,
            args.raw_output,
            args.bundle_output,
            args.artifacts,
            args.model_lock,
            args.conversion_timeout_seconds,
        )
        if any(value is None for value in required):
            return _safe_result({"state": "failed", "code": "invalid_input"}, 2)
        return _convert(args)
    except BaseException:
        return _safe_result({"state": "failed", "code": "launcher_failed"}, 2)
    finally:
        global _PROTOCOL_STDOUT
        if _PROTOCOL_STDOUT is not None:
            os.close(_PROTOCOL_STDOUT)
            _PROTOCOL_STDOUT = None


if __name__ == "__main__":
    raise SystemExit(main())
