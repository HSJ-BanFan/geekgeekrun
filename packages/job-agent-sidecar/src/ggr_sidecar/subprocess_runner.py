from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .approval import (
    ApprovalRequester,
    approval_trace_from_decision,
    build_confirmed_batch_approval_request,
    missing_approval_trace,
    normalize_approval_decision,
)
from .schemas import ApprovalTraceMetadata, CliToolResult, RunBatchOutput, ValidationFailure

CompletedRunner = Callable[..., subprocess.CompletedProcess[str]]


def run_dry_run_batch(
    *,
    repo_root: Path | str | None = None,
    node: str = "node",
    timeout_ms: int = 300_000,
    target_count: int = 1,
    max_candidates: int | None = None,
    candidate_timeout_ms: int | None = None,
    progress_file: Path | str | None = None,
    audit_file: Path | str | None = None,
    recall_keywords: Sequence[str] | None = None,
    cities: Sequence[str] | None = None,
    llm: bool = False,
    headless: bool = False,
    runner: CompletedRunner = subprocess.run,
) -> CliToolResult:
    root = Path(repo_root) if repo_root is not None else _default_repo_root()
    command = build_dry_run_batch_command(
        repo_root=root,
        node=node,
        target_count=target_count,
        max_candidates=max_candidates,
        candidate_timeout_ms=candidate_timeout_ms,
        progress_file=progress_file,
        audit_file=audit_file,
        recall_keywords=recall_keywords or [],
        cities=cities or [],
        llm=llm,
        headless=headless,
    )
    return run_cli_json_tool(
        command=command,
        cwd=root,
        timeout_ms=timeout_ms,
        expected_dry_run=True,
        runner=runner,
    )


def run_confirmed_batch(
    *,
    repo_root: Path | str | None = None,
    node: str = "node",
    timeout_ms: int = 300_000,
    target_count: int = 1,
    max_candidates: int | None = None,
    candidate_timeout_ms: int | None = None,
    progress_file: Path | str | None = None,
    audit_file: Path | str | None = None,
    recall_keywords: Sequence[str] | None = None,
    cities: Sequence[str] | None = None,
    llm: bool = False,
    headless: bool = False,
    approval_requester: ApprovalRequester | None = None,
    runner: CompletedRunner = subprocess.run,
) -> CliToolResult:
    root = Path(repo_root) if repo_root is not None else _default_repo_root()
    normalized_keywords = recall_keywords or []
    normalized_cities = cities or []
    approval_request = build_confirmed_batch_approval_request(
        target_count=target_count,
        max_candidates=max_candidates,
        candidate_timeout_ms=candidate_timeout_ms,
        recall_keywords=normalized_keywords,
        cities=normalized_cities,
        llm=llm,
        headless=headless,
    )
    if approval_requester is None:
        return _approval_stop_result(
            approval=missing_approval_trace(approval_request),
        )

    decision = normalize_approval_decision(approval_requester(approval_request))
    approval = approval_trace_from_decision(
        request=approval_request,
        decision=decision,
    )
    if decision.outcome != "approved":
        return _approval_stop_result(
            approval=approval,
        )

    command = build_confirmed_batch_command(
        repo_root=root,
        node=node,
        target_count=target_count,
        max_candidates=max_candidates,
        candidate_timeout_ms=candidate_timeout_ms,
        progress_file=progress_file,
        audit_file=audit_file,
        recall_keywords=normalized_keywords,
        cities=normalized_cities,
        llm=llm,
        headless=headless,
    )
    result = run_cli_json_tool(
        command=command,
        cwd=root,
        timeout_ms=timeout_ms,
        expected_dry_run=False,
        approval=approval,
        runner=runner,
    )
    return result


def build_dry_run_batch_command(
    *,
    repo_root: Path,
    node: str,
    target_count: int,
    max_candidates: int | None,
    candidate_timeout_ms: int | None,
    progress_file: Path | str | None,
    audit_file: Path | str | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    llm: bool,
    headless: bool,
) -> list[str]:
    return build_run_batch_command(
        repo_root=repo_root,
        node=node,
        target_count=target_count,
        max_candidates=max_candidates,
        candidate_timeout_ms=candidate_timeout_ms,
        progress_file=progress_file,
        audit_file=audit_file,
        recall_keywords=recall_keywords,
        cities=cities,
        llm=llm,
        headless=headless,
        confirm=False,
    )


