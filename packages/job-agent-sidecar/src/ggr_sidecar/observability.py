from __future__ import annotations

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import CliToolResult


class FlexibleObservabilityModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class CommandSummary(FlexibleObservabilityModel):
    executable: str | None = None
    subcommand: str | None = None
    options: list[str] = Field(default_factory=list)


class TraceJob(FlexibleObservabilityModel):
    runId: str | None = None
    candidateIndex: int | None = None
    jobId: str | None = None
    stage: str | None = None
    decisionType: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    durationMs: int | None = None
    auditRecordCount: int = 0
    completed: bool = False
    failureCategory: str | None = None


class TraceMetadata(FlexibleObservabilityModel):
    toolName: str
    runId: str
    status: Literal["completed", "failed", "interrupted"]
    command: CommandSummary | None = None
    durationMs: int | None = None
    progressRecordCount: int = 0
    auditRecordCount: int = 0
    jobs: list[TraceJob] = Field(default_factory=list)
    currentRunId: str | None = None
    currentCandidateIndex: int | None = None
    currentJobId: str | None = None
    currentStage: str | None = None
    failureCategory: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    retryDecision: str = "none"
    stopDecision: str = "stop_without_continuing_actions"


class RecoveryLocation(FlexibleObservabilityModel):
    runId: str | None = None
    candidateIndex: int | None = None
    jobId: str | None = None
    stage: str | None = None
    decisionType: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)


class RecoverySummary(FlexibleObservabilityModel):
    recommendation: str
    safeOptions: list[str] = Field(default_factory=list)
    canAutomaticallyContinueRealActions: bool = False
    stoppedAt: RecoveryLocation | None = None
    completedRunIds: list[str] = Field(default_factory=list)
    completedJobIds: list[str] = Field(default_factory=list)
    failedRunIds: list[str] = Field(default_factory=list)
    failedJobIds: list[str] = Field(default_factory=list)
    failureCategory: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    explanation: str


class ObservabilityReport(FlexibleObservabilityModel):
    runId: str
    trace: TraceMetadata
    recovery: RecoverySummary
    warnings: list[str] = Field(default_factory=list)


def build_observability_report(
    *,
    tool_result: CliToolResult,
    progress_file: Path | str | None = None,
    audit_file: Path | str | None = None,
) -> ObservabilityReport:
    warnings: list[str] = []
    progress_records = _read_jsonl_records(progress_file, "progress", warnings)
    inferred_run_id = _infer_run_id(tool_result, progress_records)
    progress_records = _records_for_batch(progress_records, inferred_run_id)
    run_ids = _candidate_run_ids(progress_records, tool_result)
    audit_records = _records_for_run_ids(
        _read_jsonl_records(audit_file, "audit", warnings),
        run_ids,
    )

    jobs = _build_trace_jobs(progress_records, audit_records, tool_result)
    status = _trace_status(tool_result)
    failure_category = _failure_category(tool_result, progress_records)
    current_job = jobs[-1] if jobs else None
    reason_codes = _dedupe(
        code
        for job in jobs
        for code in job.reasonCodes
    )
    if failure_category:
        reason_codes = _dedupe([*reason_codes, failure_category.upper()])

    trace = TraceMetadata(
        toolName="run-batch",
        runId=inferred_run_id,
        status=status,
        command=_summarize_command(tool_result.command),
        durationMs=_duration_ms(progress_records),
        progressRecordCount=len(progress_records),
        auditRecordCount=len(audit_records),
        jobs=jobs,
        currentRunId=current_job.runId if current_job else None,
        currentCandidateIndex=current_job.candidateIndex if current_job else None,
        currentJobId=current_job.jobId if current_job else None,
        currentStage=current_job.stage if current_job else None,
        failureCategory=failure_category,
        reasonCodes=reason_codes,
        retryDecision=_retry_decision(status, failure_category),
        stopDecision="stop_without_continuing_actions",
    )
    recovery = _build_recovery_summary(trace)
    return ObservabilityReport(
        runId=inferred_run_id,
        trace=trace,
        recovery=recovery,
        warnings=warnings,
    )


