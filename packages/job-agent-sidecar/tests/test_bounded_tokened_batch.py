from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ggr_sidecar.application_loop import run_bounded_tokened_application_batch


def test_dry_run_bounded_batch_iterates_tokened_tools_until_target(
    tmp_path: Path,
) -> None:
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-1")),
            completed(evaluate_job_output("job-1")),
            completed(issue_token_output(token_file, "batch-1-001", "job-1", "token-1")),
            completed(inspect_token_output(token_file, "batch-1-001", "job-1", "token-1")),
            completed(authorized_action_output(audit_file, "batch-1-001", "job-1", dry_run=True)),
            completed(next_job_output(would_move=True)),
            completed(extract_job_output("job-2")),
            completed(evaluate_job_output("job-2")),
            completed(issue_token_output(token_file, "batch-1-002", "job-2", "token-2")),
            completed(inspect_token_output(token_file, "batch-1-002", "job-2", "token-2")),
            completed(authorized_action_output(audit_file, "batch-1-002", "job-2", dry_run=True)),
        ],
        audit_file=audit_file,
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-1",
        token_file=token_file,
        audit_file=audit_file,
        target_count=2,
        max_candidates=3,
        candidate_timeout_ms=30_000,
        recall_keywords=["Python"],
        cities=["101020100"],
        runner=runner,
    )

    assert result.ok is True
    assert result.status == "completed"
    assert result.dryRun is True
    assert result.appliedCount == 2
    assert result.examinedCount == 2
    assert [item.status for item in result.progress] == ["applied", "applied"]
    assert [item.jobId for item in result.progress] == ["job-1", "job-2"]
    assert result.progress[0].toolCalls[-1].toolName == "next-job"
    assert result.progress[0].auditRecordCount == 1
    assert result.recovery.canAutomaticallyContinueRealActions is False
    assert "--confirm" not in runner.commands[4]
    assert "--confirm" not in runner.commands[5]
    assert runner.commands[4][runner.commands[4].index("--token-id") + 1] == "token-1"


def test_confirmed_bounded_batch_requires_approval_and_cli_confirm(
    tmp_path: Path,
) -> None:
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    events: list[str] = []
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-1")),
            completed(evaluate_job_output("job-1")),
            completed(issue_token_output(token_file, "batch-2-001", "job-1", "token-1")),
            completed(inspect_token_output(token_file, "batch-2-001", "job-1", "token-1")),
            completed(authorized_action_output(audit_file, "batch-2-001", "job-1", dry_run=False)),
        ],
        audit_file=audit_file,
        on_command=lambda command: events.append("runner"),
    )

    def approve(request):
        events.append("approval")
        assert request.kind == "confirmed_bounded_tokened_batch"
        assert request.metadata.command == "bounded-tokened-batch"
        assert request.metadata.targetCount == 1
        return {"outcome": "approved", "reasonCode": "HUMAN_APPROVED"}

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-2",
        token_file=token_file,
        audit_file=audit_file,
        target_count=1,
        max_candidates=1,
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


def test_bounded_batch_stops_on_max_candidates_after_skipped_candidate(
    tmp_path: Path,
) -> None:
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-skip")),
            completed(evaluate_job_output("job-skip", decision="skip")),
            completed(token_not_issued_output("FINAL_DECISION_NOT_APPLY")),
        ],
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-limit",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        target_count=1,
        max_candidates=1,
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "stopped"
    assert result.stopReason == "max_candidates_reached"
    assert result.failureCategory == "max_candidates_reached"
    assert result.appliedCount == 0
    assert result.examinedCount == 1
    assert result.progress[0].status == "skipped"
    assert result.progress[0].decisionType == "skip"


def test_bounded_batch_stops_on_login_expired(
    tmp_path: Path,
) -> None:
    runner = SequencedRunner(
        [
            subprocess.CompletedProcess(
                args=["node"],
                returncode=1,
                stdout=json.dumps({"ok": False, "reasonCode": "LOGIN_EXPIRED"}),
                stderr="session expired",
            ),
        ],
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-login",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        target_count=1,
        max_candidates=3,
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "stopped"
    assert result.stopReason == "login_expired"
    assert result.failureCategory == "login_expired"
    assert result.progress[0].status == "stopped"
    assert "LOGIN_EXPIRED" in result.trace.reasonCodes
    assert len(runner.commands) == 1


def test_bounded_batch_stops_on_token_validation_failure(
    tmp_path: Path,
) -> None:
    token_file = tmp_path / "tokens.json"
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-token")),
            completed(evaluate_job_output("job-token")),
            completed(issue_token_output(token_file, "batch-token-001", "job-token", "token-expired")),
            completed(
                inspect_token_output(
                    token_file,
                    "batch-token-001",
                    "job-token",
                    "token-expired",
                    status="expired",
                    reason_code="TOKEN_EXPIRED",
                )
            ),
        ],
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-token",
        token_file=token_file,
        audit_file=tmp_path / "audit.jsonl",
        target_count=1,
        max_candidates=3,
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "stopped"
    assert result.stopReason == "token_validation_failure_limit_reached"
    assert result.failureCategory == "token_validation_failed"
    assert result.progress[0].status == "stopped"
    assert "TOKEN_EXPIRED" in result.progress[0].reasonCodes
    assert len(runner.commands) == 4


