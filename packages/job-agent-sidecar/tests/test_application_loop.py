from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ggr_sidecar.application_loop import run_single_job_application_loop


def test_single_job_dry_run_loop_uses_tokened_cli_tools_and_correlates_audit(
    tmp_path: Path,
) -> None:
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    runner = SequencedRunner(
        [
            completed(extract_job_output()),
            completed(evaluate_job_output()),
            completed(issue_token_output(token_file)),
            completed(inspect_token_output(token_file)),
            completed(authorized_action_output(audit_file, dry_run=True)),
        ],
        audit_file=audit_file,
    )

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=token_file,
        audit_file=audit_file,
        runner=runner,
    )

    assert result.ok is True
    assert result.status == "completed"
    assert result.dryRun is True
    assert result.runId == "loop-run-1"
    assert result.jobId == "boss-job-123"
    assert [call.toolName for call in result.trace.toolCalls] == [
        "extract-job",
        "evaluate-job",
        "authorization-token:issue",
        "authorization-token:inspect",
        "authorized-action:start_chat",
    ]
    assert result.action is not None
    assert result.action.output is not None
    assert result.action.output.dryRun is True
    action_command = runner.commands[-1]
    assert action_command[action_command.index("--token-id") + 1] == "aat_test_token"
    assert "--confirm" not in action_command
    assert result.trace.toolCalls[-1].auditRecordCount == 1
    assert result.recovery.canAutomaticallyContinueRealActions is False


def test_single_job_confirmed_loop_requires_approval_and_cli_confirm(
    tmp_path: Path,
) -> None:
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    events: list[str] = []
    runner = SequencedRunner(
        [
            completed(extract_job_output()),
            completed(evaluate_job_output()),
            completed(issue_token_output(token_file)),
            completed(inspect_token_output(token_file)),
            completed(authorized_action_output(audit_file, dry_run=False)),
        ],
        audit_file=audit_file,
        on_command=lambda command: events.append("runner"),
    )

    def approve(request):
        events.append("approval")
        assert request.kind == "confirmed_single_job_loop"
        assert request.metadata.command == "single-job-loop"
        return {"outcome": "approved", "reasonCode": "HUMAN_APPROVED"}

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=token_file,
        audit_file=audit_file,
        confirm=True,
        approval_requester=approve,
        runner=runner,
    )

    assert events[0] == "approval"
    assert events.count("runner") == 5
    assert result.ok is True
    assert result.dryRun is False
    assert result.approval is not None
    assert result.approval.approved is True
    assert "--confirm" in runner.commands[-1]
    assert "--token-id" in runner.commands[-1]


def test_confirmed_loop_without_approval_stops_before_cli_tools(tmp_path: Path) -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        confirm=True,
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "approval_missing"
    assert result.trace.toolCalls == []
    assert result.recovery.recommendation == "safe_stop"


def test_loop_stops_when_cli_token_state_rejects_action_order(tmp_path: Path) -> None:
    runner = SequencedRunner(
        [
            completed(extract_job_output()),
            completed(evaluate_job_output()),
            completed(issue_token_output(tmp_path / "tokens.json")),
            completed(
                inspect_token_output(
                    tmp_path / "tokens.json",
                    status="unusable",
                    reason_code="ACTION_NOT_ALLOWED",
                )
            ),
        ],
    )

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "stopped"
    assert result.failureCategory == "authorization_rejected"
    assert result.recovery.stoppedAt is not None
    assert result.recovery.stoppedAt.toolName == "authorization-token:inspect"
    assert len(runner.commands) == 4


def test_loop_stops_on_action_subprocess_failure_with_recovery(tmp_path: Path) -> None:
    runner = SequencedRunner(
        [
            completed(extract_job_output()),
            completed(evaluate_job_output()),
            completed(issue_token_output(tmp_path / "tokens.json")),
            completed(inspect_token_output(tmp_path / "tokens.json")),
            subprocess.CompletedProcess(
                args=["node"],
                returncode=7,
                stdout=json.dumps({"ok": False, "reasonCode": "JOB_MISMATCH"}),
                stderr="browser target changed",
            ),
        ],
    )

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "failed"
    assert result.failureCategory == "subprocess_exit_error"
    assert result.recovery.recommendation == "rerun_from_cli_after_review"
    assert result.recovery.canAutomaticallyContinueRealActions is False