def _read_jsonl_records(
    file_path: Path | str | None,
    kind: Literal["progress", "audit"],
    warnings: list[str],
) -> list[dict[str, Any]]:
    if file_path is None:
        warnings.append(f"{kind}_file_not_provided")
        return []
    path = Path(file_path)
    if not path.exists():
        warnings.append(f"{kind}_file_missing")
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            warnings.append(f"{kind}_record_invalid_json:{line_number}")
            continue
        if isinstance(value, dict):
            records.append(value)
        else:
            warnings.append(f"{kind}_record_not_object:{line_number}")
    return records


def _infer_run_id(
    tool_result: CliToolResult,
    progress_records: list[dict[str, Any]],
) -> str:
    if tool_result.output is not None:
        return tool_result.output.runId
    for record in progress_records:
        run_id = _string(record.get("batchRunId")) or _string(record.get("runId"))
        if run_id:
            return run_id
    return "unknown"


def _records_for_batch(
    records: list[dict[str, Any]],
    batch_run_id: str,
) -> list[dict[str, Any]]:
    if batch_run_id == "unknown":
        return records
    return [
        record
        for record in records
        if record.get("batchRunId") in (None, batch_run_id)
        or record.get("runId") == batch_run_id
        or str(record.get("runId", "")).startswith(f"{batch_run_id}-")
    ]


def _candidate_run_ids(
    progress_records: list[dict[str, Any]],
    tool_result: CliToolResult,
) -> set[str]:
    ids = {
        run_id
        for run_id in (_string(record.get("runId")) for record in progress_records)
        if run_id
    }
    if tool_result.output is not None:
        ids.add(tool_result.output.runId)
        for result in tool_result.output.results:
            if result.runId:
                ids.add(result.runId)
    return ids


def _records_for_run_ids(
    records: list[dict[str, Any]],
    run_ids: set[str],
) -> list[dict[str, Any]]:
    if not run_ids:
        return []
    return [
        record
        for record in records
        if _string(record.get("runId")) in run_ids
    ]


def _build_trace_jobs(
    progress_records: list[dict[str, Any]],
    audit_records: list[dict[str, Any]],
    tool_result: CliToolResult,
) -> list[TraceJob]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in progress_records:
        run_id = _string(record.get("runId"))
        if run_id:
            grouped.setdefault(run_id, []).append(record)
    if tool_result.output is not None:
        for result in tool_result.output.results:
            grouped.setdefault(result.runId, []).append(
                result.model_dump(exclude_none=True)
            )

    jobs: list[TraceJob] = []
    for run_id, records in grouped.items():
        if _looks_like_batch_id(run_id, tool_result.output.runId if tool_result.output else None):
            continue
        jobs.append(_trace_job_from_records(run_id, records, audit_records))
    return sorted(
        jobs,
        key=lambda job: (
            job.candidateIndex if job.candidateIndex is not None else 1_000_000,
            job.runId or "",
        ),
    )


def _trace_job_from_records(
    run_id: str,
    records: list[dict[str, Any]],
    audit_records: list[dict[str, Any]],
) -> TraceJob:
    latest = records[-1]
    job_id = _first_string(
        _nested(latest, "job", "jobId"),
        *(_nested(record, "job", "jobId") for record in reversed(records)),
    )
    decision_type = _first_string(
        _nested(latest, "finalDecision", "decision"),
        *(_nested(record, "finalDecision", "decision") for record in reversed(records)),
    )
    failure_category = _record_failure_category(records)
    return TraceJob(
        runId=run_id,
        candidateIndex=_first_int(
            latest.get("candidateIndex"),
            *(record.get("candidateIndex") for record in reversed(records)),
        ),
        jobId=job_id,
        stage=_first_string(
            latest.get("stage"),
            *(record.get("stage") for record in reversed(records)),
        ),
        decisionType=decision_type,
        reasonCodes=_reason_codes_for_records(records, failure_category),
        durationMs=_duration_ms(records),
        auditRecordCount=sum(
            1 for record in audit_records if _string(record.get("runId")) == run_id
        ),
        completed=_is_completed_job(records),
        failureCategory=failure_category,
    )


