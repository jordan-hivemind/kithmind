"""Sandbox child for exact-page selective PDF artifacts."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from . import production_launcher as common

MAX_SELECTED_ARGUMENT_BYTES = 512


def _selected_pages(value: str) -> list[int]:
    if not 0 < len(value.encode("utf-8")) <= MAX_SELECTED_ARGUMENT_BYTES:
        raise argparse.ArgumentTypeError("selected pages are out of range")
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("selected pages are invalid") from exc
    if (
        not isinstance(parsed, list)
        or not 1 <= len(parsed) <= 64
        or any(type(page) is not int or page < 1 for page in parsed)
        or any(left >= right for left, right in zip(parsed, parsed[1:]))
    ):
        raise argparse.ArgumentTypeError("selected pages are invalid")
    return parsed


def _convert(args: argparse.Namespace) -> int:
    from .production import ParentExecutionBoundary
    from .selective_production import convert_selective_captured_pdf

    input_path = common._absolute(args.input)
    raw_path = common._absolute(args.raw_output)
    bundle_path = common._absolute(args.bundle_output)
    output_directory = common._absolute(args.output_directory)
    artifacts = common._absolute(args.artifacts)
    model_lock = common._absolute(args.model_lock)
    expected_sha256 = args.expected_sha256
    if (
        len(expected_sha256) != 64
        or any(character not in common.SHA256 for character in expected_sha256)
        or raw_path.parent != output_directory
        or bundle_path.parent != output_directory
        or raw_path == bundle_path
    ):
        return common._safe_result({"state": "failed", "code": "invalid_input"}, 2)
    with input_path.open("rb") as source:
        data = source.read(common.MAX_INPUT_BYTES + 1)
        if source.read(1):
            return common._safe_result(
                {"state": "failed", "code": "invalid_input"}, 2
            )
    if (
        not 0 < len(data) <= common.MAX_INPUT_BYTES
        or common._digest(data) != expected_sha256
    ):
        return common._safe_result(
            {"state": "failed", "code": "input_digest_mismatch"}, 2
        )
    result = convert_selective_captured_pdf(
        data=data,
        expected_sha256=expected_sha256,
        opaque_input_name=f"pdf-{expected_sha256}.pdf",
        original_pages=args.selected_original_pages,
        artifacts=artifacts,
        model_lock=model_lock,
        parent_boundary=ParentExecutionBoundary(
            network_denied=True, resource_bounded=True
        ),
        timeout_seconds=float(args.conversion_timeout_seconds),
        table_structure=args.table_structure,
    )
    data = b""
    if result.get("state") != "complete":
        code = result.get("code")
        if not isinstance(code, str) or not code or len(code) > 64:
            code = "conversion_failed"
        return common._safe_result({"state": "failed", "code": code}, 2)
    raw = result.get("rawArtifact")
    bundle = result.get("normalizedBundle")
    if not isinstance(raw, dict) or not isinstance(bundle, dict):
        return common._safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    raw_json = raw.get("json")
    selected_bundle = bundle.get("selectedBundle")
    if not isinstance(selected_bundle, dict):
        return common._safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    parser = raw.get("parserFingerprint")
    extraction = selected_bundle.get("extractionFingerprint")
    pages = selected_bundle.get("pages")
    coverage = bundle.get("coverage")
    if (
        set(bundle)
        != {
            "schemaVersion",
            "artifactKind",
            "sourceSha256",
            "selectiveImplementationSha256",
            "coverage",
            "selectedBundle",
            "artifactFingerprint",
        }
        or bundle.get("schemaVersion") != 1
        or bundle.get("artifactKind") != "selective_pdf_pages_v1"
        or bundle.get("sourceSha256") != expected_sha256
        or not isinstance(parser, dict)
        or not isinstance(parser.get("fingerprint"), str)
        or not isinstance(extraction, dict)
        or not isinstance(extraction.get("fingerprint"), str)
        or not isinstance(pages, list)
        or len(pages) != len(args.selected_original_pages)
        or not isinstance(coverage, dict)
        or coverage.get("originalPages") != args.selected_original_pages
        or result.get("selectedOriginalPages") != args.selected_original_pages
        or result.get("sourcePageCount") != coverage.get("sourcePageCount")
        or result.get("selectedPdfSha256") != coverage.get("selectedPdfSha256")
        or result.get("coverageFingerprint") != coverage.get("fingerprint")
        or result.get("artifactFingerprint") != bundle.get("artifactFingerprint")
        or result.get("selectiveImplementationSha256")
        != bundle.get("selectiveImplementationSha256")
    ):
        return common._safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    raw_bytes = common._canonical(raw_json)
    bundle_bytes = common._canonical(bundle)
    if (
        common._digest(raw_bytes) != raw.get("sha256")
        or len(raw_bytes) != raw.get("byteLength")
    ):
        return common._safe_result(
            {"state": "failed", "code": "conversion_output_invalid"}, 2
        )
    common._write_exclusive(raw_path, raw_bytes, common.MAX_RAW_BYTES)
    common._write_exclusive(bundle_path, bundle_bytes, common.MAX_BUNDLE_BYTES)
    common._sync_directory(output_directory)
    return common._safe_result(
        {
            "state": "complete",
            "sourceSha256": expected_sha256,
            "rawSha256": common._digest(raw_bytes),
            "rawByteLength": len(raw_bytes),
            "bundleSha256": common._digest(bundle_bytes),
            "bundleByteLength": len(bundle_bytes),
            "parserFingerprint": parser["fingerprint"],
            "extractionFingerprint": extraction["fingerprint"],
            "modelManifestSha256": parser.get("modelManifestSha256"),
            "pageCount": len(pages),
            "sourcePageCount": result["sourcePageCount"],
            "selectedOriginalPages": args.selected_original_pages,
            "selectedPdfSha256": result["selectedPdfSha256"],
            "coverageFingerprint": result["coverageFingerprint"],
            "artifactFingerprint": result["artifactFingerprint"],
            "selectiveImplementationSha256": result[
                "selectiveImplementationSha256"
            ],
        }
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--mode",
        choices=("network-probe", "process-probe", "exec-probe", "convert-selective"),
        required=True,
    )
    parser.add_argument(
        "--cpu-seconds",
        type=lambda value: common._positive_integer(value, 1800),
        required=True,
    )
    parser.add_argument(
        "--file-bytes",
        type=lambda value: common._positive_integer(value, 80 * 1024 * 1024),
        required=True,
    )
    parser.add_argument(
        "--open-files",
        type=lambda value: common._positive_integer(value, 1024),
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
        type=lambda value: common._positive_integer(value, 480),
    )
    parser.add_argument("--table-structure", choices=("on", "off"), default="on")
    parser.add_argument("--selected-original-pages", type=_selected_pages)
    try:
        common._configure_machine_stdio()
        args = parser.parse_args(argv)
        common._apply_limits(args.cpu_seconds, args.file_bytes, args.open_files)
        if args.mode == "network-probe":
            return common._network_probe()
        if args.mode == "process-probe":
            return common._process_probe()
        if args.mode == "exec-probe":
            return common._exec_probe()
        required = (
            args.input,
            args.expected_sha256,
            args.output_directory,
            args.raw_output,
            args.bundle_output,
            args.artifacts,
            args.model_lock,
            args.conversion_timeout_seconds,
            args.selected_original_pages,
        )
        if any(value is None for value in required):
            return common._safe_result(
                {"state": "failed", "code": "invalid_input"}, 2
            )
        return _convert(args)
    except BaseException:
        return common._safe_result({"state": "failed", "code": "launcher_failed"}, 2)
    finally:
        if common._PROTOCOL_STDOUT is not None:
            os.close(common._PROTOCOL_STDOUT)
            common._PROTOCOL_STDOUT = None


if __name__ == "__main__":
    raise SystemExit(main())