def build_confirmed_batch_command(
    *,
    repo_root: Path,
    node: str,
    target_count: int,
    max_candidates: int | None,
    candidate_timeout_ms: int | None,
    progress_file: Path | str | None,
    audit_file: Path | str | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    llm: bool,
    headless: bool,
) -> list[str]:
    return build_run_batch_command(
        repo_root=repo_root,
        node=node,
        target_count=target_count,
        max_candidates=max_candidates,
        candidate_timeout_ms=candidate_timeout_ms,
        progress_file=progress_file,
        audit_file=audit_file,
        recall_keywords=recall_keywords,
        cities=cities,
        llm=llm,
        headless=headless,
        confirm=True,
    )


def build_run_batch_command(
    *,
    repo_root: Path,
    node: str,
    target_count: int,
    max_candidates: int | None,
    candidate_timeout_ms: int | None,
    progress_file: Path | str | None,
    audit_file: Path | str | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    llm: bool,
    headless: bool,
    confirm: bool,
) -> list[str]:
    cli_path = repo_root / "packages" / "job-agent-cli" / "bin" / "ggr.mjs"
    command = [
        node,
        str(cli_path),
        "run-batch",
        "--from-browser",
        "--target-count",
        str(target_count),
    ]
    if confirm:
        command.append("--confirm")
    if max_candidates is not None:
        command.extend(["--max-candidates", str(max_candidates)])
    if candidate_timeout_ms is not None:
        command.extend(["--candidate-timeout-ms", str(candidate_timeout_ms)])
    if progress_file is not None:
        command.extend(["--progress-file", str(progress_file)])
    if audit_file is not None:
        command.extend(["--audit-file", str(audit_file)])
    for keyword in recall_keywords:
        command.extend(["--recall-keyword", keyword])
    for city in cities:
        command.extend(["--city", city])
    if llm:
        command.append("--llm")
    if headless:
        command.append("--headless")
    return command


def run_cli_json_tool(
    *,
    command: list[str],
    cwd: Path,
    timeout_ms: int,
    expected_dry_run: bool | None = None,
    approval: ApprovalTraceMetadata | None = None,
    runner: CompletedRunner = subprocess.run,
) -> CliToolResult:
    try:
        completed = runner(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
        )
    except subprocess.TimeoutExpired as err:
        return CliToolResult(
            ok=False,
            status="timeout",
            command=command,
            timedOut=True,
            timeoutMs=timeout_ms,
            stdout=_decode_timeout_text(err.stdout),
            stderr=_decode_timeout_text(err.stderr),
            approval=approval,
        )

    if completed.returncode != 0:
        return CliToolResult(
            ok=False,
            status="exit_error",
            command=command,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            approval=approval,
        )

    try:
        parsed: Any = json.loads(completed.stdout)
    except json.JSONDecodeError as err:
        return CliToolResult(
            ok=False,
            status="parse_error",
            command=command,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            parseError=str(err),
            approval=approval,
        )

    try:
        output = RunBatchOutput.model_validate(parsed)
    except ValidationError as err:
        return CliToolResult(
            ok=False,
            status="validation_error",
            command=command,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            validationErrors=[
                ValidationFailure.model_validate(error)
                for error in err.errors(include_url=False)
            ],
            approval=approval,
        )

    if expected_dry_run is not None and output.dryRun is not expected_dry_run:
        return CliToolResult(
            ok=False,
            status="validation_error",
            command=command,
            exitCode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            validationErrors=[
                ValidationFailure(
                    loc=["dryRun"],
                    msg=f"Input should be {expected_dry_run}",
                    type="literal_error",
                )
            ],
            approval=approval,
        )

    return CliToolResult(
        ok=True,
        status="ok",
        command=command,
        exitCode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        output=output,
        approval=approval,
    )


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _decode_timeout_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _approval_stop_result(
    *,
    approval: ApprovalTraceMetadata,
) -> CliToolResult:
    status = {
        "denied": "approval_denied",
        "timeout": "approval_timeout",
        "cancelled": "approval_cancelled",
        "missing": "approval_missing",
    }.get(approval.outcome)
    if status is None:
        status = "approval_missing"
    return CliToolResult(
        ok=False,
        status=status,
        command=[],
        approval=approval,
    )