def test_bounded_batch_stops_on_browser_relocation_failure(
    tmp_path: Path,
) -> None:
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-1")),
            completed(evaluate_job_output("job-1")),
            completed(issue_token_output(token_file, "batch-relocate-001", "job-1", "token-1")),
            completed(inspect_token_output(token_file, "batch-relocate-001", "job-1", "token-1")),
            completed(authorized_action_output(audit_file, "batch-relocate-001", "job-1", dry_run=True)),
            completed(next_job_output(would_move=False)),
        ],
        audit_file=audit_file,
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-relocate",
        token_file=token_file,
        audit_file=audit_file,
        target_count=2,
        max_candidates=3,
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "stopped"
    assert result.stopReason == "browser_relocation_failed"
    assert result.failureCategory == "browser_relocation_failed"
    assert result.progress[0].status == "applied"
    assert result.progress[0].failureCategory == "browser_relocation_failed"
    assert result.appliedCount == 1
    assert len(runner.commands) == 6


def test_bounded_batch_stops_on_candidate_timeout(
    tmp_path: Path,
) -> None:
    def runner(command, **kwargs):
        raise subprocess.TimeoutExpired(
            cmd=command,
            timeout=kwargs["timeout"],
            output="partial CANARY_API_KEY",
            stderr="partial stderr",
        )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-timeout",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        target_count=1,
        max_candidates=3,
        candidate_timeout_ms=1,
        runner=runner,
    )

    serialized = result.model_dump_json()
    assert result.ok is False
    assert result.status == "stopped"
    assert result.stopReason == "candidate_timeout"
    assert result.failureCategory == "candidate_timeout"
    assert result.progress[0].status == "stopped"
    assert result.recovery.canAutomaticallyContinueRealActions is False
    assert "CANARY_API_KEY" not in serialized


def test_confirmed_bounded_batch_denied_approval_stops_before_cli_tools(
    tmp_path: Path,
) -> None:
    def runner(command, **kwargs):
        raise AssertionError(f"runner should not be called with {command}")

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-denied",
        token_file=tmp_path / "tokens.json",
        audit_file=tmp_path / "audit.jsonl",
        confirm=True,
        approval_requester=lambda request: {
            "outcome": "denied",
            "reasonCode": "HUMAN_DENIED",
        },
        runner=runner,
    )

    assert result.ok is False
    assert result.status == "approval_denied"
    assert result.progress == []
    assert result.approval is not None
    assert result.approval.outcome == "denied"
    assert result.recovery.recommendation == "safe_stop"


def test_bounded_batch_trace_and_progress_are_redacted(
    tmp_path: Path,
) -> None:
    canary_jd = "CANARY_FULL_JOB_DESCRIPTION"
    canary_greeting = "CANARY_FULL_GREETING"
    canary_path = str(tmp_path / "secret" / "resume.png")
    audit_file = tmp_path / "audit.jsonl"
    token_file = tmp_path / "tokens.json"
    runner = SequencedRunner(
        [
            completed(extract_job_output("job-redact", jd=canary_jd)),
            completed(evaluate_job_output("job-redact")),
            completed(issue_token_output(token_file, "batch-redact-001", "job-redact", "token-redact")),
            completed(inspect_token_output(token_file, "batch-redact-001", "job-redact", "token-redact")),
            completed(authorized_action_output(audit_file, "batch-redact-001", "job-redact", dry_run=True)),
        ],
        audit_file=audit_file,
    )

    result = run_bounded_tokened_application_batch(
        repo_root=repo_root(),
        batch_run_id="batch-redact",
        token_file=token_file,
        audit_file=audit_file,
        target_count=1,
        max_candidates=1,
        recall_keywords=[canary_jd],
        cities=[canary_path],
        runner=runner,
    )

    serialized = result.model_dump_json()
    assert result.ok is True
    assert canary_jd not in serialized
    assert canary_greeting not in serialized
    assert canary_path not in serialized
    assert "secret" not in serialized


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
            payload = json.loads(response.stdout)
            write_jsonl(
                self.audit_file,
                [
                    {
                        "runId": payload["runId"],
                        "command": "authorized-action",
                        "profile": {"jobId": payload["authorizedJob"]["jobId"]},
                        "actions": [
                            {
                                "type": "start_chat",
                                "result": {"reasonCode": payload["reasonCode"]},
                            }
                        ],
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


def extract_job_output(job_id: str, *, jd: str = "Build FastAPI services.") -> dict:
    return {
        "ok": True,
        "command": "extract-job",
        "source": "browser",
        "profile": job_profile(job_id, jd=jd),
    }


def evaluate_job_output(job_id: str, *, decision: str = "apply") -> dict:
    return {
        "ok": True,
        "command": "evaluate-job",
        "profile": job_profile(job_id),
        "candidateProfile": {"targetRoleDirection": "Python backend"},
        "ruleEvaluation": {
            "decision": "uncertain" if decision == "apply" else "skip",
            "score": 64,
            "hardReject": decision != "apply",
            "requiresLlmFinalDecision": decision == "apply",
        },
        "llmEvaluation": (
            {
                "decision": "apply",
                "resume_fit": "Candidate evidence matches backend work.",
                "intent_fit": "Role matches target direction.",
                "recall_context": "Reviewed from Python backend search.",
                "attention_technology_assessment": {
                    "explanation": "No mismatch.",
                },
            }
            if decision == "apply"
            else None
        ),
        "finalDecision": {
            "decision": decision,
            "source": "llm" if decision == "apply" else "rules",
            "reason": "LLM authorized this job." if decision == "apply" else "Rule Boundary denied.",
        },
    }


def issue_token_output(
    token_file: Path,
    run_id: str,
    job_id: str,
    token_id: str,
) -> dict:
    return {
        "ok": True,
        "command": "authorization-token",
        "action": "issue",
        "issued": True,
        "token": {
            "tokenId": token_id,
            "tokenType": "application_authorization",
            "runId": run_id,
            "jobId": job_id,
            "allowedActions": ["start_chat"],
            "expiresAt": "2026-07-07T10:10:00.000Z",
            "consumption": {"state": "unconsumed"},
            "decisionEvidence": {"job": {"jobId": job_id}},
        },
        "tokenFile": str(token_file),
    }


def token_not_issued_output(reason_code: str) -> dict:
    return {
        "ok": True,
        "command": "authorization-token",
        "action": "issue",
        "issued": False,
        "token": None,
        "reasonCode": reason_code,
        "reason": "not authorized",
    }


def inspect_token_output(
    token_file: Path,
    run_id: str,
    job_id: str,
    token_id: str,
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
        "token": issue_token_output(token_file, run_id, job_id, token_id)["token"],
        "tokenFile": str(token_file),
    }


def authorized_action_output(
    audit_file: Path,
    run_id: str,
    job_id: str,
    *,
    dry_run: bool,
) -> dict:
    return {
        "ok": True,
        "command": "authorized-action",
        "action": "start_chat",
        "runId": run_id,
        "dryRun": dry_run,
        "reasonCode": "DRY_RUN" if dry_run else "ACTION_EXECUTED",
        "validation": {
            "authorization": {
                "status": "valid",
                "reasonCode": "TOKEN_VALID",
                "runId": run_id,
                "jobIdentityAnchor": job_id,
            },
            "browserTarget": {
                "planned": dry_run,
                "jobIdentityAnchor": job_id,
            },
        },
        "authorizedJob": {"jobId": job_id, "title": "Python Backend"},
        "plannedAction": {"type": "start_chat"} if dry_run else None,
        "actionResult": None if dry_run else {"success": True, "clicked": True},
        "auditResult": {"auditFile": str(audit_file)},
    }


def next_job_output(*, would_move: bool = False, moved: bool = False) -> dict:
    result: dict = {"dryRun": not moved}
    if moved:
        result["moved"] = True
    else:
        result["wouldMove"] = would_move
    if not would_move and not moved:
        result["reason"] = "NO_NEXT_JOB"
    return {
        "ok": True,
        "command": "next-job",
        "result": result,
    }


def job_profile(job_id: str, *, jd: str = "Build FastAPI services.") -> dict:
    return {
        "jobId": job_id,
        "title": "Python Backend",
        "company": "Example Co",
        "city": "Shanghai",
        "salary": "20-30K",
        "jd": jd,
        "recallKeyword": "Python",
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(
        existing + "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )
