"""Run the preregistered synthetic parser evaluation under bounded isolation."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .manifest import canonical_json_hash, load_manifest, sha256_file, verify_manifest
from .schema import ContractError, load_labels, verify_fixture_hashes
from .scoring import score_fixture

CANDIDATES = ("docling-standard-cpu-ocr", "pdfplumber-native-text")
WALL_TIMEOUT_SECONDS = 210
STDIO_LIMIT_BYTES = 1024 * 1024
OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
RSS_LIMIT_BYTES = 4 * 1024 * 1024 * 1024
SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)"


def _child_limits() -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT_BYTES, OUTPUT_LIMIT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))


def _environment(home: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "TMPDIR": str(home),
        "PYTHONUTF8": "1",
        "PYTHONNOUSERSITE": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DOCLING_ARTIFACTS_PATH": "unused_explicit_argument_wins",
        "DOCLING_DEVICE": "cpu",
        "OMP_NUM_THREADS": "4",
        "TOKENIZERS_PARALLELISM": "false",
    }


def _sandbox_command(command: list[str]) -> list[str]:
    if platform.system() != "Darwin" or not Path("/usr/bin/sandbox-exec").is_file():
        raise RuntimeError(
            "macOS sandbox-exec network isolation is required for scored conversion"
        )
    return ["/usr/bin/sandbox-exec", "-p", SANDBOX_PROFILE, *command]


def verify_network_isolation() -> None:
    command = _sandbox_command(
        [sys.executable, "-m", "parser_eval.convert_worker", "--probe-network"]
    )
    completed = subprocess.run(
        command,
        env=_environment(Path(tempfile.gettempdir())),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("network isolation probe did not observe an OS-level denial")


def _bounded_log(path: Path) -> str:
    if not path.is_file():
        return ""
    with path.open("rb") as handle:
        return handle.read(STDIO_LIMIT_BYTES).decode("utf-8", errors="replace")


def _run_child(command: list[str], work: Path) -> dict[str, Any]:
    import psutil

    stdout_path = work / "stdout.log"
    stderr_path = work / "stderr.log"
    started = time.monotonic()
    timed_out = False
    memory_exceeded = False
    peak_rss = 0
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(
            _sandbox_command(command),
            cwd=work,
            env=_environment(work),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            preexec_fn=_child_limits,
        )
        tracked = psutil.Process(process.pid)
        while process.poll() is None:
            if time.monotonic() - started > WALL_TIMEOUT_SECONDS:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            try:
                processes = [tracked, *tracked.children(recursive=True)]
                current_rss = sum(
                    item.memory_info().rss for item in processes if item.is_running()
                )
                peak_rss = max(peak_rss, current_rss)
                if current_rss > RSS_LIMIT_BYTES:
                    memory_exceeded = True
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    break
            except (psutil.Error, ProcessLookupError):
                pass
            time.sleep(0.05)
        try:
            return_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return_code = process.wait()
    return {
        "returnCode": return_code,
        "timedOut": timed_out,
        "memoryExceeded": memory_exceeded,
        "elapsedSeconds": round(time.monotonic() - started, 6),
        "peakRssBytes": peak_rss or None,
        "stdout": _bounded_log(stdout_path),
        "stderr": _bounded_log(stderr_path),
    }


def _safe_failure(run: dict[str, Any]) -> str:
    if run["timedOut"]:
        return "conversion_timeout"
    if run["memoryExceeded"]:
        return "conversion_memory_limit"
    if run["returnCode"] < 0:
        return "conversion_resource_or_signal_failure"
    return "conversion_failed"


def _convert_one(
    fixture: dict[str, Any],
    fixture_dir: Path,
    artifacts: Path,
    output_dir: Path,
    candidate: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    safe_name = f"{candidate}--{fixture['id']}"
    with tempfile.TemporaryDirectory(prefix="parser-eval-") as temporary_value:
        temporary = Path(temporary_value)
        normalized_path = temporary / "normalized.json"
        raw_path = temporary / "lossless.json"
        command = [
            sys.executable,
            "-m",
            "parser_eval.convert_worker",
            "--candidate",
            candidate,
            "--input",
            str((fixture_dir / fixture["file"]).resolve()),
            "--output",
            str(normalized_path),
            "--raw-output",
            str(raw_path),
        ]
        if candidate == "docling-standard-cpu-ocr":
            command.extend(("--artifacts", str(artifacts.resolve())))
        run = _run_child(command, temporary)
        raw_log_dir = output_dir / "raw-logs"
        raw_log_dir.mkdir(mode=0o700, exist_ok=True)
        (raw_log_dir / f"{safe_name}.stdout.log").write_text(
            run.pop("stdout"), encoding="utf-8"
        )
        (raw_log_dir / f"{safe_name}.stderr.log").write_text(
            run.pop("stderr"), encoding="utf-8"
        )
        if (
            run["returnCode"] != 0
            or not normalized_path.is_file()
            or not raw_path.is_file()
        ):
            conversion = {
                "schemaVersion": 1,
                "candidate": candidate,
                "status": "failure",
                "pages": [],
                "tables": [],
                "mappingGaps": [],
            }
            return conversion, {**run, "state": "failed", "code": _safe_failure(run)}
        if (
            normalized_path.stat().st_size > OUTPUT_LIMIT_BYTES
            or raw_path.stat().st_size > OUTPUT_LIMIT_BYTES
        ):
            conversion = {
                "schemaVersion": 1,
                "candidate": candidate,
                "status": "failure",
                "pages": [],
                "tables": [],
                "mappingGaps": [],
            }
            return conversion, {
                **run,
                "state": "failed",
                "code": "conversion_output_too_large",
            }
        conversion = json.loads(normalized_path.read_bytes())
        if (
            not isinstance(conversion, dict)
            or conversion.get("status") != "success"
            or conversion.get("candidate") != candidate
            or conversion.get("sourceSha256") != fixture["sha256"]
        ):
            raise RuntimeError("converter returned an incoherent result")
        retained_dir = output_dir / "retained"
        retained_dir.mkdir(mode=0o700, exist_ok=True)
        normalized_retained = retained_dir / f"{safe_name}.normalized.json"
        raw_retained = retained_dir / f"{safe_name}.lossless.json"
        shutil.copyfile(normalized_path, normalized_retained)
        shutil.copyfile(raw_path, raw_retained)
        run.update(
            {
                "state": "complete",
                "normalizedOutput": normalized_retained.relative_to(
                    output_dir
                ).as_posix(),
                "normalizedSha256": sha256_file(normalized_retained),
                "losslessOutput": raw_retained.relative_to(output_dir).as_posix(),
                "losslessSha256": sha256_file(raw_retained),
            }
        )
        return conversion, run


def _versions() -> dict[str, str]:
    names = (
        "docling",
        "docling-core",
        "docling-ibm-models",
        "docling-parse",
        "pdfplumber",
        "psutil",
    )
    return {name: importlib.metadata.version(name) for name in names}


def _implementation_inventory() -> list[dict[str, str]]:
    package = Path(__file__).resolve().parent
    return [
        {"path": f"src/parser_eval/{path.name}", "sha256": sha256_file(path)}
        for path in sorted(package.glob("*.py"))
        if path.is_file()
    ]


def _machine() -> dict[str, Any]:
    cpu_model = platform.processor() or "unavailable"
    if platform.system() == "Darwin":
        completed = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            cpu_model = completed.stdout.strip()
    return {
        "operatingSystem": platform.system(),
        "release": platform.release(),
        "architecture": platform.machine(),
        "cpuModel": cpu_model,
        "logicalCpuCount": os.cpu_count(),
        "python": platform.python_version(),
    }


def evaluate(
    labels_path: Path, artifacts: Path, model_lock: Path, output_dir: Path
) -> dict[str, Any]:
    if output_dir.exists():
        raise RuntimeError("output directory must not already exist")
    labels = load_labels(labels_path)
    fixture_dir = labels_path.parent
    verify_fixture_hashes(labels, fixture_dir)
    manifest = load_manifest(model_lock)
    verify_manifest(artifacts, manifest)
    verify_network_isolation()
    output_dir.mkdir(parents=True, mode=0o700)
    results = []
    for candidate in CANDIDATES:
        for fixture in labels["fixtures"]:
            conversion, runtime = _convert_one(
                fixture, fixture_dir, artifacts, output_dir, candidate
            )
            results.append(
                {
                    "candidate": candidate,
                    "fixtureId": fixture["id"],
                    "runtime": runtime,
                    "mappingGaps": conversion.get("mappingGaps", []),
                    "score": score_fixture(fixture, conversion),
                }
            )
    configuration = {
        "allowedFormats": ["PDF"],
        "source": "local_bounded_bytes_document_stream",
        "doclingPipeline": "standard",
        "ocr": "RapidOCR onnxruntime English",
        "device": "cpu",
        "threads": 4,
        "remoteServices": False,
        "externalPlugins": False,
        "wallTimeoutSeconds": WALL_TIMEOUT_SECONDS,
        "maxInputBytes": 16 * 1024 * 1024,
        "maxPages": 64,
        "maxOutputBytesPerFile": OUTPUT_LIMIT_BYTES,
        "sampledProcessTreeRssLimitBytes": RSS_LIMIT_BYTES,
        "networkIsolation": "macos_sandbox_exec_deny_network_verified",
        "addressSpaceLimit": "unavailable_on_macos",
    }
    versions = _versions()
    implementation = _implementation_inventory()
    dependency_lock_sha256 = sha256_file(
        Path(__file__).resolve().parents[2] / "uv.lock"
    )
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "state": "complete"
        if all(item["runtime"]["state"] == "complete" for item in results)
        else "failed",
        "fixtureLabelsSha256": sha256_file(labels_path),
        "fixtureHashes": {
            fixture["file"]: fixture["sha256"] for fixture in labels["fixtures"]
        },
        "dependencyLockSha256": dependency_lock_sha256,
        "modelManifestSha256": manifest["manifestSha256"],
        "processingFingerprint": canonical_json_hash(
            {
                "configuration": configuration,
                "dependencyLockSha256": dependency_lock_sha256,
                "implementation": implementation,
                "models": manifest["manifestSha256"],
                "versions": versions,
            }
        ),
        "machine": _machine(),
        "versions": versions,
        "implementation": implementation,
        "configuration": configuration,
        "results": results,
        "limitations": {
            "unknownFieldDetection": "unverified_p2_10",
            "providerPlaceholderDetection": "not_applicable_synthetic_local_files",
            "linuxNetworkIsolation": "unverified",
        },
    }
    report_path = output_dir / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("fixtures/labels.v1.json"))
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/models"))
    parser.add_argument(
        "--model-lock", type=Path, default=Path("model-assets.lock.json")
    )
    parser.add_argument("--output", type=Path, default=Path("outputs/scored"))
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.labels, args.artifacts, args.model_lock, args.output)
    except (ContractError, Exception) as exc:
        print(
            json.dumps(
                {"state": "failed", "code": "evaluation_failed", "detail": str(exc)}
            )[:8192]
        )
        return 1
    print(json.dumps({"state": report["state"], "report": "report.json"}))
    return 0 if report["state"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
