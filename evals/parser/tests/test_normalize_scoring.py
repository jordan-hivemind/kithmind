import unittest

from parser_eval.normalize import codepoint_to_utf16, utf16_slice
from parser_eval.scoring import score_fixture


def native_locator(page: int = 1):
    return {
        "kind": "pdfplumber_native_words",
        "page": page,
        "words": [{"text": "word", "x0": 0.0, "x1": 1.0, "top": 0.0, "bottom": 1.0}],
    }


def table_locator(page: int, row: int):
    return {
        "kind": "pdfplumber_table_row",
        "page": page,
        "sourceRowOffset": row,
        "tableBbox": [0.0, 0.0, 10.0, 10.0],
    }


class NormalizeAndScoringTest(unittest.TestCase):
    def test_astral_character_uses_two_utf16_code_units(self):
        text = "before 😀 Café after"
        start_cp = text.index("😀")
        start = codepoint_to_utf16(text, start_cp)
        end = codepoint_to_utf16(text, start_cp + len("😀 Café"))
        self.assertEqual(utf16_slice(text, start, end), "😀 Café")
        self.assertEqual(end - start, 7)

    def test_evidence_must_come_from_citable_insertion_interval(self):
        fixture = {
            "id": "mapped",
            "expectedPages": 1,
            "assertions": [{"id": "quote", "page": 1, "quote": "target"}],
            "forbiddenValues": [],
        }
        conversion = {
            "status": "success",
            "pages": [
                {
                    "page": 1,
                    "text": "prefix target",
                    "segments": [
                        {
                            "id": "prefix-only",
                            "text": "prefix",
                            "startCodepoint": 0,
                            "endCodepoint": 6,
                            "citable": True,
                            "locator": native_locator(),
                        }
                    ],
                }
            ],
            "tables": [],
        }
        result = score_fixture(fixture, conversion)
        self.assertFalse(result["passed"])
        self.assertEqual(
            result["assertions"][0]["reason"], "exact_mapped_quote_missing"
        )

    def test_repeated_rows_are_page_local_and_separately_mapped(self):
        page_text = "Fee | USD | 65.00\nFee | USD | 65.00"
        first_length = len("Fee | USD | 65.00")
        fixture = {
            "id": "table",
            "expectedPages": 1,
            "assertions": [
                {
                    "id": "second",
                    "page": 1,
                    "quote": "Fee | USD | 65.00",
                    "occurrence": 2,
                    "table": {
                        "id": "line-items",
                        "row": 1,
                        "column": 2,
                        "rowValues": ["Fee", "USD", "65.00"],
                        "cellValue": "65.00",
                    },
                }
            ],
            "forbiddenValues": [],
        }
        conversion = {
            "status": "success",
            "pages": [
                {
                    "page": 1,
                    "text": page_text,
                    "segments": [
                        {
                            "id": "row-0",
                            "text": "Fee | USD | 65.00",
                            "startCodepoint": 0,
                            "endCodepoint": first_length,
                            "citable": True,
                            "locator": table_locator(1, 1),
                        },
                        {
                            "id": "row-1",
                            "text": "Fee | USD | 65.00",
                            "startCodepoint": first_length + 1,
                            "endCodepoint": len(page_text),
                            "citable": True,
                            "locator": table_locator(1, 2),
                        },
                    ],
                }
            ],
            "tables": [
                {
                    "page": 1,
                    "ordinal": 0,
                    "citable": True,
                    "rows": [
                        {
                            "ordinal": 0,
                            "header": False,
                            "values": ["Fee", "USD", "65.00"],
                            "segmentId": "row-0",
                        },
                        {
                            "ordinal": 1,
                            "header": False,
                            "values": ["Fee", "USD", "65.00"],
                            "segmentId": "row-1",
                        },
                    ],
                }
            ],
        }
        result = score_fixture(fixture, conversion)
        self.assertTrue(result["passed"])
        self.assertEqual(result["assertions"][0]["locator"]["segmentId"], "row-1")

    def test_table_assertion_rejects_evidence_from_another_segment(self):
        fixture = {
            "id": "table",
            "expectedPages": 1,
            "assertions": [
                {
                    "id": "row",
                    "page": 1,
                    "quote": "USD 65.00",
                    "table": {
                        "id": "line-items",
                        "row": 0,
                        "column": 1,
                        "rowValues": ["Fee", "USD 65.00"],
                        "cellValue": "USD 65.00",
                    },
                }
            ],
            "forbiddenValues": [],
        }
        conversion = {
            "status": "success",
            "pages": [
                {
                    "page": 1,
                    "text": "USD 65.00\nFee | USD 65.00",
                    "segments": [
                        {
                            "id": "paragraph",
                            "text": "USD 65.00",
                            "startCodepoint": 0,
                            "endCodepoint": 9,
                            "citable": True,
                            "locator": native_locator(),
                        },
                        {
                            "id": "table-row",
                            "text": "Fee | USD 65.00",
                            "startCodepoint": 10,
                            "endCodepoint": 25,
                            "citable": True,
                            "locator": table_locator(1, 1),
                        },
                    ],
                }
            ],
            "tables": [
                {
                    "page": 1,
                    "ordinal": 0,
                    "citable": True,
                    "locator": native_locator(),
                    "rows": [
                        {
                            "ordinal": 0,
                            "header": False,
                            "values": ["Fee", "USD 65.00"],
                            "segmentId": "table-row",
                        }
                    ],
                }
            ],
        }
        result = score_fixture(fixture, conversion)
        self.assertFalse(result["passed"])
        self.assertEqual(
            result["assertions"][0]["table"]["reason"],
            "table_evidence_segment_mismatch",
        )

    def test_overlapping_or_empty_segment_id_fails_closed(self):
        fixture = {
            "id": "mapped",
            "expectedPages": 1,
            "assertions": [{"id": "quote", "page": 1, "quote": "target"}],
            "forbiddenValues": [],
        }
        for segments in (
            [
                {
                    "id": "one",
                    "text": "target",
                    "startCodepoint": 0,
                    "endCodepoint": 6,
                    "citable": True,
                    "locator": native_locator(),
                },
                {
                    "id": "two",
                    "text": "arget",
                    "startCodepoint": 1,
                    "endCodepoint": 6,
                    "citable": True,
                    "locator": native_locator(),
                },
            ],
            [
                {
                    "id": "",
                    "text": "target",
                    "startCodepoint": 0,
                    "endCodepoint": 6,
                    "citable": True,
                }
            ],
        ):
            conversion = {
                "status": "success",
                "pages": [{"page": 1, "text": "target", "segments": segments}],
                "tables": [],
            }
            self.assertFalse(score_fixture(fixture, conversion)["passed"])

    def test_missing_or_wrong_page_locator_fails_closed(self):
        fixture = {
            "id": "mapped",
            "expectedPages": 1,
            "assertions": [{"id": "quote", "page": 1, "quote": "target"}],
            "forbiddenValues": [],
        }
        for locator in (None, native_locator(2)):
            conversion = {
                "status": "success",
                "pages": [
                    {
                        "page": 1,
                        "text": "target",
                        "segments": [
                            {
                                "id": "one",
                                "text": "target",
                                "startCodepoint": 0,
                                "endCodepoint": 6,
                                "citable": True,
                                "locator": locator,
                            }
                        ],
                    }
                ],
                "tables": [],
            }
            self.assertFalse(score_fixture(fixture, conversion)["passed"])


if __name__ == "__main__":
    unittest.main()
