import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from parser_eval.manifest import (
    ManifestError,
    RAPIDOCR_LICENSE_SHA256,
    RAPIDOCR_LICENSE_URL,
    RAPIDOCR_URLS,
    canonical_json_hash,
    inventory_tree,
    load_manifest,
    verify_manifest,
)
from parser_eval.schema import ContractError, load_labels, verify_fixture_hashes


class SchemaAndManifestTest(unittest.TestCase):
    def test_labels_and_fixture_hash_are_strict(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            pdf = root / "one.pdf"
            pdf.write_bytes(b"%PDF-synthetic")
            labels = {
                "version": 1,
                "fixtures": [
                    {
                        "id": "one",
                        "file": "one.pdf",
                        "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
                        "expectedPages": 1,
                        "kind": "contract",
                        "assertions": [{"id": "a", "page": 1, "quote": "x"}],
                        "forbiddenValues": [],
                    }
                ],
            }
            path = root / "labels.json"
            path.write_text(json.dumps(labels), encoding="utf-8")
            loaded = load_labels(path)
            verify_fixture_hashes(loaded, root)
            labels["fixtures"][0]["unknown"] = True
            path.write_text(json.dumps(labels), encoding="utf-8")
            with self.assertRaises(ContractError):
                load_labels(path)

    def test_model_inventory_ignores_transport_cache_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            (root / "model").mkdir()
            (root / "model" / "weights.bin").write_bytes(b"weights")
            (root / ".cache").mkdir()
            (root / ".cache" / "download.metadata").write_text(
                "moving", encoding="utf-8"
            )
            files, total = inventory_tree(root)
            self.assertEqual([item["path"] for item in files], ["model/weights.bin"])
            verify_manifest(root, {"files": files, "totalBytes": total})
            (root / "model" / "link").symlink_to(root / "model" / "weights.bin")
            with self.assertRaises(ManifestError):
                inventory_tree(root)

    def test_model_lock_rejects_forged_fingerprint(self):
        with tempfile.TemporaryDirectory() as value:
            path = Path(value) / "lock.json"
            sources = [
                {
                    "kind": "huggingface",
                    "repository": "docling-project/docling-layout-heron",
                    "requestedRevision": "main",
                    "resolvedRevision": "1" * 40,
                    "declaredLicenses": [
                        {
                            "spdx": "Apache-2.0",
                            "source": "https://huggingface.co/docling-project/docling-layout-heron/blob/"
                            + "1" * 40
                            + "/README.md",
                            "contentSha256": "a" * 64,
                        }
                    ],
                },
                {
                    "kind": "huggingface",
                    "repository": "docling-project/docling-models",
                    "requestedRevision": "v2.3.0",
                    "resolvedRevision": "2" * 40,
                    "declaredLicenses": [
                        {
                            "spdx": "CDLA-Permissive-2.0",
                            "source": "https://huggingface.co/docling-project/docling-models/blob/"
                            + "2" * 40
                            + "/README.md",
                            "contentSha256": "b" * 64,
                        }
                    ],
                },
                {
                    "kind": "versioned_urls",
                    "repository": "RapidOCR model registry",
                    "requestedRevision": "onnxruntime:english",
                    "resolvedRevision": "PP-OCRv6",
                    "urls": sorted(RAPIDOCR_URLS),
                    "declaredLicenses": [
                        {
                            "spdx": "Apache-2.0",
                            "source": RAPIDOCR_LICENSE_URL,
                            "contentSha256": RAPIDOCR_LICENSE_SHA256,
                            "copyright": "Baidu/PaddleOCR model assets",
                        }
                    ],
                },
            ]
            license_bytes = b"licenses"
            content = {
                "schemaVersion": 1,
                "sources": sources,
                "licenses": [
                    {
                        "path": "MODEL-LICENSES.json",
                        "sha256": hashlib.sha256(license_bytes).hexdigest(),
                    }
                ],
                "totalBytes": len(license_bytes) + 2,
                "files": [
                    {
                        "path": "MODEL-LICENSES.json",
                        "bytes": len(license_bytes),
                        "sha256": hashlib.sha256(license_bytes).hexdigest(),
                    },
                    {
                        "path": "docling-project--docling-layout-heron/README.md",
                        "bytes": 1,
                        "sha256": "a" * 64,
                    },
                    {
                        "path": "docling-project--docling-models/README.md",
                        "bytes": 1,
                        "sha256": "b" * 64,
                    },
                ],
            }
            path.write_text(
                json.dumps({**content, "manifestSha256": canonical_json_hash(content)}),
                encoding="utf-8",
            )
            self.assertEqual(load_manifest(path)["totalBytes"], len(license_bytes) + 2)
            path.write_text(
                json.dumps({**content, "manifestSha256": "0" * 64}), encoding="utf-8"
            )
            with self.assertRaises(ManifestError):
                load_manifest(path)


if __name__ == "__main__":
    unittest.main()