def test_loop_stops_on_schema_validation_failure(tmp_path: Path) -> None:
    malformed_evaluation = evaluate_job_output()
    del malformed_evaluation["finalDecision"]
    runner = SequencedRunner(
        [
            completed(extract_job_output()),
            completed(malformed_evaluation),
        ],
    )

    result = run_single_job_application_loop(
        repo_root=repo_root(),
        job_file=tmp_path / "input-job.json",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "failed"
    assert result.failureCategory == "stdout_validation_error"
    assert result.recovery.recommendation == "inspect_cli_contract"
    assert result.trace.toolCalls[-1].status == "validation_error"


class SequencedRunner:
    def __init__(
        self,
        responses: list[subprocess.CompletedProcess[str]],
        *,
        audit_file: Path | None = None,
        on_command=None,
    ) -> None:
        self.responses = list(responses)
        self.audit_file = audit_file
        self.on_command = on_command
        self.commands: list[list[str]] = []

    def __call__(self, command, **kwargs):
        self.commands.append(list(command))
        if self.on_command:
            self.on_command(command)
        if not self.responses:
            raise AssertionError(f"unexpected command {command}")
        response = self.responses.pop(0)
        if self.audit_file is not None and "authorized-action" in command:
            write_jsonl(
                self.audit_file,
                [
                    {
                        "runId": "loop-run-1",
                        "command": "authorized-action",
                        "profile": {"jobId": "boss-job-123"},
                        "actions": [{"type": "start_chat", "result": {"reasonCode": "DRY_RUN"}}],
                    }
                ],
            )
        return response


def completed(payload: dict) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["node"],
        returncode=0,
        stdout=json.dumps(payload),
        stderr="",
    )


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def extract_job_output() -> dict:
    return {
        "ok": True,
        "command": "extract-job",
        "source": "file",
        "profile": job_profile(),
    }


def evaluate_job_output() -> dict:
    return {
        "ok": True,
        "command": "evaluate-job",
        "profile": job_profile(),
        "candidateProfile": {"targetRoleDirection": "Python backend"},
        "ruleEvaluation": {
            "decision": "uncertain",
            "score": 64,
            "hardReject": False,
            "requiresLlmFinalDecision": True,
        },
        "llmEvaluation": {
            "decision": "apply",
            "resume_fit": "Candidate evidence matches backend work.",
            "intent_fit": "Role matches target direction.",
            "recall_context": "Reviewed from Python backend search.",
            "attention_technology_assessment": {
                "explanation": "No mismatch.",
            },
        },
        "finalDecision": {
            "decision": "apply",
            "source": "llm",
            "reason": "LLM authorized this job.",
        },
    }


def issue_token_output(token_file: Path) -> dict:
    return {
        "ok": True,
        "command": "authorization-token",
        "action": "issue",
        "issued": True,
        "token": {
            "tokenId": "aat_test_token",
            "tokenType": "application_authorization",
            "runId": "loop-run-1",
            "jobId": "boss-job-123",
            "allowedActions": ["start_chat"],
            "expiresAt": "2026-07-07T10:10:00.000Z",
            "consumption": {"state": "unconsumed"},
            "decisionEvidence": {"job": {"jobId": "boss-job-123"}},
        },
        "tokenFile": str(token_file),
    }


def inspect_token_output(
    token_file: Path,
    *,
    status: str = "valid",
    reason_code: str = "TOKEN_VALID",
) -> dict:
    return {
        "ok": True,
        "command": "authorization-token",
        "action": "inspect",
        "status": status,
        "reasonCode": reason_code,
        "inspectedAt": "2026-07-07T10:00:30.000Z",
        "token": issue_token_output(token_file)["token"],
        "tokenFile": str(token_file),
    }


def authorized_action_output(audit_file: Path, *, dry_run: bool) -> dict:
    return {
        "ok": True,
        "command": "authorized-action",
        "action": "start_chat",
        "runId": "loop-run-1",
        "dryRun": dry_run,
        "reasonCode": "DRY_RUN" if dry_run else "ACTION_EXECUTED",
        "validation": {
            "authorization": {
                "status": "valid",
                "reasonCode": "TOKEN_VALID",
                "runId": "loop-run-1",
                "jobIdentityAnchor": "boss-job-123",
            },
            "browserTarget": {
                "planned": dry_run,
                "jobIdentityAnchor": "boss-job-123",
            },
        },
        "authorizedJob": {"jobId": "boss-job-123", "title": "Python Backend"},
        "plannedAction": {"type": "start_chat"} if dry_run else None,
        "actionResult": None if dry_run else {"success": True, "clicked": True},
        "auditResult": {"auditFile": str(audit_file)},
    }


def job_profile() -> dict:
    return {
        "jobId": "boss-job-123",
        "title": "Python Backend",
        "company": "Example Co",
        "city": "Shanghai",
        "salary": "20-30K",
        "jd": "Build FastAPI services.",
        "recallKeyword": "Python",
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )
