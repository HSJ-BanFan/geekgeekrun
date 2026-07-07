from __future__ import annotations

import json
from pathlib import Path

from ggr_sidecar.observability import build_observability_report
from ggr_sidecar.schemas import CliToolResult, RunBatchOutput


def test_observability_report_correlates_successful_progress_and_audit(
    tmp_path: Path,
) -> None:
    progress_file = tmp_path / "progress.jsonl"
    audit_file = tmp_path / "audit.jsonl"
    write_jsonl(
        progress_file,
        [
            stage("batch-1", "browser:opened"),
            stage("batch-1", "extract:start", run_id="batch-1-001", candidate_index=1),
            stage(
                "batch-1",
                "decision:done",
                run_id="batch-1-001",
                candidate_index=1,
                job={"jobId": "job-1", "title": "Backend"},
                finalDecision={"decision": "apply", "reason": "llm decision applied"},
            ),
            {
                "batchRunId": "batch-1",
                "runId": "batch-1-001",
                "candidateIndex": 1,
                "job": {"jobId": "job-1", "title": "Backend"},
                "finalDecision": {"decision": "apply", "reason": "llm decision applied"},
                "delivery": {"successful": True, "textSent": False},
                "sentCount": 1,
                "targetCount": 1,
                "auditFile": str(audit_file),
                "error": None,
            },
        ],
    )
    write_jsonl(
        audit_file,
        [
            {
                "runId": "batch-1-001",
                "command": "run-batch",
                "profile": {"jobId": "job-1", "jdSummary": "safe summary"},
                "finalDecision": {"decision": "apply", "reason": "llm decision applied"},
                "actions": [{"type": "send_greeting", "result": {"textSent": False}}],
            }
        ],
    )

    report = build_observability_report(
        tool_result=successful_tool_result(progress_file),
        progress_file=progress_file,
        audit_file=audit_file,
    )

    assert report.runId == "batch-1"
    assert report.trace.status == "completed"
    assert report.trace.command is not None
    assert report.trace.command.subcommand == "run-batch"
    assert report.trace.progressRecordCount == 4
    assert report.trace.auditRecordCount == 1
    assert report.trace.jobs[0].runId == "batch-1-001"
    assert report.trace.jobs[0].jobId == "job-1"
    assert report.trace.jobs[0].decisionType == "apply"
    assert report.trace.jobs[0].auditRecordCount == 1
    assert report.trace.jobs[0].completed is True
    assert report.recovery.recommendation == "safe_stop"
    assert report.recovery.canAutomaticallyContinueRealActions is False


def test_failed_subprocess_correlation_explains_stop_without_leaking_canaries(
    tmp_path: Path,
) -> None:
    canary_jd = "CANARY_FULL_JOB_DESCRIPTION"
    canary_greeting = "CANARY_FULL_GREETING"
    canary_path = r"C:\Users\Meiosis\secret\resume.png"
    progress_file = tmp_path / "progress.jsonl"
    audit_file = tmp_path / "audit.jsonl"
    write_jsonl(
        progress_file,
        [
            stage("batch-2", "extract:done", run_id="batch-2-001", candidate_index=1),
            stage(
                "batch-2",
                "candidate:error",
                run_id="batch-2-001",
                candidate_index=1,
                job={"jobId": "job-2", "jd": canary_jd},
                error=f"CANDIDATE_TIMEOUT while reading {canary_path}",
                recoverable=True,
            ),
        ],
    )
    write_jsonl(
        audit_file,
        [
            {
                "runId": "batch-2-001",
                "profile": {"jobId": "job-2", "jdSummary": canary_jd},
                "actions": [
                    {
                        "type": "send_greeting",
                        "result": {"generatedGreetingText": canary_greeting},
                    }
                ],
            }
        ],
    )

    report = build_observability_report(
        tool_result=CliToolResult(
            ok=False,
            status="exit_error",
            command=["node", str(Path("packages/job-agent-cli/bin/ggr.mjs")), "run-batch"],
            exitCode=7,
            stderr=f"failed with {canary_path}",
            stdout="",
        ),
        progress_file=progress_file,
        audit_file=audit_file,
    )
    serialized = report.model_dump_json()

    assert report.trace.status == "failed"
    assert report.trace.failureCategory == "candidate_timeout"
    assert report.trace.retryDecision == "rerun_after_cli_revalidation"
    assert report.trace.stopDecision == "stop_without_continuing_actions"
    assert report.recovery.stoppedAt is not None
    assert report.recovery.stoppedAt.stage == "candidate:error"
    assert report.recovery.recommendation == "rerun_from_cli_after_review"
    assert canary_jd not in serialized
    assert canary_greeting not in serialized
    assert canary_path not in serialized


