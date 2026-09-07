import hashlib
import json
import copy
import unittest
from pathlib import Path
from unittest.mock import patch

from parser_eval.convert_worker import MAX_INPUT_BYTES
from parser_eval.production import (
    MAX_SERIALIZED_BUNDLE_BYTES,
    ParentExecutionBoundary,
    ProductionFailure,
    _normalized_bundle,
    _fingerprint,
    _extraction_fingerprint,
    derive_extraction_fingerprint,
    prepare_pdf_profile,
    convert_captured_pdf,
)


class ProductionParserTest(unittest.TestCase):
    data = b"%PDF-synthetic-capture"
    digest = hashlib.sha256(data).hexdigest()
    boundary = ParentExecutionBoundary(network_denied=True, resource_bounded=True)
    manifest = {"manifestSha256": "a" * 64}

    @staticmethod
    def conversion():
        provenance = {"page_no": 1}
        return (
            {
                "pages": [
                    {
                        "page": 1,
                        "text": "Before \U0001f30d Caf\u00e9",
                        "segments": [
                            {
                                "id": "docling-item-0",
                                "text": "Before \U0001f30d Caf\u00e9",
                                "startCodepoint": 0,
                                "endCodepoint": 13,
                                "citable": True,
                                "locator": {
                                    "kind": "docling_item",
                                    "itemRef": "#/texts/0",
                                    "provenance": provenance,
                                },
                            }
                        ],
                    }
                ],
                "tables": [],
                "mappingGaps": [],
            },
            {
                "texts": [
                    {
                        "self_ref": "#/texts/0",
                        "prov": [provenance],
                        "text": "Before \U0001f30d Caf\u00e9",
                    }
                ],
                "tables": [],
            },
        )

    def arguments(self, **overrides):
        value = {
            "data": self.data,
            "expected_sha256": self.digest,
            "opaque_input_name": f"pdf-{self.digest}.pdf",
            "artifacts": Path("artifacts"),
            "model_lock": Path("model-assets.lock.json"),
            "parent_boundary": self.boundary,
        }
        value.update(overrides)
        return value

    def call(self, **overrides):
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=self.conversion(),
            ) as converter,
        ):
            result = convert_captured_pdf(**self.arguments(**overrides))
        return result, converter

    def test_normalizes_astral_offsets_and_retains_locator_identity(self):
        result, converter = self.call()
        self.assertEqual(result["state"], "complete")
        converter.assert_called_once_with(
            self.data, f"pdf-{self.digest}.pdf", Path("artifacts"), 150.0
        )
        bundle = result["normalizedBundle"]
        segment = bundle["pages"][0]["segments"][0]
        self.assertEqual(segment["id"], "docling-item-0")
        self.assertEqual(segment["startUtf16"], 0)
        self.assertEqual(segment["endUtf16"], 14)
        self.assertEqual(segment["locator"]["provenance"]["page_no"], 1)
        self.assertEqual(bundle["parserFingerprint"]["modelManifestSha256"], "a" * 64)
        self.assertEqual(
            result["rawArtifact"]["sha256"],
            hashlib.sha256(
                json.dumps(
                    self.conversion()[1],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
        )

    def test_refuses_without_parent_network_and_resource_boundary(self):
        result, converter = self.call(
            parent_boundary=ParentExecutionBoundary(False, True)
        )
        self.assertEqual(
            result, {"state": "failed", "code": "execution_prerequisite_missing"}
        )
        converter.assert_not_called()

    def test_refuses_digest_mismatch_before_conversion(self):
        result, converter = self.call(expected_sha256="0" * 64)
        self.assertEqual(result, {"state": "failed", "code": "input_digest_mismatch"})
        converter.assert_not_called()

    def test_rejects_non_pdf_and_oversized_input_before_conversion(self):
        result, converter = self.call(data=b"not a pdf")
        self.assertEqual(result, {"state": "failed", "code": "invalid_input"})
        converter.assert_not_called()
        oversized = b"%PDF-" + b"x" * MAX_INPUT_BYTES
        digest = hashlib.sha256(oversized).hexdigest()
        result, converter = self.call(
            data=oversized,
            expected_sha256=digest,
            opaque_input_name=f"pdf-{digest}.pdf",
        )
        self.assertEqual(result, {"state": "failed", "code": "invalid_input"})
        converter.assert_not_called()

    def test_rejects_any_non_digest_opaque_name_before_conversion(self):
        result, converter = self.call(opaque_input_name="owner-file.pdf")
        self.assertEqual(result, {"state": "failed", "code": "invalid_opaque_name"})
        converter.assert_not_called()

    def test_rejects_unverified_models_before_conversion(self):
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                side_effect=ProductionFailure("model_assets_invalid"),
            ),
            patch("parser_eval.production._convert_docling") as converter,
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(result, {"state": "failed", "code": "model_assets_invalid"})
        converter.assert_not_called()

    def test_converter_failure_is_allowlisted_and_redacted(self):
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                side_effect=RuntimeError("/private/source.pdf bearer secret"),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(result, {"state": "failed", "code": "conversion_failed"})
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("secret", json.dumps(result))

    def test_real_retained_outputs_and_tampered_text_binding(self):
        root = Path(__file__).resolve().parents[1] / "results/2026-09-07/retained"
        paths = sorted(root.glob("docling*.normalized.json"))
        self.assertEqual(len(paths), 6)
        for path in paths:
            normalized = json.loads(path.read_text())
            raw = json.loads(
                path.with_name(
                    path.name.replace(".normalized.", ".lossless.")
                ).read_text()
            )
            with self.subTest(fixture=path.name):
                bundle = _normalized_bundle(
                    normalized, raw, normalized["sourceSha256"], {}
                )
                for page in bundle["pages"]:
                    for segment in page["segments"]:
                        encoded = page["text"].encode("utf-16-le")
                        self.assertEqual(
                            encoded[
                                segment["startUtf16"] * 2 : segment["endUtf16"] * 2
                            ].decode("utf-16-le"),
                            segment["text"],
                        )
                for kind in ("docling_item", "docling_table_row"):
                    altered = copy.deepcopy(normalized)
                    found = False
                    for page in altered["pages"]:
                        for segment in page["segments"]:
                            if segment["locator"]["kind"] != kind:
                                continue
                            start, end = (
                                segment["startCodepoint"],
                                segment["endCodepoint"],
                            )
                            segment["text"] = "Z" * (end - start)
                            page["text"] = (
                                page["text"][:start]
                                + segment["text"]
                                + page["text"][end:]
                            )
                            found = True
                            break
                        if found:
                            break
                    if found:
                        with self.assertRaises(ProductionFailure):
                            _normalized_bundle(
                                altered, raw, normalized["sourceSha256"], {}
                            )
                altered = copy.deepcopy(normalized)
                altered["pages"][0]["text"] += "unproven text"
                with self.assertRaises(ProductionFailure):
                    _normalized_bundle(altered, raw, normalized["sourceSha256"], {})

    def test_normalization_correction_preserves_raw_parser_identity(self):
        parser = _fingerprint(self.manifest, 150.0)
        before = _extraction_fingerprint(parser, "b" * 64)
        with patch(
            "parser_eval.production._implementation_sha256", return_value="c" * 64
        ):
            self.assertEqual(parser, _fingerprint(self.manifest, 150.0))
            after = _extraction_fingerprint(parser, "b" * 64)
        self.assertNotEqual(before["fingerprint"], after["fingerprint"])

    def test_preparse_configuration_is_available_without_pdf_conversion(self):
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch("parser_eval.production._convert_docling") as converter,
        ):
            profile = prepare_pdf_profile(
                artifacts=Path("artifacts"), model_lock=Path("lock")
            )
        self.assertEqual(profile["state"], "ready")
        converter.assert_not_called()
        result, _ = self.call()
        final = result["normalizedBundle"]["extractionFingerprint"]
        self.assertEqual(
            final["extractionConfigurationFingerprint"],
            profile["extractionConfiguration"]["fingerprint"],
        )
        self.assertEqual(
            result["rawArtifact"]["parserFingerprint"], profile["parserFingerprint"]
        )
        self.assertEqual(
            final["fingerprint"],
            derive_extraction_fingerprint(
                profile["parserFingerprint"]["fingerprint"],
                result["rawArtifact"]["sha256"],
                profile["extractionConfiguration"]["fingerprint"],
            ),
        )

    def test_extraction_identity_matches_shared_server_vector_and_binds_raw_artifact(
        self,
    ):
        self.assertEqual(
            derive_extraction_fingerprint("1" * 64, "2" * 64, "3" * 64),
            "1317bec934444929bd672b3c59398d1656e66d500a8208713027690d926256fd",
        )
        self.assertNotEqual(
            derive_extraction_fingerprint("1" * 64, "2" * 64, "3" * 64),
            derive_extraction_fingerprint("1" * 64, "4" * 64, "3" * 64),
        )
        with self.assertRaises(ProductionFailure):
            derive_extraction_fingerprint("1" * 64, "bad", "3" * 64)

    def test_rejects_empty_cross_page_and_duplicate_citable_locators(self):
        normalized, raw = self.conversion()
        normalized["pages"] = []
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=(normalized, raw),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(result, {"state": "failed", "code": "page_limit_exceeded"})

        normalized, raw = self.conversion()
        normalized["pages"][0]["segments"][0]["locator"]["provenance"]["page_no"] = 2
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=(normalized, raw),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(
            result, {"state": "failed", "code": "conversion_output_invalid"}
        )

        normalized, raw = self.conversion()
        duplicate = dict(normalized["pages"][0]["segments"][0])
        duplicate["id"] = "docling-item-1"
        duplicate["startCodepoint"] = 0
        duplicate["endCodepoint"] = 6
        duplicate["text"] = "Before"
        normalized["pages"][0]["segments"].insert(0, duplicate)
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=(normalized, raw),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(
            result, {"state": "failed", "code": "conversion_output_invalid"}
        )

    def test_rejects_nonfinite_raw_json(self):
        normalized, raw = self.conversion()
        raw["unsafe"] = float("nan")
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=(normalized, raw),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(
            result, {"state": "failed", "code": "conversion_output_invalid"}
        )

    def test_large_raw_artifact_does_not_consume_normalized_bundle_limit(self):
        normalized, raw = self.conversion()
        raw["opaqueParserPayload"] = "x" * (MAX_SERIALIZED_BUNDLE_BYTES + 1)
        with (
            patch(
                "parser_eval.production._verify_runtime_and_artifacts",
                return_value=self.manifest,
            ),
            patch(
                "parser_eval.production._convert_docling",
                return_value=(normalized, raw),
            ),
        ):
            result = convert_captured_pdf(**self.arguments())
        self.assertEqual(result["state"], "complete")
        self.assertGreater(
            result["rawArtifact"]["byteLength"], MAX_SERIALIZED_BUNDLE_BYTES
        )
        self.assertLess(
            len(json.dumps(result["normalizedBundle"], separators=(",", ":")).encode()),
            MAX_SERIALIZED_BUNDLE_BYTES,
        )


if __name__ == "__main__":
    unittest.main()
