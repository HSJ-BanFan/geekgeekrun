from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class FlexibleCliModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class FinalDecision(FlexibleCliModel):
    decision: str | None = None
    source: str | None = None
    reason: str | None = None


class BatchJob(FlexibleCliModel):
    jobId: str | None = None
    title: str | None = None
    company: str | None = None
    city: str | None = None
    salary: str | None = None
    experience: str | None = None
    degree: str | None = None
    recallKeyword: str | None = None
    bossName: str | None = None
    bossTitle: str | None = None


class ActionSummary(FlexibleCliModel):
    dryRun: bool | None = None
    skipped: bool | None = None
    success: bool | None = None
    clicked: bool | None = None
    moved: bool | None = None
    textSent: bool | None = None
    imageUploaded: bool | None = None
    reason: str | None = None
    textSkippedReason: str | None = None


class DeliverySummary(FlexibleCliModel):
    successful: bool | None = None
    textSent: bool | None = None
    imageUploaded: bool | None = None
    textSkippedReason: str | None = None
    reason: str | None = None


ApprovalOutcome = Literal["approved", "denied", "timeout", "cancelled", "missing"]


class ApprovalRequestMetadata(FlexibleCliModel):
    command: Literal["run-batch", "single-job-loop", "bounded-tokened-batch"] = "run-batch"
    mode: Literal["confirmed"] = "confirmed"
    realActions: bool = True
    confirmRequired: bool = True
    targetCount: int
    maxCandidates: int | None = None
    candidateTimeoutMs: int | None = None
    recallKeywordCount: int = 0
    cityCount: int = 0
    llm: bool = False
    headless: bool = False
    commandOptions: list[str] = Field(default_factory=list)
    redactedFields: list[str] = Field(
        default_factory=lambda: [
            "job_description",
            "greeting",
            "resume",
            "local_paths",
            "cookies",
            "local_storage",
            "api_keys",
        ]
    )


class ApprovalRequest(FlexibleCliModel):
    kind: Literal[
        "confirmed_batch",
        "confirmed_single_job_loop",
        "confirmed_bounded_tokened_batch",
    ] = "confirmed_batch"
    prompt: str
    metadata: ApprovalRequestMetadata


class ApprovalDecision(FlexibleCliModel):
    outcome: ApprovalOutcome
    reasonCode: str | None = None


class ApprovalTraceMetadata(FlexibleCliModel):
    requested: bool
    outcome: ApprovalOutcome
    approved: bool = False
    reasonCode: str | None = None
    request: ApprovalRequestMetadata | None = None


class BatchResult(FlexibleCliModel):
    batchRunId: str
    runId: str
    candidateIndex: int
    query: str | None = None
    city: str | None = None
    job: BatchJob | None = None
    finalDecision: FinalDecision | None = None
    startChat: ActionSummary | None = None
    sendGreeting: ActionSummary | None = None
    nextJob: ActionSummary | None = None
    delivery: DeliverySummary | None = None
    sentCount: int
    targetCount: int
    auditFile: str | None = None
    error: str | None = None


class CliError(FlexibleCliModel):
    message: str | None = None
    stack: str | None = None


class RunBatchOutput(FlexibleCliModel):
    ok: bool
    command: Literal["run-batch"]
    runId: str
    dryRun: bool
    targetCount: int
    sentCount: int
    examinedCount: int
    maxCandidates: int
    candidateTimeoutMs: int
    browserOpenCount: int
    queryCount: int
    cityCodes: list[str]
    queries: list[str]
    progressFile: str | None = None
    results: list[BatchResult]
    errors: list[CliError | dict[str, Any]] = Field(default_factory=list)


class ValidationFailure(FlexibleCliModel):
    loc: list[str | int]
    msg: str
    type: str


class CliToolResult(FlexibleCliModel):
    ok: bool
    status: Literal[
        "ok",
        "exit_error",
        "timeout",
        "parse_error",
        "validation_error",
        "approval_denied",
        "approval_timeout",
        "approval_cancelled",
        "approval_missing",
    ]
    command: list[str]
    exitCode: int | None = None
    timedOut: bool = False
    timeoutMs: int | None = None
    stderr: str = ""
    stdout: str = ""
    output: RunBatchOutput | None = None
    parseError: str | None = None
    validationErrors: list[ValidationFailure] | None = None
    approval: ApprovalTraceMetadata | None = None
