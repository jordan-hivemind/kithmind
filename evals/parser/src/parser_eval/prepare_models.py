"""Explicit online setup for the pinned local Docling model bundle."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from .manifest import (
    canonical_json_hash,
    inventory_tree,
    load_manifest,
    verify_manifest,
)

HF_MODELS = (
    ("docling-project/docling-layout-heron", "main"),
    ("docling-project/docling-models", "v2.3.0"),
)

RAPIDOCR_LICENSES: list[dict[str, str]] = [
    {
        "spdx": "Apache-2.0",
        "source": "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/2661c7c0ef5c613e8f93c6e93b2e052399f0f854/LICENSE",
        "contentSha256": "3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e",
        "copyright": "Baidu/PaddleOCR model assets",
    }
]


def _hf_licenses(repo_id: str, resolved: str) -> list[dict[str, str]]:
    if repo_id == "docling-project/docling-layout-heron":
        return [
            {
                "spdx": "Apache-2.0",
                "source": f"https://huggingface.co/{repo_id}/blob/{resolved}/README.md",
                "contentSha256": "175700839bc7808eac6af1d0c23e4f483606ab2276fe01122f4093e61a1a65b6",
            }
        ]
    if repo_id == "docling-project/docling-models":
        return [
            {
                "spdx": "CDLA-Permissive-2.0",
                "source": f"https://huggingface.co/{repo_id}/blob/{resolved}/README.md",
                "contentSha256": "d17f233378eff1240b623b36da76ee8b40afcca05d505949713bf03f7e00822a",
            },
        ]
    raise RuntimeError("unsupported Hugging Face model source")


SOURCE_LICENSES: dict[str, list[dict[str, str]]] = {
    "RapidOCR model registry": [*RAPIDOCR_LICENSES],
}


def _download(
    output: Path, pinned: dict[str, object] | None
) -> list[dict[str, object]]:
    from huggingface_hub import HfApi, snapshot_download

    sources: list[dict[str, object]] = []
    api = HfApi()
    for repo_id, requested_revision in HF_MODELS:
        locked = next(
            (
                source
                for source in (pinned or {}).get("sources", [])  # type: ignore[union-attr]
                if source.get("kind") == "huggingface"
                and source.get("repository") == repo_id
            ),
            None,
        )
        resolved = (
            locked.get("resolvedRevision")
            if locked is not None
            else api.model_info(repo_id, revision=requested_revision).sha
        )
        if not isinstance(resolved, str) or len(resolved) != 40:
            raise RuntimeError(f"could not resolve {repo_id}")
        local_dir = output / repo_id.replace("/", "--")
        snapshot_download(repo_id=repo_id, revision=resolved, local_dir=local_dir)
        sources.append(
            {
                "kind": "huggingface",
                "repository": repo_id,
                "requestedRevision": requested_revision,
                "resolvedRevision": resolved,
                "declaredLicenses": _hf_licenses(repo_id, resolved),
            }
        )

    from docling.models.stages.ocr.rapid_ocr_model import (
        RapidOcrModel,
        _parse_rapidocr_model_spec,
        _rapidocr_artifacts,
        _resolve_rapidocr,
        _backend_to_engine_type,
    )

    requested = "onnxruntime:english"
    parsed = _parse_rapidocr_model_spec(requested)
    resolved_ocr = _resolve_rapidocr(parsed.user_lang or "english", parsed.backend)
    RapidOcrModel.download_models(
        backend=parsed.backend,
        lang=parsed.user_lang or "english",
        local_dir=output / RapidOcrModel._model_repo_folder,
        force=False,
        progress=True,
    )
    artifacts = _rapidocr_artifacts(
        output / RapidOcrModel._model_repo_folder,
        _backend_to_engine_type(parsed.backend),
        resolved_ocr.ppocr_version,
        resolved_ocr.rapidocr_lang_token or "en",
    )
    urls = sorted(
        {url for artifact in artifacts.values() for url in artifact.files.values()}
    )
    rapid_source: dict[str, object] = {
        "kind": "versioned_urls",
        "repository": "RapidOCR model registry",
        "requestedRevision": requested,
        "resolvedRevision": str(resolved_ocr.ppocr_version.value),
        "urls": urls,
        "declaredLicenses": SOURCE_LICENSES["RapidOCR model registry"],
    }
    if pinned is not None:
        locked_rapid = next(
            (
                source
                for source in pinned["sources"]  # type: ignore[index]
                if source.get("kind") == "versioned_urls"
                and source.get("repository") == "RapidOCR model registry"
            ),
            None,
        )
        if locked_rapid != rapid_source:
            raise RuntimeError("RapidOCR registry no longer matches the model lock")
    sources.append(rapid_source)
    (output / "MODEL-LICENSES.json").write_text(
        json.dumps(
            {"schemaVersion": 1, "sources": sources},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return sources


def _license_inventory(files: list[dict[str, object]]) -> list[dict[str, str]]:
    result = []
    for item in files:
        path = str(item["path"])
        if any(
            token in Path(path).name.lower()
            for token in ("license", "notice", "copying")
        ):
            result.append({"path": path, "sha256": str(item["sha256"])})
    return result


def prepare(output: Path, lock_output: Path, *, bootstrap: bool) -> dict[str, object]:
    if output.exists():
        raise RuntimeError("model output path must not already exist")
    if bootstrap and lock_output.exists():
        raise RuntimeError("bootstrap refuses to replace an existing model lock")
    if not bootstrap and not lock_output.is_file():
        raise RuntimeError(
            "model lock is missing; bootstrap is only for the first reviewed pin"
        )
    pinned = None if bootstrap else load_manifest(lock_output)
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        sources = _download(temporary, pinned)
        files, total = inventory_tree(temporary)
        manifest: dict[str, object] = {
            "schemaVersion": 1,
            "sources": sources,
            "licenses": _license_inventory(files),
            "totalBytes": total,
            "files": files,
        }
        manifest["manifestSha256"] = canonical_json_hash(manifest)
        if pinned is not None:
            verify_manifest(temporary, pinned)
            if manifest != pinned:
                raise RuntimeError("downloaded model metadata does not match the lock")
        temporary.rename(output)
        if bootstrap:
            lock_output.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
                + "\n",
                encoding="utf-8",
            )
        return manifest
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/models"))
    parser.add_argument(
        "--lock-output", type=Path, default=Path("model-assets.lock.json")
    )
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args(argv)
    try:
        manifest = prepare(args.output, args.lock_output, bootstrap=args.bootstrap)
    except Exception as exc:
        print(
            json.dumps(
                {"state": "failed", "code": "model_setup_failed", "detail": str(exc)}
            )
        )
        return 1
    print(
        json.dumps(
            {
                "state": "complete",
                "files": len(manifest["files"]),
                "bytes": manifest["totalBytes"],
                "manifestSha256": manifest["manifestSha256"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
