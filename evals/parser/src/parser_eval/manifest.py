"""Model and runtime manifest helpers with no heavy parser imports."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

MAX_MODEL_FILES = 10_000
MAX_MODEL_BYTES = 4 * 1024 * 1024 * 1024
RAPIDOCR_LICENSE_URL = (
    "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/"
    "2661c7c0ef5c613e8f93c6e93b2e052399f0f854/LICENSE"
)
RAPIDOCR_LICENSE_SHA256 = (
    "3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e"
)
RAPIDOCR_URLS = {
    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
}


class ManifestError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inventory_tree(root: Path) -> tuple[list[dict[str, Any]], int]:
    if not root.is_dir() or root.is_symlink():
        raise ManifestError("model root must be a real directory")
    files: list[dict[str, Any]] = []
    total = 0
    for path in sorted(root.rglob("*")):
        if ".cache" in path.relative_to(root).parts:
            continue
        if path.is_symlink():
            raise ManifestError("model tree contains a symbolic link")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        stat = path.stat()
        total += stat.st_size
        if len(files) >= MAX_MODEL_FILES or total > MAX_MODEL_BYTES:
            raise ManifestError("model tree exceeds the inventory bound")
        files.append(
            {"path": relative, "bytes": stat.st_size, "sha256": sha256_file(path)}
        )
    return files, total


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ManifestError("cannot read model lock") from exc
    if len(raw) > 4 * 1024 * 1024:
        raise ManifestError("model lock exceeds 4 MiB")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError("model lock is not valid UTF-8 JSON") from exc
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schemaVersion",
            "sources",
            "licenses",
            "totalBytes",
            "files",
            "manifestSha256",
        }
        or value.get("schemaVersion") != 1
    ):
        raise ManifestError("unsupported model lock")
    if not isinstance(value.get("files"), list) or not isinstance(
        value.get("sources"), list
    ):
        raise ManifestError("invalid model lock")
    if len(value["sources"]) != 3:
        raise ManifestError("model lock must contain the three reviewed sources")
    expected_sources = {
        "docling-project/docling-layout-heron": ("huggingface", "main"),
        "docling-project/docling-models": ("huggingface", "v2.3.0"),
        "RapidOCR model registry": ("versioned_urls", "onnxruntime:english"),
    }
    if [
        source.get("repository")
        for source in value["sources"]
        if isinstance(source, dict)
    ] != list(expected_sources):
        raise ManifestError("model sources must use the reviewed order")
    seen_sources: set[str] = set()
    for source_index, source in enumerate(value["sources"]):
        if not isinstance(source, dict) or not isinstance(
            source.get("declaredLicenses"), list
        ):
            raise ManifestError(
                f"model source {source_index} lacks a license declaration"
            )
        repository = source.get("repository")
        expected = expected_sources.get(repository)
        expected_keys = {
            "kind",
            "repository",
            "requestedRevision",
            "resolvedRevision",
            "declaredLicenses",
        }
        if source.get("kind") == "versioned_urls":
            expected_keys.add("urls")
        if (
            expected is None
            or repository in seen_sources
            or set(source) != expected_keys
            or (source.get("kind"), source.get("requestedRevision")) != expected
        ):
            raise ManifestError(f"unexpected model source {source_index}")
        seen_sources.add(repository)
        revision = source.get("resolvedRevision")
        if source["kind"] == "huggingface":
            if (
                not isinstance(revision, str)
                or len(revision) != 40
                or any(char not in "0123456789abcdef" for char in revision)
            ):
                raise ManifestError(f"invalid model revision for source {source_index}")
        elif revision != "PP-OCRv6":
            raise ManifestError("unexpected RapidOCR revision")
        urls = source.get("urls", [])
        if (
            not isinstance(urls, list)
            or len(urls) > 8
            or len(urls) != len(set(urls))
            or any(
                not isinstance(url, str)
                or not url.startswith("https://")
                or len(url) > 2048
                for url in urls
            )
        ):
            raise ManifestError(f"invalid source URLs for model source {source_index}")
        if source["kind"] == "versioned_urls" and len(urls) != 3:
            raise ManifestError("RapidOCR must contain exactly three pinned URLs")
        if not 1 <= len(source["declaredLicenses"]) <= 3:
            raise ManifestError(f"model source {source_index} lacks bounded licenses")
        seen_licenses: set[tuple[str, str]] = set()
        for license_value in source["declaredLicenses"]:
            if (
                not isinstance(license_value, dict)
                or not {"spdx", "source", "contentSha256"}
                <= set(license_value)
                <= {"spdx", "source", "contentSha256", "copyright"}
                or license_value.get("spdx")
                not in {"Apache-2.0", "CDLA-Permissive-2.0"}
                or not isinstance(license_value.get("source"), str)
                or not license_value["source"].startswith("https://")
                or len(license_value["source"]) > 2048
                or not isinstance(license_value.get("contentSha256"), str)
                or len(license_value["contentSha256"]) != 64
                or any(
                    char not in "0123456789abcdef"
                    for char in license_value["contentSha256"]
                )
                or (license_value["spdx"], license_value["source"]) in seen_licenses
            ):
                raise ManifestError(
                    f"invalid license declaration for model source {source_index}"
                )
            seen_licenses.add((license_value["spdx"], license_value["source"]))
    if seen_sources != set(expected_sources):
        raise ManifestError("model source set is incomplete")
    claimed = value.get("manifestSha256")
    content = {key: item for key, item in value.items() if key != "manifestSha256"}
    if not isinstance(claimed, str) or claimed != canonical_json_hash(content):
        raise ManifestError("model lock fingerprint mismatch")
    seen: set[str] = set()
    running_total = 0
    for index, item in enumerate(value["files"]):
        if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256"}:
            raise ManifestError(f"invalid model file entry {index}")
        relative = item["path"]
        size = item["bytes"]
        digest = item["sha256"]
        if (
            not isinstance(relative, str)
            or not relative
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or relative in seen
            or isinstance(size, bool)
            or not isinstance(size, int)
            or size < 0
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            raise ManifestError(f"invalid model file entry {index}")
        seen.add(relative)
        running_total += size
        if running_total > MAX_MODEL_BYTES or len(seen) > MAX_MODEL_FILES:
            raise ManifestError("model lock exceeds inventory bounds")
    if value.get("totalBytes") != running_total:
        raise ManifestError("model lock byte total mismatch")
    if [item["path"] for item in value["files"]] != sorted(seen):
        raise ManifestError("model files must be in canonical path order")
    file_hashes = {item["path"]: item["sha256"] for item in value["files"]}
    by_repository = {source["repository"]: source for source in value["sources"]}
    for repository, expected_spdx, readme_path in (
        (
            "docling-project/docling-layout-heron",
            "Apache-2.0",
            "docling-project--docling-layout-heron/README.md",
        ),
        (
            "docling-project/docling-models",
            "CDLA-Permissive-2.0",
            "docling-project--docling-models/README.md",
        ),
    ):
        source = by_repository[repository]
        license_value = source["declaredLicenses"][0]
        expected_url = f"https://huggingface.co/{repository}/blob/{source['resolvedRevision']}/README.md"
        if (
            len(source["declaredLicenses"]) != 1
            or license_value["spdx"] != expected_spdx
            or license_value["source"] != expected_url
            or license_value["contentSha256"] != file_hashes.get(readme_path)
        ):
            raise ManifestError(f"model card license mismatch for {repository}")
    rapid = by_repository["RapidOCR model registry"]
    rapid_license = rapid["declaredLicenses"][0]
    if (
        set(rapid["urls"]) != RAPIDOCR_URLS
        or len(rapid["declaredLicenses"]) != 1
        or rapid_license.get("spdx") != "Apache-2.0"
        or rapid_license.get("source") != RAPIDOCR_LICENSE_URL
        or rapid_license.get("contentSha256") != RAPIDOCR_LICENSE_SHA256
        or rapid_license.get("copyright") != "Baidu/PaddleOCR model assets"
    ):
        raise ManifestError("RapidOCR source or license mismatch")
    licenses = value.get("licenses")
    if not isinstance(licenses, list) or len(licenses) != 1:
        raise ManifestError("model lock must inventory downloaded license metadata")
    seen_license_paths: set[str] = set()
    for index, license_value in enumerate(licenses):
        if (
            not isinstance(license_value, dict)
            or set(license_value) != {"path", "sha256"}
            or not isinstance(license_value.get("path"), str)
            or license_value["path"] in seen_license_paths
            or file_hashes.get(license_value["path"]) != license_value.get("sha256")
            or not any(
                token in Path(license_value["path"]).name.lower()
                for token in ("license", "notice", "copying")
            )
        ):
            raise ManifestError(f"invalid downloaded license inventory entry {index}")
        seen_license_paths.add(license_value["path"])
    if seen_license_paths != {"MODEL-LICENSES.json"}:
        raise ManifestError("downloaded license inventory is incomplete")
    return value


def verify_manifest(root: Path, manifest: dict[str, Any]) -> None:
    actual, total = inventory_tree(root)
    if actual != manifest.get("files") or total != manifest.get("totalBytes"):
        raise ManifestError("model assets do not match the pinned lock")


def canonical_json_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
