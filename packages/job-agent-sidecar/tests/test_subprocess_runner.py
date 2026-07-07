from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ggr_sidecar.subprocess_runner import (
    build_dry_run_batch_command,
    run_dry_run_batch,
)


def test_run_dry_run_batch_parses_successful_cli_stdout() -> None:
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout=json.dumps(run_batch_output()),
        stderr="",
    )

    result = run_dry_run_batch(repo_root=repo_root(), runner=returns(completed))

    assert result.ok is True
    assert result.status == "ok"
    assert result.exitCode == 0
    assert result.output is not None
    assert result.output.command == "run-batch"
    assert result.output.dryRun is True
    assert result.output.results[0].job is not None
    assert result.output.results[0].job.jobId == "job-1"
    assert result.output.results[0].finalDecision is not None
    assert result.output.results[0].finalDecision.decision == "apply"
    assert "--confirm" not in result.command


def test_run_dry_run_batch_reports_malformed_json_stdout() -> None:
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout="{not json",
        stderr="diagnostic from cli",
    )

    result = run_dry_run_batch(repo_root=repo_root(), runner=returns(completed))

    assert result.ok is False
    assert result.status == "parse_error"
    assert result.parseError is not None
    assert result.stderr == "diagnostic from cli"


def test_run_dry_run_batch_reports_non_zero_exit() -> None:
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=7,
        stdout=json.dumps({"ok": False, "error": "CLI_FAILED"}),
        stderr="stack-like diagnostic",
    )

    result = run_dry_run_batch(repo_root=repo_root(), runner=returns(completed))

    assert result.ok is False
    assert result.status == "exit_error"
    assert result.exitCode == 7
    assert result.stderr == "stack-like diagnostic"
    assert result.stdout


def test_run_dry_run_batch_reports_timeout() -> None:
    def raises_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(
            cmd=args[0],
            timeout=kwargs["timeout"],
            output="partial stdout",
            stderr="partial stderr",
        )

    result = run_dry_run_batch(
        repo_root=repo_root(),
        timeout_ms=50,
        runner=raises_timeout,
    )

    assert result.ok is False
    assert result.status == "timeout"
    assert result.timedOut is True
    assert result.timeoutMs == 50
    assert result.stdout == "partial stdout"
    assert result.stderr == "partial stderr"


def test_run_dry_run_batch_reports_structured_validation_errors() -> None:
    payload = run_batch_output()
    del payload["runId"]
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout=json.dumps(payload),
        stderr="",
    )

    result = run_dry_run_batch(repo_root=repo_root(), runner=returns(completed))

    assert result.ok is False
    assert result.status == "validation_error"
    assert result.validationErrors is not None
    assert result.validationErrors[0].loc == ["runId"]


def test_build_dry_run_batch_command_never_adds_confirm() -> None:
    command = build_dry_run_batch_command(
        repo_root=repo_root(),
        node="node",
        target_count=3,
        max_candidates=9,
        candidate_timeout_ms=1_000,
        progress_file=Path("progress.jsonl"),
        recall_keywords=["Python", "AI"],
        cities=["101020100"],
        llm=True,
        headless=True,
    )

    assert command[:4] == [
        "node",
        str(repo_root() / "packages" / "job-agent-cli" / "bin" / "ggr.mjs"),
        "run-batch",
        "--from-browser",
    ]
    assert "--confirm" not in command
    assert command.count("--recall-keyword") == 2
    assert "--llm" in command
    assert "--headless" in command


def test_run_dry_run_batch_rejects_confirmed_cli_output() -> None:
    payload = run_batch_output()
    payload["dryRun"] = False
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout=json.dumps(payload),
        stderr="",
    )

    result = run_dry_run_batch(repo_root=repo_root(), runner=returns(completed))

    assert result.ok is False
    assert result.status == "validation_error"
    assert result.validationErrors is not None
    assert result.validationErrors[0].loc == ["dryRun"]


def returns(completed: subprocess.CompletedProcess[str]):
    def runner(*args, **kwargs):
        return completed

    return runner


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def run_batch_output() -> dict:
    return {
        "ok": True,
        "command": "run-batch",
        "runId": "batch-1",
        "dryRun": True,
        "targetCount": 1,
        "sentCount": 0,
        "examinedCount": 1,
        "maxCandidates": 8,
        "candidateTimeoutMs": 240000,
        "browserOpenCount": 1,
        "queryCount": 1,
        "cityCodes": ["101020100"],
        "queries": ["Python"],
        "progressFile": None,
        "results": [
            {
                "batchRunId": "batch-1",
                "runId": "batch-1-001",
                "candidateIndex": 1,
                "query": "Python",
                "city": "101020100",
                "job": {
                    "jobId": "job-1",
                    "title": "Python Backend",
                    "company": "Example Co",
                    "city": "Shanghai",
                    "salary": "20-30K",
                    "experience": "1-3 years",
                    "degree": "Bachelor",
                    "recallKeyword": "Python",
                    "bossName": "Hiring Manager",
                    "bossTitle": "Tech Lead",
                },
                "finalDecision": {
                    "decision": "apply",
                    "source": "rules",
                    "reason": "matched",
                },
                "startChat": {
                    "dryRun": True,
                    "success": True,
                    "clicked": False,
                },
                "sendGreeting": {
                    "dryRun": True,
                    "textSent": False,
                    "imageUploaded": False,
                },
                "nextJob": {
                    "dryRun": True,
                    "moved": True,
                },
                "delivery": {
                    "successful": False,
                    "textSent": False,
                    "imageUploaded": False,
                },
                "sentCount": 0,
                "targetCount": 1,
                "auditFile": None,
                "error": None,
            }
        ],
        "errors": [],
    }
