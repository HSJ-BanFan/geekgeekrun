from __future__ import annotations

import json
import subprocess
import tempfile
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .approval import (
    ApprovalRequester,
    approval_trace_from_decision,
    build_confirmed_single_job_loop_approval_request,
    missing_approval_trace,
    normalize_approval_decision,
)
from .schemas import ApprovalTraceMetadata, FlexibleCliModel, ValidationFailure
from .subprocess_runner import CompletedRunner


class ExtractJobOutput(FlexibleCliModel):
    ok: bool
    command: Literal["extract-job"]
    source: str
    profile: dict[str, Any]


class EvaluateJobOutput(FlexibleCliModel):
    ok: bool
    command: Literal["evaluate-job"]
    profile: dict[str, Any]
    candidateProfile: dict[str, Any] | None = None
    ruleEvaluation: dict[str, Any]
    llmEvaluation: dict[str, Any] | None = None
    finalDecision: dict[str, Any]


class AuthorizationTokenRecord(FlexibleCliModel):
    tokenId: str
    runId: str
    jobId: str
    allowedActions: list[str] = Field(default_factory=list)
    expiresAt: str | None = None
    consumption: dict[str, Any] | None = None
    decisionEvidence: dict[str, Any] | None = None


class AuthorizationTokenIssueOutput(FlexibleCliModel):
    ok: bool
    command: Literal["authorization-token"]
    action: Literal["issue"]
    issued: bool
    token: AuthorizationTokenRecord | None = None
    tokenFile: str | None = None
    reasonCode: str | None = None
    reason: str | None = None


class AuthorizationTokenInspectOutput(FlexibleCliModel):
    ok: bool
    command: Literal["authorization-token"]
    action: Literal["inspect"]
    status: str
    reasonCode: str | None = None
    inspectedAt: str | None = None
    token: AuthorizationTokenRecord | None = None
    tokenFile: str | None = None


class AuthorizedActionOutput(FlexibleCliModel):
    ok: bool
    command: Literal["authorized-action"]
    action: str | None = None
    runId: str | None = None
    dryRun: bool
    reasonCode: str | None = None
    reason: str | None = None
    validation: dict[str, Any] | None = None
    authorizedJob: dict[str, Any] | None = None
    plannedAction: dict[str, Any] | None = None
    actionResult: dict[str, Any] | None = None
    auditResult: dict[str, Any] | None = None


class FineGrainedCliToolResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    ok: bool
    status: Literal[
        "ok",
        "cli_error",
        "exit_error",
        "timeout",
        "parse_error",
        "validation_error",
    ]
    command: list[str]
    toolName: str
    exitCode: int | None = None
    timedOut: bool = False
    timeoutMs: int | None = None
    stderr: str = ""
    stdout: str = ""
    output: Any = None
    parseError: str | None = None
    validationErrors: list[ValidationFailure] | None = None


class ToolCommandSummary(FlexibleCliModel):
    executable: str | None = None
    subcommand: str | None = None
    options: list[str] = Field(default_factory=list)


class FineGrainedToolTrace(FlexibleCliModel):
    toolName: str
    status: str
    command: ToolCommandSummary | None = None
    runId: str | None = None
    jobId: str | None = None
    action: str | None = None
    reasonCode: str | None = None
    auditRecordCount: int = 0
    failureCategory: str | None = None


class ApplicationLoopTrace(FlexibleCliModel):
    toolName: Literal["single-job-loop"] = "single-job-loop"
    status: str
    dryRun: bool
    approval: ApprovalTraceMetadata | None = None
    toolCalls: list[FineGrainedToolTrace] = Field(default_factory=list)
    currentToolName: str | None = None
    currentRunId: str | None = None
    currentJobId: str | None = None
    failureCategory: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    stopDecision: str = "stop_without_continuing_actions"


class RecoveryStopLocation(FlexibleCliModel):
    toolName: str | None = None
    runId: str | None = None
    jobId: str | None = None
    action: str | None = None
    reasonCode: str | None = None