def _trace_status(tool_result: CliToolResult) -> Literal["completed", "failed", "interrupted"]:
    if tool_result.status == "timeout":
        return "interrupted"
    if not tool_result.ok:
        return "failed"
    if tool_result.output is not None and not tool_result.output.ok:
        return "failed"
    return "completed"


def _failure_category(
    tool_result: CliToolResult,
    progress_records: list[dict[str, Any]],
) -> str | None:
    progress_failure = _record_failure_category(progress_records)
    if progress_failure:
        return progress_failure
    if tool_result.status == "timeout":
        return "subprocess_timeout"
    if tool_result.status == "exit_error":
        return "subprocess_exit_error"
    if tool_result.status == "parse_error":
        return "stdout_parse_error"
    if tool_result.status == "validation_error":
        return "stdout_validation_error"
    if tool_result.output is not None and tool_result.output.errors:
        return "cli_reported_error"
    return None


def _record_failure_category(records: list[dict[str, Any]]) -> str | None:
    for record in reversed(records):
        error = _string(record.get("error"))
        if not error:
            continue
        if "CANDIDATE_TIMEOUT" in error:
            return "candidate_timeout"
        if record.get("recoverable") is True:
            return "recoverable_browser_error"
        return "application_error"
    return None


def _build_recovery_summary(trace: TraceMetadata) -> RecoverySummary:
    completed_jobs = [job for job in trace.jobs if job.completed and not job.failureCategory]
    failed_jobs = [job for job in trace.jobs if job.failureCategory]
    stopped_at = _recovery_location(trace.jobs[-1]) if trace.jobs else None
    if trace.status == "completed":
        recommendation = "safe_stop"
        safe_options = ["safe_stop"]
        explanation = "Run completed; no automatic continuation is needed."
    elif trace.failureCategory in {"stdout_parse_error", "stdout_validation_error"}:
        recommendation = "inspect_cli_contract"
        safe_options = ["stop_and_inspect_progress"]
        explanation = "Run output could not be trusted; inspect CLI stdout and records before rerunning."
    else:
        recommendation = "rerun_from_cli_after_review"
        safe_options = [
            "stop_and_inspect_progress",
            "rerun_dry_run_from_cli_after_revalidation",
        ]
        explanation = "Run did not complete; stop first, review redacted records, then rerun through the CLI if still authorized."

    return RecoverySummary(
        recommendation=recommendation,
        safeOptions=safe_options,
        canAutomaticallyContinueRealActions=False,
        stoppedAt=stopped_at if trace.status != "completed" else None,
        completedRunIds=[job.runId for job in completed_jobs if job.runId],
        completedJobIds=[job.jobId for job in completed_jobs if job.jobId],
        failedRunIds=[job.runId for job in failed_jobs if job.runId],
        failedJobIds=[job.jobId for job in failed_jobs if job.jobId],
        failureCategory=trace.failureCategory,
        reasonCodes=trace.reasonCodes,
        explanation=explanation,
    )


def _recovery_location(job: TraceJob) -> RecoveryLocation:
    return RecoveryLocation(
        runId=job.runId,
        candidateIndex=job.candidateIndex,
        jobId=job.jobId,
        stage=job.stage,
        decisionType=job.decisionType,
        reasonCodes=job.reasonCodes,
    )


def _summarize_command(command: list[str]) -> CommandSummary | None:
    if not command:
        return None
    subcommand = next((item for item in command if item in {"run-batch", "run-once"}), None)
    return CommandSummary(
        executable=Path(command[0]).name,
        subcommand=subcommand,
        options=[item for item in command if item.startswith("--")],
    )


