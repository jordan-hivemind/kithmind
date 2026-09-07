import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ContentStream

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
ASSETS = HERE / "assets"
EXPECTED_FILES = {
    "contract-continuation.pdf",
    "financial-statement.pdf",
    "image-clear.pdf",
    "image-partial.pdf",
    "lab-report-unicode.pdf",
    "vehicle-receipt.pdf",
}
ASSET_HASHES = {
    "NotoSans.ttf": "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d",
    "NotoSansSymbols2-Regular.ttf": "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21",
    "OFL-NotoSans.txt": "cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a",
    "OFL-NotoSansSymbols2.txt": "b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_generator():
    spec = importlib.util.spec_from_file_location("fixture_generator", HERE / "generate_fixtures.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load fixture generator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FixtureContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.labels = json.loads((FIXTURES / "labels.v1.json").read_text(encoding="utf-8"))

    def test_authored_labels_match_six_fixture_pdfs(self):
        self.assertEqual(self.labels["version"], 1)
        self.assertEqual(
            {fixture["file"] for fixture in self.labels["fixtures"]},
            EXPECTED_FILES,
        )
        self.assertEqual(len(self.labels["fixtures"]), 6)

        fixture_ids = [fixture["id"] for fixture in self.labels["fixtures"]]
        self.assertEqual(len(fixture_ids), len(set(fixture_ids)))
        for fixture in self.labels["fixtures"]:
            pdf = FIXTURES / fixture["file"]
            self.assertTrue(pdf.is_file())
            self.assertEqual(digest(pdf), fixture["sha256"])
            self.assertEqual(len(PdfReader(str(pdf)).pages), fixture["expectedPages"])
            assertion_ids = [assertion["id"] for assertion in fixture["assertions"]]
            self.assertEqual(len(assertion_ids), len(set(assertion_ids)))
            for assertion in fixture["assertions"]:
                self.assertGreaterEqual(assertion["page"], 1)
                self.assertLessEqual(assertion["page"], fixture["expectedPages"])
                self.assertTrue(assertion["quote"])
                if "table" in assertion:
                    table = assertion["table"]
                    self.assertEqual(table["row"], int(table["row"]))
                    self.assertEqual(table["rowValues"][table["column"]], table["cellValue"])

    def test_text_pdf_labels_match_authored_page_content(self):
        for fixture in self.labels["fixtures"]:
            if fixture["kind"].startswith("image_"):
                continue
            reader = PdfReader(str(FIXTURES / fixture["file"]))
            page_text = [page.extract_text() or "" for page in reader.pages]
            for assertion in fixture["assertions"]:
                text = page_text[assertion["page"] - 1]
                if "table" not in assertion:
                    self.assertIn(assertion["quote"], text)
                else:
                    for value in assertion["table"]["rowValues"]:
                        self.assertIn(value, text)
            for forbidden in fixture["forbiddenValues"]:
                self.assertNotIn(forbidden, "\n".join(page_text))

    def test_astral_fixture_changes_utf16_page_offsets(self):
        fixture = next(item for item in self.labels["fixtures"] if item["id"] == "lab-report-unicode")
        text = PdfReader(str(FIXTURES / fixture["file"])).pages[0].extract_text() or ""
        self.assertIn("Astral marker: 🌍 retained", text)
        patient_b = next(item for item in fixture["assertions"] if item["id"] == "patient-b")
        codepoint_start = text.index(patient_b["quote"])
        utf16_start = len(text[:codepoint_start].encode("utf-16-le")) // 2
        self.assertEqual(utf16_start, codepoint_start + 1)

    def test_image_only_fixtures_have_no_native_text_layer(self):
        for filename in ("image-clear.pdf", "image-partial.pdf"):
            reader = PdfReader(str(FIXTURES / filename))
            self.assertEqual("".join(page.extract_text() or "" for page in reader.pages), "")
            for page in reader.pages:
                resources = page["/Resources"]
                operations = ContentStream(page["/Contents"], reader).operations
                self.assertFalse(
                    any(operator in {b"Tj", b"TJ", b"'", b'"'} for _, operator in operations)
                )
                images = [
                    item.get_object()
                    for item in resources["/XObject"].get_object().values()
                    if item.get_object().get("/Subtype") == "/Image"
                ]
                self.assertEqual(len(images), 1)

    def test_vendored_font_and_license_hashes(self):
        for filename, expected in ASSET_HASHES.items():
            self.assertEqual(digest(ASSETS / filename), expected)

    def test_generator_reproduces_committed_bytes_without_mutating_them(self):
        generator = load_generator()
        with tempfile.TemporaryDirectory() as directory:
            generator.OUT = Path(directory)
            generator.main()
            for filename in [*sorted(EXPECTED_FILES), "labels.v1.json"]:
                self.assertEqual(
                    (Path(directory) / filename).read_bytes(),
                    (FIXTURES / filename).read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