def test_missing_progress_or_audit_records_are_reported_as_warnings(
    tmp_path: Path,
) -> None:
    report = build_observability_report(
        tool_result=successful_tool_result(tmp_path / "missing-progress.jsonl"),
        progress_file=tmp_path / "missing-progress.jsonl",
        audit_file=tmp_path / "missing-audit.jsonl",
    )

    assert report.trace.progressRecordCount == 0
    assert report.trace.auditRecordCount == 0
    assert "progress_file_missing" in report.warnings
    assert "audit_file_missing" in report.warnings
    assert report.recovery.recommendation == "safe_stop"


def test_timeout_report_explains_interrupted_run_from_last_progress_stage(
    tmp_path: Path,
) -> None:
    progress_file = tmp_path / "progress.jsonl"
    write_jsonl(
        progress_file,
        [
            stage("batch-3", "extract:start", run_id="batch-3-001", candidate_index=1),
            stage(
                "batch-3",
                "browser-action:start",
                run_id="batch-3-001",
                candidate_index=1,
                job={"jobId": "job-3"},
                finalDecision={"decision": "apply", "reason": "final decision apply"},
                messageSkipReason="CANARY_FULL_GREETING",
            ),
        ],
    )

    report = build_observability_report(
        tool_result=CliToolResult(
            ok=False,
            status="timeout",
            command=["node", "C:/secret/ggr.mjs", "run-batch", "--progress-file", str(progress_file)],
            timedOut=True,
            timeoutMs=50,
            stdout="",
            stderr="CANARY_API_KEY",
        ),
        progress_file=progress_file,
        audit_file=None,
    )
    serialized = report.model_dump_json()

    assert report.trace.status == "interrupted"
    assert report.trace.failureCategory == "subprocess_timeout"
    assert report.recovery.stoppedAt is not None
    assert report.recovery.stoppedAt.stage == "browser-action:start"
    assert report.recovery.completedRunIds == []
    assert report.recovery.safeOptions == [
        "stop_and_inspect_progress",
        "rerun_dry_run_from_cli_after_revalidation",
    ]
    assert report.recovery.canAutomaticallyContinueRealActions is False
    assert "CANARY_FULL_GREETING" not in serialized
    assert "CANARY_API_KEY" not in serialized
    assert str(progress_file) not in serialized


def stage(
    batch_run_id: str,
    name: str,
    *,
    run_id: str | None = None,
    candidate_index: int | None = None,
    **extra,
) -> dict:
    return {
        "event": "stage",
        "timestamp": "2026-07-07T00:00:00.000Z",
        "batchRunId": batch_run_id,
        "runId": run_id,
        "candidateIndex": candidate_index,
        "stage": name,
        **extra,
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )


def successful_tool_result(progress_file: Path) -> CliToolResult:
    output = RunBatchOutput.model_validate(
        {
            "ok": True,
            "command": "run-batch",
            "runId": "batch-1",
            "dryRun": True,
            "targetCount": 1,
            "sentCount": 1,
            "examinedCount": 1,
            "maxCandidates": 8,
            "candidateTimeoutMs": 240000,
            "browserOpenCount": 1,
            "queryCount": 1,
            "cityCodes": ["101020100"],
            "queries": ["Python"],
            "progressFile": str(progress_file),
            "results": [
                {
                    "batchRunId": "batch-1",
                    "runId": "batch-1-001",
                    "candidateIndex": 1,
                    "job": {"jobId": "job-1"},
                    "finalDecision": {"decision": "apply", "reason": "matched"},
                    "sentCount": 1,
                    "targetCount": 1,
                }
            ],
            "errors": [],
        }
    )
    return CliToolResult(
        ok=True,
        status="ok",
        command=["node", "C:/private/ggr.mjs", "run-batch", "--progress-file", str(progress_file)],
        exitCode=0,
        stdout=output.model_dump_json(),
        stderr="",
        output=output,
    )
