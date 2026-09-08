from __future__ import annotations

import shutil
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


def prepare_pdf_profile(*, artifacts, model_lock, timeout_seconds):
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
