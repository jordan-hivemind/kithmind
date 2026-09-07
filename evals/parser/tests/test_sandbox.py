import platform
import subprocess
import sys
import unittest
from pathlib import Path

from parser_eval.run import SANDBOX_PROFILE, _implementation_inventory


class ImplementationInventoryTest(unittest.TestCase):
    def test_code_inventory_is_relative_sorted_and_hashed(self):
        inventory = _implementation_inventory()
        self.assertEqual(
            [item["path"] for item in inventory],
            sorted(item["path"] for item in inventory),
        )
        self.assertTrue(
            all(item["path"].startswith("src/parser_eval/") for item in inventory)
        )
        self.assertTrue(all(len(item["sha256"]) == 64 for item in inventory))


@unittest.skipUnless(
    platform.system() == "Darwin" and Path("/usr/bin/sandbox-exec").is_file(),
    "macOS only",
)
class SandboxTest(unittest.TestCase):
    def test_network_probe_is_allowed_normally_and_denied_in_sandbox(self):
        command = [
            sys.executable,
            "-m",
            "parser_eval.convert_worker",
            "--probe-network",
        ]
        normal = subprocess.run(command, check=False, timeout=10)
        denied = subprocess.run(
            ["/usr/bin/sandbox-exec", "-p", SANDBOX_PROFILE, *command],
            check=False,
            timeout=10,
        )
        self.assertEqual(normal.returncode, 2)
        self.assertEqual(denied.returncode, 0)


if __name__ == "__main__":
    unittest.main()
