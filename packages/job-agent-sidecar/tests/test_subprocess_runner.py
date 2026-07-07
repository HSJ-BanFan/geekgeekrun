from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ggr_sidecar.subprocess_runner import (
    build_dry_run_batch_command,
    run_confirmed_batch,
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
        audit_file=Path("audit.jsonl"),
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
    assert "--audit-file" in command
    assert command.count("--recall-keyword") == 2
    assert "--llm" in command
    assert "--headless" in command


def test_run_confirmed_batch_requires_approval_before_confirmed_cli() -> None:
    events: list[str] = []
    completed = subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout=json.dumps(run_batch_output(dry_run=False)),
        stderr="",
    )

    def approval_requester(request):
        events.append("approval")
        request_json = request.model_dump_json()
        assert "confirmed_batch" in request_json
        assert "CANARY_FULL_JOB_DESCRIPTION" not in request_json
        return {"outcome": "approved", "reasonCode": "HUMAN_APPROVED"}

    def runner(command, **kwargs):
        events.append("runner")
        assert "--confirm" in command
        return completed

    result = run_confirmed_batch(
        repo_root=repo_root(),
        recall_keywords=["CANARY_FULL_JOB_DESCRIPTION"],
        approval_requester=approval_requester,
        runner=runner,
    )

    assert events == ["approval", "runner"]
    assert result.ok is True
    assert result.status == "ok"
    assert result.output is not None
    assert result.output.dryRun is False
    assert "--confirm" in result.command
    assert result.approval is not None
    assert result.approval.outcome == "approved"


def test_run_confirmed_batch_denied_approval_stops_before_cli_command() -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_confirmed_batch(
        repo_root=repo_root(),
        approval_requester=lambda request: {"outcome": "denied", "reasonCode": "HUMAN_DENIED"},
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "approval_denied"
    assert "--confirm" not in result.command
    assert result.approval is not None
    assert result.approval.outcome == "denied"
    assert result.approval.request is not None
    assert result.approval.request.confirmRequired is True


def test_run_confirmed_batch_approval_timeout_stops_before_cli_command() -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_confirmed_batch(
        repo_root=repo_root(),
        approval_requester=lambda request: {"outcome": "timeout", "reasonCode": "APPROVAL_TIMEOUT"},
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "approval_timeout"
    assert "--confirm" not in result.command
    assert result.approval is not None
    assert result.approval.outcome == "timeout"


def test_run_confirmed_batch_cancelled_approval_stops_before_cli_command() -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_confirmed_batch(
        repo_root=repo_root(),
        approval_requester=lambda request: {"outcome": "cancelled", "reasonCode": "APPROVAL_CANCELLED"},
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "approval_cancelled"
    assert "--confirm" not in result.command
    assert result.approval is not None
    assert result.approval.outcome == "cancelled"


def test_run_confirmed_batch_without_approval_requester_never_emits_confirm() -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_confirmed_batch(repo_root=repo_root(), runner=runner)

    assert result.ok is False
    assert result.status == "approval_missing"
    assert "--confirm" not in result.command
    assert result.approval is not None
    assert result.approval.outcome == "missing"


def test_confirmed_approval_request_redacts_sensitive_values() -> None:
    canary_jd = "CANARY_FULL_JOB_DESCRIPTION"
    canary_greeting = "CANARY_FULL_GREETING"
    canary_resume = r"C:\Users\Meiosis\secret\resume.png"
    captured_requests: list[str] = []

    def approval_requester(request):
        captured_requests.append(request.model_dump_json())
        return {"outcome": "denied", "reasonCode": canary_resume}

    result = run_confirmed_batch(
        repo_root=repo_root(),
        progress_file=canary_resume,
        audit_file=canary_greeting,
        recall_keywords=[canary_jd],
        cities=[r"C:\Users\Meiosis\secret\city.txt"],
        approval_requester=approval_requester,
    )

    serialized_request = captured_requests[0]
    serialized_result = result.model_dump_json()
    assert canary_jd not in serialized_request
    assert canary_greeting not in serialized_request
    assert canary_resume not in serialized_request
    assert "secret" not in serialized_request
    assert canary_jd not in serialized_result
    assert canary_greeting not in serialized_result
    assert canary_resume not in serialized_result


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


def run_batch_output(*, dry_run: bool = True) -> dict:
    return {
        "ok": True,
        "command": "run-batch",
        "runId": "batch-1",
        "dryRun": dry_run,
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
                    "dryRun": dry_run,
                    "success": True,
                    "clicked": dry_run is False,
                },
                "sendGreeting": {
                    "dryRun": dry_run,
                    "textSent": dry_run is False,
                    "imageUploaded": False,
                },
                "nextJob": {
                    "dryRun": dry_run,
                    "moved": True,
                },
                "delivery": {
                    "successful": dry_run is False,
                    "textSent": dry_run is False,
                    "imageUploaded": False,
                },
                "sentCount": 0 if dry_run else 1,
                "targetCount": 1,
                "auditFile": None,
                "error": None,
            }
        ],
        "errors": [],
    }
