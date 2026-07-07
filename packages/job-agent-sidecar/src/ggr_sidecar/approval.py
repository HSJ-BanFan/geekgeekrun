from __future__ import annotations

import queue
import re
import sys
import threading
from collections.abc import Callable, Sequence
from typing import Any, TextIO

from .schemas import (
    ApprovalDecision,
    ApprovalRequest,
    ApprovalRequestMetadata,
    ApprovalTraceMetadata,
)

ApprovalRequester = Callable[[ApprovalRequest], ApprovalDecision | dict[str, Any]]


def build_confirmed_batch_approval_request(
    *,
    target_count: int,
    max_candidates: int | None,
    candidate_timeout_ms: int | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    llm: bool,
    headless: bool,
) -> ApprovalRequest:
    metadata = ApprovalRequestMetadata(
        targetCount=target_count,
        maxCandidates=max_candidates,
        candidateTimeoutMs=candidate_timeout_ms,
        recallKeywordCount=len(recall_keywords),
        cityCount=len(cities),
        llm=llm,
        headless=headless,
        commandOptions=_redacted_command_options(
            max_candidates=max_candidates,
            candidate_timeout_ms=candidate_timeout_ms,
            recall_keywords=recall_keywords,
            cities=cities,
            llm=llm,
            headless=headless,
        ),
    )
    return ApprovalRequest(
        prompt=_format_confirmed_batch_prompt(metadata),
        metadata=metadata,
    )


def normalize_approval_decision(value: ApprovalDecision | dict[str, Any]) -> ApprovalDecision:
    return value if isinstance(value, ApprovalDecision) else ApprovalDecision.model_validate(value)


def approval_trace_from_decision(
    *,
    request: ApprovalRequest,
    decision: ApprovalDecision,
    requested: bool = True,
) -> ApprovalTraceMetadata:
    return ApprovalTraceMetadata(
        requested=requested,
        outcome=decision.outcome,
        approved=decision.outcome == "approved",
        reasonCode=_safe_reason_code(decision.reasonCode, decision.outcome),
        request=request.metadata,
    )


def missing_approval_trace(request: ApprovalRequest) -> ApprovalTraceMetadata:
    return ApprovalTraceMetadata(
        requested=False,
        outcome="missing",
        approved=False,
        reasonCode="APPROVAL_REQUESTER_MISSING",
        request=request.metadata,
    )


def make_terminal_approval_requester(
    *,
    timeout_ms: int,
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
) -> ApprovalRequester:
    def requester(request: ApprovalRequest) -> ApprovalDecision:
        return request_terminal_approval(
            request,
            timeout_ms=timeout_ms,
            input_stream=input_stream,
            output_stream=output_stream,
        )

    return requester


def request_terminal_approval(
    request: ApprovalRequest,
    *,
    timeout_ms: int,
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
) -> ApprovalDecision:
    stdin = input_stream or sys.stdin
    stderr = output_stream or sys.stderr
    stderr.write(request.prompt)
    stderr.write("\nType APPROVE to continue, or anything else to stop.\n> ")
    stderr.flush()

    responses: queue.Queue[str | BaseException] = queue.Queue(maxsize=1)

    def read_response() -> None:
        try:
            responses.put(stdin.readline())
        except BaseException as err:  # pragma: no cover - defensive terminal path
            responses.put(err)

    reader = threading.Thread(target=read_response, daemon=True)
    reader.start()

    try:
        response = responses.get(timeout=timeout_ms / 1000)
    except queue.Empty:
        stderr.write("\nApproval timed out; no confirmed CLI command was invoked.\n")
        stderr.flush()
        return ApprovalDecision(outcome="timeout", reasonCode="APPROVAL_TIMEOUT")
    except KeyboardInterrupt:
        stderr.write("\nApproval cancelled; no confirmed CLI command was invoked.\n")
        stderr.flush()
        return ApprovalDecision(outcome="cancelled", reasonCode="APPROVAL_CANCELLED")

    if isinstance(response, BaseException):
        return ApprovalDecision(outcome="cancelled", reasonCode="APPROVAL_CANCELLED")

    if response == "":
        return ApprovalDecision(outcome="missing", reasonCode="APPROVAL_INPUT_MISSING")

    if response.strip() == "APPROVE":
        return ApprovalDecision(outcome="approved", reasonCode="HUMAN_APPROVED")

    return ApprovalDecision(outcome="denied", reasonCode="HUMAN_DENIED")


def _format_confirmed_batch_prompt(metadata: ApprovalRequestMetadata) -> str:
    lines = [
        "Approve supervised confirmed run-batch?",
        "This permits the sidecar to invoke the CLI with --confirm.",
        f"targetCount: {metadata.targetCount}",
        f"maxCandidates: {_display_optional_int(metadata.maxCandidates)}",
        f"candidateTimeoutMs: {_display_optional_int(metadata.candidateTimeoutMs)}",
        f"recallKeywordCount: {metadata.recallKeywordCount}",
        f"cityCount: {metadata.cityCount}",
        f"llm: {_display_bool(metadata.llm)}",
        f"headless: {_display_bool(metadata.headless)}",
        "Sensitive originals are redacted from this prompt.",
    ]
    return "\n".join(lines)


def _redacted_command_options(
    *,
    max_candidates: int | None,
    candidate_timeout_ms: int | None,
    recall_keywords: Sequence[str],
    cities: Sequence[str],
    llm: bool,
    headless: bool,
) -> list[str]:
    options = ["--from-browser", "--confirm", "--target-count"]
    if max_candidates is not None:
        options.append("--max-candidates")
    if candidate_timeout_ms is not None:
        options.append("--candidate-timeout-ms")
    if recall_keywords:
        options.append("--recall-keyword")
    if cities:
        options.append("--city")
    if llm:
        options.append("--llm")
    if headless:
        options.append("--headless")
    return options


def _display_optional_int(value: int | None) -> str:
    return "default" if value is None else str(value)


def _display_bool(value: bool) -> str:
    return "true" if value else "false"


def _safe_reason_code(value: str | None, outcome: str) -> str:
    if value:
        normalized = value.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9_]{2,80}", normalized):
            return normalized
    return {
        "approved": "HUMAN_APPROVED",
        "denied": "HUMAN_DENIED",
        "timeout": "APPROVAL_TIMEOUT",
        "cancelled": "APPROVAL_CANCELLED",
        "missing": "APPROVAL_MISSING",
    }.get(outcome, "APPROVAL_RECORDED")
