import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from parser_eval import convert_worker, production


class _Prediction:
    def __init__(self, tablestructure=None):
        self.tablestructure = tablestructure


class _Page:
    def __init__(self, page_no, tablestructure=None):
        self.page_no = page_no
        self.predictions = _Prediction(tablestructure)


class _PdfDocument:
    def __init__(self, count):
        self._count = count
        self.close = unittest.mock.Mock()

    def __len__(self):
        return self._count


class TableStructureBypassPolicyTests(unittest.TestCase):
    def test_normalizes_sorted_policy_and_rejects_untrusted_shapes(self):
        first = "b" * 64
        second = "a" * 64
        self.assertEqual(
            production._normalize_table_structure_bypass(
                {first: [2, 7], second: (1, 4)}
            ),
            ((second, (1, 4)), (first, (2, 7))),
        )
        invalid = [
            {},
            {"A" * 64: [1]},
            {first: [1], 1: [2]},
            {first: []},
            {first: [True]},
            {first: [1.0]},
            {first: [1, 1]},
            {first: [2, 1]},
            {first: [0]},
            {first: [65]},
            {
                f"{index:064x}": [1]
                for index in range(
                    production.MAX_TABLE_STRUCTURE_BYPASS_SOURCES + 1
                )
            },
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(production.ProductionFailure):
                production._normalize_table_structure_bypass(value)

    def test_fingerprint_binds_the_full_static_sorted_policy(self):
        manifest = {"manifestSha256": "f" * 64}
        first = "b" * 64
        second = "a" * 64
        unordered = {first: [2, 7], second: [1, 4]}
        reordered = {second: [1, 4], first: [2, 7]}
        policy_fingerprint = production._fingerprint(manifest, 150.0, "on", unordered)
        same_policy = production._fingerprint(manifest, 150.0, "on", reordered)
        changed_policy = production._fingerprint(
            manifest, 150.0, "on", {first: [2, 8], second: [1, 4]}
        )
        omitted = production._fingerprint(manifest, 150.0)

        self.assertEqual(policy_fingerprint["schemaVersion"], 3)
        self.assertEqual(
            policy_fingerprint["configuration"]["tableStructureBypass"],
            [
                {"sourceSha256": second, "pages": [1, 4]},
                {"sourceSha256": first, "pages": [2, 7]},
            ],
        )
        self.assertEqual(policy_fingerprint["fingerprint"], same_policy["fingerprint"])
        self.assertNotEqual(
            policy_fingerprint["fingerprint"], changed_policy["fingerprint"]
        )
        self.assertEqual(omitted["schemaVersion"], 2)
        self.assertNotIn("tableStructureBypass", omitted["configuration"])
        self.assertNotEqual(policy_fingerprint["fingerprint"], omitted["fingerprint"])

    def test_maximum_policy_profile_response_stays_below_protocol_limit(self):
        policy = {
            f"{index:064x}": list(range(1, 65))
            for index in range(production.MAX_TABLE_STRUCTURE_BYPASS_SOURCES)
        }
        with patch.object(
            production,
            "_verify_runtime_and_artifacts",
            return_value={"manifestSha256": "a" * 64},
        ):
            response = production.prepare_pdf_profile(
                artifacts=Path("/artifacts"),
                model_lock=Path("/model-lock"),
                table_structure_bypass=policy,
            )
        self.assertEqual(response["state"], "ready")
        self.assertEqual(response["parserFingerprint"]["schemaVersion"], 3)
        self.assertEqual(
            len(response["parserFingerprint"]["configuration"]["tableStructureBypass"]),
            32,
        )
        self.assertLess(len(json.dumps(response, separators=(",", ":")).encode()), 16 * 1024)


class SelectiveTableModelTests(unittest.TestCase):
    def test_mixed_batch_delegates_only_ordinary_pages_and_restores_order(self):
        selected = _Page(2)
        ordinary_one = _Page(1)
        ordinary_three = _Page(3)
        calls = []

        def delegate(conversion, pages):
            calls.append((conversion, [page.page_no for page in pages]))
            return list(pages)

        result = list(
            convert_worker._SelectiveTableModel(delegate, (2,))(
                "conversion", [ordinary_one, selected, ordinary_three]
            )
        )
        self.assertEqual(calls, [("conversion", [1, 3])])
        self.assertEqual(result, [ordinary_one, selected, ordinary_three])

    def test_selected_only_and_empty_selection_keep_delegate_contract(self):
        selected_one = _Page(1)
        selected_two = _Page(2)
        calls = []

        def rejected_delegate(_conversion, _pages):
            raise AssertionError("selected-only batch must not call table model")

        def delegate(_conversion, pages):
            calls.append([page.page_no for page in pages])
            return list(pages)

        selected_result = list(
            convert_worker._SelectiveTableModel(rejected_delegate, (1, 2))(
                None, [selected_one, selected_two]
            )
        )
        unknown_result = list(
            convert_worker._SelectiveTableModel(delegate, ())(
                None, [selected_one, selected_two]
            )
        )
        self.assertEqual(selected_result, [selected_one, selected_two])
        self.assertEqual(unknown_result, [selected_one, selected_two])
        self.assertEqual(calls, [[1, 2]])

    def test_rejects_untruthful_page_stage_results(self):
        ordinary_one = _Page(1)
        selected = _Page(2)
        ordinary_three = _Page(3)
        model = convert_worker._SelectiveTableModel
        for delegate in (
            lambda _conversion, pages: [pages[1], pages[0]],
            lambda _conversion, pages: [pages[0]],
            lambda _conversion, pages: [pages[0], pages[1], _Page(4)],
        ):
            with self.subTest(delegate=delegate), self.assertRaisesRegex(
                RuntimeError, "changed page identity or order"
            ):
                list(model(delegate, (2,))(None, [ordinary_one, selected, ordinary_three]))
        with self.assertRaisesRegex(RuntimeError, "duplicate pages"):
            list(model(lambda _conversion, pages: pages, (2,))(None, [_Page(1), _Page(1)]))
        with self.assertRaisesRegex(RuntimeError, "already has a table prediction"):
            list(
                model(lambda _conversion, pages: pages, (2,))(
                    None, [_Page(2, object()), _Page(1)]
                )
            )


class PdfPageCountTests(unittest.TestCase):
    def test_counts_pages_and_closes_the_pdfium_document(self):
        document = _PdfDocument(3)
        module = types.SimpleNamespace(PdfDocument=unittest.mock.Mock(return_value=document))
        with patch.dict(sys.modules, {"pypdfium2": module}):
            self.assertEqual(convert_worker._pdf_page_count(b"%PDF-synthetic"), 3)
        module.PdfDocument.assert_called_once_with(b"%PDF-synthetic")
        document.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
