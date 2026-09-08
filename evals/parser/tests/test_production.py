import copy
import hashlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from parser_eval.convert_worker import (
    MAX_INPUT_BYTES,
    _docling_normalized,
    _provenance_whitespace_only,
)
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


class FakeProvenance:
    def __init__(self, page_no, charspan):
        self.page_no = page_no
        self.charspan = charspan

    def model_dump(self, **_kwargs):
        return {
            "page_no": self.page_no,
            "charspan": list(self.charspan),
            "bbox": {"l": 0, "t": 0, "r": 1, "b": 1, "coord_origin": "TOPLEFT"},
        }


class FakeTextItem:
    def __init__(self, self_ref, text, prov):
        self.self_ref = self_ref
        self.text = text
        self.prov = prov


class FakeTableItem:
    pass


FAKE_DOCLING_DOC = types.ModuleType("docling_core.types.doc")
FAKE_DOCLING_DOC.TextItem = FakeTextItem
FAKE_DOCLING_DOC.TableItem = FakeTableItem
FAKE_DOCLING_MODULES = {
    "docling_core": types.ModuleType("docling_core"),
    "docling_core.types": types.ModuleType("docling_core.types"),
    "docling_core.types.doc": FAKE_DOCLING_DOC,
}


class ProductionParserTest(unittest.TestCase):
    data = b"%PDF-synthetic-capture"
    digest = hashlib.sha256(data).hexdigest()
    boundary = ParentExecutionBoundary(network_denied=True, resource_bounded=True)
    manifest = {"manifestSha256": "a" * 64}

    @staticmethod
    def conversion():
        provenance = {
            "page_no": 1,
            "charspan": [0, 13],
            "bbox": {"l": 0, "t": 0, "r": 1, "b": 1, "coord_origin": "TOPLEFT"},
        }
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
                        "children": [],
                    }
                ],
                "tables": [],
                "groups": [],
                "body": {"children": [{"$ref": "#/texts/0"}]},
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
            self.data, f"pdf-{self.digest}.pdf", Path("artifacts"), 480.0, True
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

    def test_table_structure_mode_changes_identity_and_converter_option(self):
        table_on, _ = self.call(table_structure="on")
        table_off, converter = self.call(table_structure="off")
        self.assertEqual(table_on["state"], "complete")
        self.assertEqual(table_off["state"], "complete")
        self.assertNotEqual(
            table_on["rawArtifact"]["parserFingerprint"]["fingerprint"],
            table_off["rawArtifact"]["parserFingerprint"]["fingerprint"],
        )
        self.assertEqual(
            table_off["rawArtifact"]["parserFingerprint"]["schemaVersion"], 2
        )
        self.assertEqual(
            table_off["rawArtifact"]["parserFingerprint"]["configuration"]["tableStructure"],
            "off",
        )
        converter.assert_called_once_with(
            self.data, f"pdf-{self.digest}.pdf", Path("artifacts"), 480.0, False
        )
        self.assertEqual(
            convert_captured_pdf(**self.arguments(table_structure="automatic")),
            {"state": "failed", "code": "invalid_input"},
        )

    def test_retains_same_page_multi_span_items_and_ignores_empty_items(self):
        def provenance(page, start, end):
            return FakeProvenance(page, (start, end))

        retained = FakeTextItem(
            self_ref="#/texts/0",
            text="Alpha beta gamma",
            prov=[provenance(1, 0, 5), provenance(1, 6, 10), provenance(1, 11, 16)],
        )
        empty = FakeTextItem(
            self_ref="#/texts/1",
            text="",
            prov=[],
        )

        class Document:
            @staticmethod
            def iterate_items():
                return iter(((retained, 1), (empty, 1)))

        with patch.dict(sys.modules, FAKE_DOCLING_MODULES):
            pages, tables, gaps = _docling_normalized(Document(), 1)
        self.assertEqual(tables, [])
        self.assertEqual(gaps, [])
        self.assertEqual(pages[0]["text"], retained.text)
        segment = pages[0]["segments"][0]
        self.assertEqual(len(segment["locator"]["provenance"]), 3)
        self.assertEqual(
            [span["charspan"] for span in segment["locator"]["provenance"]],
            [[0, 5], [6, 10], [11, 16]],
        )

    def test_provenance_whitespace_policy_matches_protocol_vectors(self):
        self.assertTrue(_provenance_whitespace_only("\u0085"))
        self.assertTrue(_provenance_whitespace_only("\u00a0"))
        self.assertFalse(_provenance_whitespace_only("\u001c"))
        self.assertFalse(_provenance_whitespace_only("\ufeff"))
        self.assertFalse(_provenance_whitespace_only("🧪"))

    def test_cross_page_item_splits_in_neighbor_order_and_preserves_whitespace(self):
        def item(ref, spans):
            return FakeTextItem(
                self_ref=ref,
                text="Alpha beta",
                prov=[
                    FakeProvenance(page, charspan)
                    for page, charspan in spans
                ],
            )

        before = FakeTextItem("#/texts/0", "Before", [FakeProvenance(1, (0, 6))])
        cross_page = item("#/texts/1", [(1, (0, 5)), (2, (6, 10))])
        after = FakeTextItem("#/texts/2", "After", [FakeProvenance(2, (0, 5))])
        uncovered = item("#/texts/3", [(1, (0, 4)), (1, (6, 10))])

        class Document:
            @staticmethod
            def iterate_items():
                return iter(
                    ((before, 1), (cross_page, 1), (after, 1), (uncovered, 1))
                )

        with patch.dict(sys.modules, FAKE_DOCLING_MODULES):
            pages, _tables, gaps = _docling_normalized(Document(), 2)
        self.assertEqual(
            [page["text"] for page in pages], ["Before\nAlpha ", "beta\nAfter"]
        )
        self.assertEqual(
            [[segment["id"] for segment in page["segments"]] for page in pages],
            [
                ["docling-item-0", "docling-item-1-slice-0"],
                ["docling-item-1-slice-1", "docling-item-2"],
            ],
        )
        slices = [pages[0]["segments"][1], pages[1]["segments"][0]]
        self.assertEqual(
            [segment["locator"]["itemTextCharspan"] for segment in slices],
            [[0, 6], [6, 10]],
        )
        self.assertEqual(
            gaps,
            [{"kind": "ambiguous_text_provenance", "item": 3}],
        )

    def test_cross_page_item_owns_outer_whitespace_across_three_unicode_pages(self):
        text = "\u00a0Cafe\u0301 \nβ \t🧪\u0085"
        valid = FakeTextItem(
            "#/texts/0",
            text,
            [
                FakeProvenance(1, (1, 6)),
                FakeProvenance(2, (8, 9)),
                FakeProvenance(3, (11, 12)),
            ],
        )
        overlap = FakeTextItem(
            "#/texts/1",
            "Alpha beta",
            [FakeProvenance(1, (0, 5)), FakeProvenance(2, (4, 10))],
        )
        decreasing = FakeTextItem(
            "#/texts/2",
            "Alpha beta",
            [FakeProvenance(2, (0, 5)), FakeProvenance(1, (6, 10))],
        )

        class Document:
            @staticmethod
            def iterate_items():
                return iter(((valid, 1), (overlap, 1), (decreasing, 1)))

        with patch.dict(sys.modules, FAKE_DOCLING_MODULES):
            pages, _tables, gaps = _docling_normalized(Document(), 3)
        self.assertEqual(
            [page["text"] for page in pages],
            ["\u00a0Café ", "β \t", "🧪\u0085"],
        )
        self.assertEqual(
            [
                segment["locator"]["itemTextCharspan"]
                for page in pages
                for segment in page["segments"]
            ],
            [[0, 8], [8, 11], [11, 13]],
        )
        self.assertEqual(
            gaps,
            [
                {"kind": "ambiguous_text_provenance", "item": 1},
                {"kind": "ambiguous_text_provenance", "item": 2},
            ],
        )

    def test_normalized_bundle_binds_exact_multi_span_raw_provenance(self):
        normalized, raw = self.conversion()
        text = "Alpha beta gamma"
        provenance = [
            {"page_no": 1, "charspan": [0, 5]},
            {"page_no": 1, "charspan": [6, 10]},
            {"page_no": 1, "charspan": [11, 16]},
        ]
        normalized["pages"][0].update(
            {
                "text": text,
                "segments": [
                    {
                        "id": "docling-item-0",
                        "text": text,
                        "startCodepoint": 0,
                        "endCodepoint": len(text),
                        "citable": True,
                        "locator": {
                            "kind": "docling_item",
                            "itemRef": "#/texts/0",
                            "provenance": provenance,
                        },
                    }
                ],
            }
        )
        raw["texts"][0].update({"text": text, "prov": provenance})
        bundle = _normalized_bundle(normalized, raw, self.digest, {})
        self.assertEqual(bundle["pages"][0]["text"], text)
        altered = copy.deepcopy(normalized)
        altered["pages"][0]["segments"][0]["locator"]["provenance"][1][
            "charspan"
        ] = [4, 10]
        with self.assertRaises(ProductionFailure):
            _normalized_bundle(altered, raw, self.digest, {})

    def test_normalized_bundle_requires_complete_cross_page_slice_inventory(self):
        text = "Alpha 🧪 beta"
        provenance = [
            {"page_no": 1, "charspan": [0, 5]},
            {"page_no": 2, "charspan": [6, 7]},
            {"page_no": 2, "charspan": [8, 12]},
        ]

        def segment(identifier, page, indexes, charspan):
            start, end = charspan
            return {
                "id": identifier,
                "text": text[start:end],
                "startCodepoint": 0,
                "endCodepoint": end - start,
                "citable": True,
                "locator": {
                    "kind": "docling_item_slice",
                    "itemRef": "#/texts/0",
                    "provenance": provenance,
                    "provenanceIndexes": indexes,
                    "itemTextCharspan": charspan,
                    "doclingCharspanSemantics": "item_local_python_codepoints",
                },
            }

        first = segment("docling-item-0-slice-0", 1, [0, 1], [0, 6])
        second = segment("docling-item-0-slice-1", 2, [1, 3], [6, 12])
        normalized = {
            "pages": [
                {"page": 1, "text": first["text"], "segments": [first]},
                {"page": 2, "text": second["text"], "segments": [second]},
            ],
            "tables": [],
            "mappingGaps": [],
        }
        raw = {
            "texts": [
                {
                    "self_ref": "#/texts/0",
                    "text": text,
                    "prov": provenance,
                    "children": [],
                },
                {
                    "self_ref": "#/texts/1",
                    "text": text,
                    "prov": provenance,
                    "children": [],
                },
            ],
            "tables": [],
            "groups": [],
            "body": {"children": [{"$ref": "#/texts/0"}]},
            "furniture": {"children": [{"$ref": "#/texts/1"}]},
        }
        bundle = _normalized_bundle(normalized, raw, self.digest, {})
        self.assertEqual([page["text"] for page in bundle["pages"]], ["Alpha ", "🧪 beta"])

        omitted = copy.deepcopy(normalized)
        omitted["pages"][1].update({"text": "", "segments": []})
        with self.assertRaises(ProductionFailure):
            _normalized_bundle(omitted, raw, self.digest, {})

        fully_omitted = copy.deepcopy(normalized)
        for page in fully_omitted["pages"]:
            page.update({"text": "", "segments": []})
        fully_omitted["mappingGaps"] = [
            {"kind": "ambiguous_text_provenance", "item": 0}
        ]
        with self.assertRaises(ProductionFailure):
            _normalized_bundle(fully_omitted, raw, self.digest, {})

        nested_text = copy.deepcopy(raw)
        nested_text["texts"][0]["children"] = [{"$ref": "#/texts/1"}]
        with self.assertRaises(ProductionFailure):
            _normalized_bundle(normalized, nested_text, self.digest, {})

        excluded_layer = copy.deepcopy(nested_text)
        excluded_layer["texts"][1]["content_layer"] = "furniture"
        _normalized_bundle(normalized, excluded_layer, self.digest, {})

        picture_caption = copy.deepcopy(raw)
        picture_caption["body"] = {"children": [{"$ref": "#/pictures/0"}]}
        picture_caption["pictures"] = [
            {
                "children": [
                    {"$ref": "#/texts/0"},
                    {"$ref": "#/texts/1"},
                ],
                "captions": [{"$ref": "#/texts/0"}],
            }
        ]
        _normalized_bundle(normalized, picture_caption, self.digest, {})

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
        self.assertEqual(profile["parserFingerprint"]["schemaVersion"], 2)
        self.assertEqual(profile["parserFingerprint"]["configuration"]["tableStructure"], "on")
        self.assertEqual(profile["parserFingerprint"]["configuration"]["timeoutSeconds"], 480.0)
        with patch(
            "parser_eval.production._verify_runtime_and_artifacts",
            return_value=self.manifest,
        ):
            legacy_profile = prepare_pdf_profile(
                artifacts=Path("artifacts"), model_lock=Path("lock"), timeout_seconds=150
            )
        self.assertEqual(legacy_profile["state"], "ready")
        self.assertEqual(
            legacy_profile["parserFingerprint"]["configuration"]["timeoutSeconds"], 150.0
        )
        self.assertEqual(
            prepare_pdf_profile(
                artifacts=Path("artifacts"), model_lock=Path("lock"), timeout_seconds=481
            ),
            {"state": "failed", "code": "invalid_input"},
        )
        self.assertEqual(
            profile["extractionConfiguration"]["configuration"],
            {
                "mappingFormat": "docling_utf16_pages_v2",
                "maxPages": 64,
                "maxRetainedUtf8Bytes": 1024 * 1024,
                "maxBundleBytes": 4 * 1024 * 1024,
            },
        )
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