def _duration_ms(records: list[dict[str, Any]]) -> int | None:
    timestamps = [
        _parse_iso_timestamp(_string(record.get("timestamp")))
        for record in records
        if record.get("timestamp")
    ]
    timestamps = [timestamp for timestamp in timestamps if timestamp is not None]
    if len(timestamps) < 2:
        return None
    return int((max(timestamps) - min(timestamps)) * 1000)


def _parse_iso_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _reason_codes_for_records(
    records: list[dict[str, Any]],
    failure_category: str | None,
) -> list[str]:
    values: list[str] = []
    if failure_category:
        values.append(failure_category.upper())
    for record in records:
        values.extend(
            [
                _nested(record, "finalDecision", "reason"),
                _nested(record, "startChat", "reason"),
                _nested(record, "sendGreeting", "reason"),
                _nested(record, "nextJob", "reason"),
                _nested(record, "delivery", "reason"),
                _nested(record, "delivery", "textSkippedReason"),
                record.get("messageSkipReason"),
            ]
        )
    return _dedupe(
        code
        for code in (_safe_reason_code(value) for value in values)
        if code
    )


def _safe_reason_code(value: Any) -> str | None:
    text = _string(value)
    if not text:
        return None
    lowered = text.lower()
    if "canary" in lowered or _looks_like_local_path(text):
        return "SENSITIVE_REASON_REDACTED"
    uppercase_code = re.search(r"\b[A-Z][A-Z0-9_]{2,}\b", text)
    if uppercase_code and _is_safe_reason_code(uppercase_code.group(0)):
        return uppercase_code.group(0)[:80]
    known_phrases = [
        ("llm decision", "LLM_DECISION"),
        ("final decision", "FINAL_DECISION"),
        ("duplicate", "DUPLICATE_JOB"),
        ("matched", "MATCHED"),
        ("missing", "MISSING_REQUIRED_DATA"),
        ("no safe", "NO_SAFE_VALUE"),
        ("not apply", "NOT_APPLY"),
    ]
    for needle, code in known_phrases:
        if needle in lowered:
            return code
    return "REASON_RECORDED"


def _is_safe_reason_code(value: str) -> bool:
    prefixes = (
        "ADD_FRIEND_",
        "AUTHORIZED_",
        "BOSS_WEB_",
        "CANDIDATE_",
        "CHAT_",
        "CONTINUE_",
        "DAILY_",
        "DIALOG_",
        "GREETING_",
        "IMAGE_",
        "JOB_",
        "NEXT_",
        "NO_",
        "PAGE_",
        "START_",
    )
    return value.startswith(prefixes)


def _looks_like_local_path(value: str) -> bool:
    return bool(re.search(r"\b[A-Za-z]:[\\/]", value)) or "/" in value or "\\" in value


def _is_completed_job(records: list[dict[str, Any]]) -> bool:
    for record in reversed(records):
        if record.get("event") == "stage":
            continue
        if record.get("error") not in (None, ""):
            return False
        if record.get("runId"):
            return True
    return False


def _retry_decision(status: str, failure_category: str | None) -> str:
    if status == "completed":
        return "none"
    if failure_category in {"stdout_parse_error", "stdout_validation_error"}:
        return "stop_until_cli_contract_is_fixed"
    return "rerun_after_cli_revalidation"


def _looks_like_batch_id(run_id: str, batch_run_id: str | None) -> bool:
    return batch_run_id is not None and run_id == batch_run_id


def _nested(record: dict[str, Any], *keys: str) -> Any:
    value: Any = record
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _first_string(*values: Any) -> str | None:
    for value in values:
        string = _string(value)
        if string:
            return string
    return None


def _first_int(*values: Any) -> int | None:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def _string(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _dedupe(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output