class ApplicationLoopRecovery(FlexibleCliModel):
    recommendation: str
    safeOptions: list[str] = Field(default_factory=list)
    canAutomaticallyContinueRealActions: bool = False
    stoppedAt: RecoveryStopLocation | None = None
    failureCategory: str | None = None
    reasonCodes: list[str] = Field(default_factory=list)
    explanation: str


class ApplicationLoopResult(FlexibleCliModel):
    ok: bool
    status: Literal[
        "completed",
        "failed",
        "stopped",
        "approval_denied",
        "approval_timeout",
        "approval_cancelled",
        "approval_missing",
    ]
    dryRun: bool
    runId: str | None = None
    jobId: str | None = None
    action: FineGrainedCliToolResult | None = None
    approval: ApprovalTraceMetadata | None = None
    trace: ApplicationLoopTrace
    recovery: ApplicationLoopRecovery
    failureCategory: str | None = None


OutputT = TypeVar("OutputT", bound=BaseModel)
def run_single_job_application_loop(
    *,
    repo_root: Path | str | None = None,
    node: str = "node",
    timeout_ms: int = 300_000,
    job_file: Path | str | None = None,
    from_browser: bool = False,
    run_id: str | None = None,
    token_file: Path | str | None = None,
    audit_file: Path | str | None = None,
    recall_keywords: Sequence[str] | None = None,
    cities: Sequence[str] | None = None,
    llm: bool = False,
    confirm: bool = False,
    headless: bool = False,
    now: str | None = None,
    approval_requester: ApprovalRequester | None = None,
    runner: CompletedRunner = subprocess.run,
) -> ApplicationLoopResult:
    root = Path(repo_root) if repo_root is not None else _default_repo_root()
    cli_path = root / "packages" / "job-agent-cli" / "bin" / "ggr.mjs"
    normalized_run_id = run_id or f"sidecar-{uuid.uuid4().hex[:12]}"
    normalized_keywords = list(recall_keywords or [])
    normalized_cities = list(cities or [])
    approval = _approval_for_single_job_loop(
        confirm=confirm,
        source="job-file" if job_file else "browser",
        llm=llm,
        headless=headless,
        approval_requester=approval_requester,
    )
    if confirm and (approval is None or not approval.approved):
        return _build_loop_result(
            ok=False,
            status=_approval_status(approval),
            dry_run=False,
            approval=approval,
            tool_calls=[],
            failure_category=None,
        )

    tool_calls: list[FineGrainedToolTrace] = []

    def record(result: FineGrainedCliToolResult) -> None:
        tool_calls.append(_trace_from_tool_result(result, audit_file=audit_file))

    with tempfile.TemporaryDirectory(prefix="ggr-sidecar-loop-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        extracted_job_file = temp_dir / "job.json"
        final_decision_file = temp_dir / "final-decision.json"
        rule_evaluation_file = temp_dir / "rule-evaluation.json"
        llm_evaluation_file = temp_dir / "llm-evaluation.json"

        extract_command = _extract_job_command(
            node=node,
            cli_path=cli_path,
            job_file=job_file,
            from_browser=from_browser or job_file is None,
            recall_keywords=normalized_keywords,
            cities=normalized_cities,
            headless=headless,
        )
        extract = _run_json_cli_tool(
            tool_name="extract-job",
            command=extract_command,
            cwd=root,
            timeout_ms=timeout_ms,
            output_model=ExtractJobOutput,
            runner=runner,
        )
        record(extract)
        if not extract.ok:
            return _stop_after_failure(
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                failed_tool=extract,
            )

        _write_json(extracted_job_file, extract.output.profile)

        evaluate = _run_json_cli_tool(
            tool_name="evaluate-job",
            command=_evaluate_job_command(
                node=node,
                cli_path=cli_path,
                job_file=extracted_job_file,
                llm=llm,
            ),
            cwd=root,
            timeout_ms=timeout_ms,
            output_model=EvaluateJobOutput,
            runner=runner,
        )
        record(evaluate)
        if not evaluate.ok:
            return _stop_after_failure(
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                failed_tool=evaluate,
            )

        _write_json(final_decision_file, evaluate.output.finalDecision)
        _write_json(rule_evaluation_file, evaluate.output.ruleEvaluation)
        if evaluate.output.llmEvaluation is not None:
            _write_json(llm_evaluation_file, evaluate.output.llmEvaluation)

        issue = _run_json_cli_tool(
            tool_name="authorization-token:issue",
            command=_issue_token_command(
                node=node,
                cli_path=cli_path,
                token_file=token_file,
                run_id=normalized_run_id,
                job_file=extracted_job_file,
                final_decision_file=final_decision_file,
                rule_evaluation_file=rule_evaluation_file,
                llm_evaluation_file=(
                    llm_evaluation_file if evaluate.output.llmEvaluation is not None else None
                ),
                now=now,
            ),
            cwd=root,
            timeout_ms=timeout_ms,
            output_model=AuthorizationTokenIssueOutput,
            runner=runner,
        )
        record(issue)
        if not issue.ok:
            return _stop_after_failure(
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                failed_tool=issue,
            )
        if not issue.output.issued or issue.output.token is None:
            return _build_loop_result(
                ok=False,
                status="stopped",
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                run_id=normalized_run_id,
                job_id=_job_id_from_profile(evaluate.output.profile),
                failure_category="authorization_not_issued",
            )

        token_id = issue.output.token.tokenId
        inspect = _run_json_cli_tool(
            tool_name="authorization-token:inspect",
            command=_inspect_token_command(
                node=node,
                cli_path=cli_path,
                token_file=token_file,
                token_id=token_id,
                now=now,
            ),
            cwd=root,
            timeout_ms=timeout_ms,
            output_model=AuthorizationTokenInspectOutput,
            runner=runner,
        )
        record(inspect)
        if not inspect.ok:
            return _stop_after_failure(
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                failed_tool=inspect,
            )
        if inspect.output.status != "valid":
            return _build_loop_result(
                ok=False,
                status="stopped",
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                run_id=issue.output.token.runId,
                job_id=issue.output.token.jobId,
                failure_category="authorization_rejected",
            )

        action = _run_json_cli_tool(
            tool_name="authorized-action:start_chat",
            command=_authorized_action_command(
                node=node,
                cli_path=cli_path,
                token_file=token_file,
                audit_file=audit_file,
                token_id=token_id,
                confirm=confirm,
                headless=headless,
                now=now,
                recall_keywords=normalized_keywords,
                cities=normalized_cities,
            ),
            cwd=root,
            timeout_ms=timeout_ms,
            output_model=AuthorizedActionOutput,
            runner=runner,
        )
        record(action)
        if not action.ok:
            return _stop_after_failure(
                dry_run=not confirm,
                approval=approval,
                tool_calls=tool_calls,
                failed_tool=action,
                action=action,
            )

        return _build_loop_result(
            ok=True,
            status="completed",
            dry_run=not confirm,
            approval=approval,
            tool_calls=tool_calls,
            run_id=action.output.runId or issue.output.token.runId,
            job_id=_job_id_from_action(action.output) or issue.output.token.jobId,
            action=action,
        )


def _run_json_cli_tool(
    *,
    tool_name: str,
    command: list[str],
    cwd: Path,
    timeout_ms: int,
    output_model: type[OutputT],
    runner: CompletedRunner,
) -> FineGrainedCliToolResult:
    try:
        completed = runner(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
        )
    except subprocess.TimeoutExpired as err:
        return FineGrainedCliToolResult(
            ok=False,
            status="timeout",
            command=command,
            toolName=tool_name,
            timedOut=True,
            timeoutMs=timeout_ms,
            stdout=_decode_timeout_text(err.stdout),
            stderr=_decode_timeout_text(err.stderr),
        )

    if completed.returncode != 0:
        return FineGrainedCliToolResult(
            ok=False,
            status="exit_error",
            command=command,
            toolName=tool_name,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError as err:
        return FineGrainedCliToolResult(
            ok=False,
            status="parse_error",
            command=command,
            toolName=tool_name,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            parseError=str(err),
        )

    try:
        output = output_model.model_validate(parsed)
    except ValidationError as err:
        return FineGrainedCliToolResult(
            ok=False,
            status="validation_error",
            command=command,
            toolName=tool_name,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            validationErrors=[
                ValidationFailure.model_validate(error)
                for error in err.errors(include_url=False)
            ],
        )

    return FineGrainedCliToolResult(
        ok=bool(output.ok),
        status="ok" if output.ok else "cli_error",
        command=command,
        toolName=tool_name,
        exitCode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        output=output,
    )


def _approval_for_single_job_loop(
    *,
    confirm: bool,
    source: str,
    llm: bool,
    headless: bool,
    approval_requester: ApprovalRequester | None,
) -> ApprovalTraceMetadata | None:
    if not confirm:
        return None
    request = build_confirmed_single_job_loop_approval_request(
        source=source,
        llm=llm,
        headless=headless,
    )
    if approval_requester is None:
        return missing_approval_trace(request)
    decision = normalize_approval_decision(approval_requester(request))
    return approval_trace_from_decision(request=request, decision=decision)


def _extract_job_command(
    *,
    node: str,
    cli_path: Path,
    job_file: Path | str | None,
    from_browser: bool,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    headless: bool,
) -> list[str]:
    command = [node, str(cli_path), "extract-job"]
    if from_browser:
        command.append("--from-browser")
        if recall_keywords:
            command.extend(["--recall-keyword", recall_keywords[0]])
        if cities:
            command.extend(["--city", cities[0]])
        if headless:
            command.append("--headless")
    elif job_file is not None:
        command.extend(["--job", str(job_file)])
    return command


def _evaluate_job_command(
    *,
    node: str,
    cli_path: Path,
    job_file: Path,
    llm: bool,
) -> list[str]:
    command = [node, str(cli_path), "evaluate-job", "--job", str(job_file)]
    if llm:
        command.append("--llm")
    return command


def _issue_token_command(
    *,
    node: str,
    cli_path: Path,
    token_file: Path | str | None,
    run_id: str,
    job_file: Path,
    final_decision_file: Path,
    rule_evaluation_file: Path,
    llm_evaluation_file: Path | None,
    now: str | None,
) -> list[str]:
    command = [
        node,
        str(cli_path),
        "authorization-token",
        "issue",
        "--run-id",
        run_id,
        "--job",
        str(job_file),
        "--final-decision",
        str(final_decision_file),
        "--evaluation",
        str(rule_evaluation_file),
        "--allowed-action",
        "start_chat",
    ]
    if llm_evaluation_file is not None:
        command.extend(["--llm-evaluation", str(llm_evaluation_file)])
    if token_file is not None:
        command.extend(["--token-file", str(token_file)])
    if now is not None:
        command.extend(["--now", now])
    return command


def _inspect_token_command(
    *,
    node: str,
    cli_path: Path,
    token_file: Path | str | None,
    token_id: str,
    now: str | None,
) -> list[str]:
    command = [
        node,
        str(cli_path),
        "authorization-token",
        "inspect",
        "--token-id",
        token_id,
        "--action",
        "start_chat",
    ]
    if token_file is not None:
        command.extend(["--token-file", str(token_file)])
    if now is not None:
        command.extend(["--now", now])
    return command


def _authorized_action_command(
    *,
    node: str,
    cli_path: Path,
    token_file: Path | str | None,
    audit_file: Path | str | None,
    token_id: str,
    confirm: bool,
    headless: bool,
    now: str | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
) -> list[str]:
    command = [
        node,
        str(cli_path),
        "authorized-action",
        "--action",
        "start_chat",
        "--token-id",
        token_id,
    ]
    if token_file is not None:
        command.extend(["--token-file", str(token_file)])
    if audit_file is not None:
        command.extend(["--audit-file", str(audit_file)])
    if confirm:
        command.append("--confirm")
    if headless:
        command.append("--headless")
    if now is not None:
        command.extend(["--now", now])
    if recall_keywords:
        command.extend(["--recall-keyword", recall_keywords[0]])
    if cities:
        command.extend(["--city", cities[0]])
    return command


def _stop_after_failure(
    *,
    dry_run: bool,
    approval: ApprovalTraceMetadata | None,
    tool_calls: list[FineGrainedToolTrace],
    failed_tool: FineGrainedCliToolResult,
    action: FineGrainedCliToolResult | None = None,
) -> ApplicationLoopResult:
    return _build_loop_result(
        ok=False,
        status="failed",
        dry_run=dry_run,
        approval=approval,
        tool_calls=tool_calls,
        failure_category=_failure_category(failed_tool),
        action=action,
    )


def _build_loop_result(
    *,
    ok: bool,
    status: str,
    dry_run: bool,
    approval: ApprovalTraceMetadata | None,
    tool_calls: list[FineGrainedToolTrace],
    run_id: str | None = None,
    job_id: str | None = None,
    failure_category: str | None = None,
    action: FineGrainedCliToolResult | None = None,
) -> ApplicationLoopResult:
    current = tool_calls[-1] if tool_calls else None
    reason_codes = _dedupe(
        call.reasonCode
        for call in tool_calls
        if call.reasonCode
    )
    if failure_category:
        reason_codes = _dedupe([*reason_codes, failure_category.upper()])
    trace = ApplicationLoopTrace(
        status=status,
        dryRun=dry_run,
        approval=approval,
        toolCalls=tool_calls,
        currentToolName=current.toolName if current else None,
        currentRunId=run_id or (current.runId if current else None),
        currentJobId=job_id or (current.jobId if current else None),
        failureCategory=failure_category,
        reasonCodes=reason_codes,
    )
    recovery = _build_recovery(trace)
    return ApplicationLoopResult(
        ok=ok,
        status=status,
        dryRun=dry_run,
        runId=run_id or trace.currentRunId,
        jobId=job_id or trace.currentJobId,
        action=_redact_tool_result_for_output(action) if action is not None else None,
        approval=approval,
        trace=trace,
        recovery=recovery,
        failureCategory=failure_category,
    )


def _build_recovery(trace: ApplicationLoopTrace) -> ApplicationLoopRecovery:
    stopped_at = (
        RecoveryStopLocation(
            toolName=trace.currentToolName,
            runId=trace.currentRunId,
            jobId=trace.currentJobId,
            action=trace.toolCalls[-1].action if trace.toolCalls else None,
            reasonCode=trace.reasonCodes[-1] if trace.reasonCodes else None,
        )
        if trace.currentToolName
        else None
    )
    if trace.status == "completed":
        recommendation = "safe_stop"
        safe_options = ["safe_stop"]
        explanation = "Single-job loop completed; no automatic continuation is needed."
    elif trace.status.startswith("approval_"):
        recommendation = "safe_stop"
        safe_options = ["safe_stop"]
        explanation = "Loop stopped before CLI invocation because sidecar approval was not granted."
    elif trace.failureCategory in {"stdout_parse_error", "stdout_validation_error"}:
        recommendation = "inspect_cli_contract"
        safe_options = ["stop_and_inspect_cli_stdout"]
        explanation = "CLI output could not be trusted; inspect stdout before rerunning."
    else:
        recommendation = "rerun_from_cli_after_review"
        safe_options = [
            "stop_and_inspect_audit",
            "rerun_dry_run_from_cli_after_revalidation",
        ]
        explanation = "Loop stopped safely; review token, audit, and CLI output before any new real action."
    return ApplicationLoopRecovery(
        recommendation=recommendation,
        safeOptions=safe_options,
        canAutomaticallyContinueRealActions=False,
        stoppedAt=stopped_at if trace.status != "completed" else None,
        failureCategory=trace.failureCategory,
        reasonCodes=trace.reasonCodes,
        explanation=explanation,
    )


def _trace_from_tool_result(
    result: FineGrainedCliToolResult,
    *,
    audit_file: Path | str | None,
) -> FineGrainedToolTrace:
    output = result.output
    run_id = _output_run_id(output)
    job_id = _output_job_id(output)
    return FineGrainedToolTrace(
        toolName=result.toolName,
        status=result.status,
        command=_summarize_command(result.command),
        runId=run_id,
        jobId=job_id,
        action=_output_action(output),
        reasonCode=_output_reason_code(output),
        auditRecordCount=_count_audit_records(audit_file, run_id),
        failureCategory=_failure_category(result),
    )


def _redact_tool_result_for_output(
    result: FineGrainedCliToolResult,
) -> FineGrainedCliToolResult:
    return result.model_copy(
        update={
            "command": _redacted_command_tokens(result.command),
            "stdout": "",
            "stderr": "",
        }
    )


def _redacted_command_tokens(command: list[str]) -> list[str]:
    if not command:
        return []
    redacted = [Path(command[0]).name]
    redacted.extend(
        item
        for item in command[1:]
        if item.startswith("--")
        or item
        in {
            "extract-job",
            "evaluate-job",
            "authorization-token",
            "issue",
            "inspect",
            "authorized-action",
        }
    )
    return redacted


def _summarize_command(command: list[str]) -> ToolCommandSummary | None:
    if not command:
        return None
    return ToolCommandSummary(
        executable=Path(command[0]).name,
        subcommand=next(
            (
                item
                for item in command
                if item
                in {
                    "extract-job",
                    "evaluate-job",
                    "authorization-token",
                    "authorized-action",
                }
            ),
            None,
        ),
        options=[item for item in command if item.startswith("--")],
    )


def _failure_category(result: FineGrainedCliToolResult) -> str | None:
    if result.status == "timeout":
        return "subprocess_timeout"
    if result.status == "exit_error":
        return "subprocess_exit_error"
    if result.status == "parse_error":
        return "stdout_parse_error"
    if result.status == "validation_error":
        return "stdout_validation_error"
    if result.status == "cli_error":
        return "cli_reported_error"
    return None


def _approval_status(approval: ApprovalTraceMetadata | None) -> str:
    if approval is None:
        return "approval_missing"
    return {
        "denied": "approval_denied",
        "timeout": "approval_timeout",
        "cancelled": "approval_cancelled",
        "missing": "approval_missing",
    }.get(approval.outcome, "approval_missing")


def _output_run_id(output: Any) -> str | None:
    if isinstance(output, AuthorizationTokenIssueOutput) and output.token:
        return output.token.runId
    if isinstance(output, AuthorizationTokenInspectOutput) and output.token:
        return output.token.runId
    if isinstance(output, AuthorizedActionOutput):
        return output.runId
    return None


def _output_job_id(output: Any) -> str | None:
    if isinstance(output, (ExtractJobOutput, EvaluateJobOutput)):
        return _job_id_from_profile(output.profile)
    if isinstance(output, AuthorizationTokenIssueOutput) and output.token:
        return output.token.jobId
    if isinstance(output, AuthorizationTokenInspectOutput) and output.token:
        return output.token.jobId
    if isinstance(output, AuthorizedActionOutput):
        return _job_id_from_action(output)
    return None


def _output_action(output: Any) -> str | None:
    if isinstance(output, (AuthorizationTokenIssueOutput, AuthorizationTokenInspectOutput)):
        return output.action
    if isinstance(output, AuthorizedActionOutput):
        return output.action
    return None


def _output_reason_code(output: Any) -> str | None:
    reason_code = getattr(output, "reasonCode", None)
    return str(reason_code) if reason_code else None


def _job_id_from_profile(profile: dict[str, Any] | None) -> str | None:
    value = profile.get("jobId") if isinstance(profile, dict) else None
    return str(value) if value else None


def _job_id_from_action(output: AuthorizedActionOutput) -> str | None:
    if isinstance(output.authorizedJob, dict) and output.authorizedJob.get("jobId"):
        return str(output.authorizedJob["jobId"])
    validation = output.validation if isinstance(output.validation, dict) else {}
    authorization = validation.get("authorization") if isinstance(validation, dict) else {}
    if isinstance(authorization, dict) and authorization.get("jobIdentityAnchor"):
        return str(authorization["jobIdentityAnchor"])
    return None


def _count_audit_records(audit_file: Path | str | None, run_id: str | None) -> int:
    if audit_file is None or run_id is None:
        return 0
    path = Path(audit_file)
    if not path.exists():
        return 0
    count = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and record.get("runId") == run_id:
            count += 1
    return count


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _decode_timeout_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _dedupe(values) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]
