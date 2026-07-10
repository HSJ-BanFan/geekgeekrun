from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from ggr_sidecar.subprocess_runner import run_dry_run_batch


def test_installed_sidecar_builds_cli_command_from_manifest_not_path(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fixture = installed_runtime_fixture(tmp_path)
    unrelated_cwd = tmp_path / "unrelated-working-directory"
    unrelated_cwd.mkdir()
    path_trap = tmp_path / "path-trap"
    path_trap.mkdir()
    (path_trap / "ggr").write_text("must not be selected\n", encoding="utf-8")

    monkeypatch.chdir(unrelated_cwd)
    monkeypatch.setenv("GGR_JOB_AGENT_MODE", "installed")
    monkeypatch.setenv("GGR_JOB_AGENT_INSTALL_MANIFEST", str(fixture.manifest_path))
    monkeypatch.setenv("PATH", f"{path_trap}{os.pathsep}{os.environ.get('PATH', '')}")

    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=json.dumps(run_batch_output()),
        stderr="",
    )
    calls: list[tuple[list[str], dict]] = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return completed

    result = run_dry_run_batch(runner=runner)

    assert result.ok is True
    assert calls[0][0][:2] == [
        str(fixture.node_runtime_path),
        str(fixture.cli_path),
    ]
    assert calls[0][1]["cwd"] == str(unrelated_cwd)
    assert str(path_trap / "ggr") not in calls[0][0]


def test_direct_sidecar_version_runs_from_unrelated_cwd_without_pythonpath(
    tmp_path: Path,
) -> None:
    fixture = installed_runtime_fixture(tmp_path)
    unrelated_cwd = tmp_path / "unrelated-working-directory"
    unrelated_cwd.mkdir()
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env["GGR_JOB_AGENT_MODE"] = "installed"
    env["GGR_JOB_AGENT_INSTALL_MANIFEST"] = str(fixture.manifest_path)
    sidecar_command = shutil.which("ggr-sidecar")
    assert sidecar_command is not None

    completed = subprocess.run(
        [sidecar_command, "version"],
        cwd=unrelated_cwd,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    output = json.loads(completed.stdout)

    assert completed.stderr == ""
    assert output["ok"] is True
    assert output["command"] == "version"
    assert output["runtimeMode"] == "installed"
    assert output["distribution"]["version"] == "0.1.0"
    assert output["features"] == {
        "nodeCli": True,
        "sidecar": True,
        "openaiAgentsSdk": False,
    }


class InstalledRuntimeFixture:
    def __init__(
        self,
        *,
        manifest_path: Path,
        node_runtime_path: Path,
        cli_path: Path,
    ) -> None:
        self.manifest_path = manifest_path
        self.node_runtime_path = node_runtime_path
        self.cli_path = cli_path


def installed_runtime_fixture(tmp_path: Path) -> InstalledRuntimeFixture:
    install_root = tmp_path / "install"
    node_runtime_path = install_root / "runtime" / "node.exe"
    cli_path = install_root / "app" / "ggr.mjs"
    sidecar_path = install_root / "sidecar" / "ggr-sidecar.exe"
    manifest_path = install_root / "job-agent-installation-manifest.json"

    node_runtime_path.parent.mkdir(parents=True)
    cli_path.parent.mkdir(parents=True)
    sidecar_path.parent.mkdir(parents=True)
    node_runtime_path.write_text("controlled node runtime\n", encoding="utf-8")
    cli_path.write_text("controlled CLI entry\n", encoding="utf-8")
    sidecar_path.write_text("controlled sidecar entry\n", encoding="utf-8")
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": "job-agent-installation-manifest.v1",
                "distributionVersion": "0.1.0",
                "contracts": {
                    "cli": "job-agent-cli.v1",
                    "installationManifest": "job-agent-installation-manifest.v1",
                    "marketJobs": "market-jobs.v1",
                    "marketJobsAnalysis": "market-jobs-analysis.v1",
                },
                "features": {
                    "nodeCli": True,
                    "sidecar": True,
                    "openaiAgentsSdk": False,
                },
                "components": {
                    "nodeRuntime": component_record(install_root, node_runtime_path),
                    "nodeCli": component_record(install_root, cli_path),
                    "sidecar": component_record(install_root, sidecar_path),
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return InstalledRuntimeFixture(
        manifest_path=manifest_path,
        node_runtime_path=node_runtime_path,
        cli_path=cli_path,
    )


def component_record(install_root: Path, file_path: Path) -> dict[str, str]:
    return {
        "path": file_path.relative_to(install_root).as_posix(),
        "sha256": hashlib.sha256(file_path.read_bytes()).hexdigest(),
    }


def run_batch_output() -> dict:
    return {
        "ok": True,
        "command": "run-batch",
        "runId": "batch-1",
        "dryRun": True,
        "targetCount": 1,
        "sentCount": 0,
        "examinedCount": 0,
        "maxCandidates": 8,
        "candidateTimeoutMs": 240000,
        "browserOpenCount": 0,
        "queryCount": 0,
        "cityCodes": [],
        "queries": [],
        "progressFile": None,
        "results": [],
        "errors": [],
    }
