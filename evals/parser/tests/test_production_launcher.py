from __future__ import annotations

import shutil
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ProductionLauncherTests(unittest.TestCase):
    def test_native_stdout_and_stderr_cannot_pollute_protocol_result(self) -> None:
        launcher_source = (
            Path(__file__).parents[1] / "src" / "parser_eval" / "production_launcher.py"
        )
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "parser_eval"
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
            shutil.copy2(launcher_source, package / "production_launcher.py")
            (package / "production.py").write_text(
                """
import os


def prepare_pdf_profile(*, artifacts, model_lock, timeout_seconds, table_structure, table_structure_bypass):
    if table_structure != "off" or table_structure_bypass is not None:
        raise ValueError("table structure mode was not forwarded")
    os.write(1, b"native stdout noise\\n")
    os.write(2, b"native stderr noise\\n")
    return {
        "state": "ready",
        "parserFingerprint": {"fingerprint": "a" * 64},
        "extractionConfiguration": {"fingerprint": "b" * 64},
    }
""",
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "parser_eval.production_launcher",
                    "--mode",
                    "profile",
                    "--cpu-seconds",
                    "1",
                    "--file-bytes",
                    "4096",
                    "--open-files",
                    "64",
                    "--artifacts",
                    "/artifacts",
                    "--model-lock",
                    "/model-lock",
                    "--conversion-timeout-seconds",
                    "1",
                    "--table-structure",
                    "off",
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": temporary},
            )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            result.stdout,
            '{"extractionConfiguration":{"fingerprint":"'
            + "b" * 64
            + '"},"parserFingerprint":{"fingerprint":"'
            + "a" * 64
            + '"},"state":"ready"}\n',
        )

    def test_maximum_policy_profile_response_stays_below_protocol_limit(self) -> None:
        launcher_source = (
            Path(__file__).parents[1] / "src" / "parser_eval" / "production_launcher.py"
        )
        policy = {f"{index:064x}": list(range(1, 65)) for index in range(32)}
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "parser_eval"
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
            shutil.copy2(launcher_source, package / "production_launcher.py")
            (package / "production.py").write_text(
                """
def prepare_pdf_profile(*, artifacts, model_lock, timeout_seconds, table_structure, table_structure_bypass):
    descriptor = [{"sourceSha256": digest, "pages": pages} for digest, pages in sorted(table_structure_bypass.items())]
    return {
        "state": "ready",
        "parserFingerprint": {
            "schemaVersion": 3,
            "configuration": {"tableStructureBypass": descriptor},
            "fingerprint": "a" * 64,
        },
        "extractionConfiguration": {"fingerprint": "b" * 64},
    }
""",
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "parser_eval.production_launcher",
                    "--mode",
                    "profile",
                    "--cpu-seconds",
                    "1",
                    "--file-bytes",
                    "4096",
                    "--open-files",
                    "64",
                    "--artifacts",
                    "/artifacts",
                    "--model-lock",
                    "/model-lock",
                    "--conversion-timeout-seconds",
                    "1",
                    "--table-structure-bypass",
                    json.dumps(policy, separators=(",", ":")),
                ],
                check=False,
                capture_output=True,
                env={**os.environ, "PYTHONPATH": temporary},
            )
        self.assertEqual(result.returncode, 0)
        self.assertLess(len(result.stdout), 16 * 1024)
        response = json.loads(result.stdout)
        self.assertEqual(response["state"], "ready")
        self.assertEqual(
            len(
                response["parserFingerprint"]["configuration"]
                ["tableStructureBypass"]
            ),
            32,
        )

    def test_rejects_false_matched_or_unknown_selection_before_writing(self) -> None:
        launcher_source = (
            Path(__file__).parents[1] / "src" / "parser_eval" / "production_launcher.py"
        )
        data = b"%PDF-synthetic"
        digest = hashlib.sha256(data).hexdigest()
        cases = [
            ({digest: [1]}, [2]),
            ({"b" * 64: [1]}, [1]),
            ({digest: [1]}, [True]),
            ({digest: [1]}, [1.0]),
        ]
        for policy, reported in cases:
            with self.subTest(policy=policy), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                package = root / "parser_eval"
                package.mkdir()
                (package / "__init__.py").write_text("", encoding="utf-8")
                shutil.copy2(launcher_source, package / "production_launcher.py")
                (package / "production.py").write_text(
                    f"""
class ParentExecutionBoundary:
    def __init__(self, **_kwargs):
        pass

def convert_captured_pdf(**_kwargs):
    return {{
        "state": "complete",
        "rawArtifact": {{
            "json": {{"tables": []}},
            "sha256": "unused",
            "byteLength": 0,
            "parserFingerprint": {{"fingerprint": "a" * 64, "modelManifestSha256": "c" * 64}},
        }},
        "normalizedBundle": {{
            "pages": [],
            "extractionFingerprint": {{"fingerprint": "b" * 64}},
        }},
        "tableStructureBypassPages": {reported!r},
    }}
""",
                    encoding="utf-8",
                )
                input_path = root / "input.pdf"
                output = root / "output"
                output.mkdir()
                input_path.write_bytes(data)
                raw_path = output / "lossless.json"
                bundle_path = output / "bundle.json"
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "parser_eval.production_launcher",
                        "--mode",
                        "convert",
                        "--cpu-seconds",
                        "1",
                        "--file-bytes",
                        str(1024 * 1024),
                        "--open-files",
                        "64",
                        "--input",
                        str(input_path),
                        "--expected-sha256",
                        digest,
                        "--output-directory",
                        str(output),
                        "--raw-output",
                        str(raw_path),
                        "--bundle-output",
                        str(bundle_path),
                        "--artifacts",
                        "/artifacts",
                        "--model-lock",
                        "/model-lock",
                        "--conversion-timeout-seconds",
                        "1",
                        "--table-structure-bypass",
                        json.dumps(policy, separators=(",", ":")),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    env={**os.environ, "PYTHONPATH": temporary},
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(
                    json.loads(result.stdout),
                    {"state": "failed", "code": "conversion_output_invalid"},
                )
                self.assertFalse(raw_path.exists())
                self.assertFalse(bundle_path.exists())
