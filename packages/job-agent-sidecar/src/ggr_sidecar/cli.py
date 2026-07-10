from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .application_loop import (
    run_bounded_tokened_application_batch,
    run_single_job_application_loop,
)
from .application_preferences import (
    build_preference_clarification_answer,
    build_preference_evidence_package_from_file,
    evaluate_application_preference_profile_staleness,
    generate_application_preference_profile_from_file,
    persist_preference_clarification_answer_to_file,
    propose_preference_clarification_question,
    review_recent_application_preferences,
)
from .approval import make_terminal_approval_requester
from .observability import build_observability_report
from .runtime import RuntimeDiscoveryError, build_version_report
from .schemas import CliToolResult
from .subprocess_runner import run_confirmed_batch, run_dry_run_batch


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ggr-sidecar",
        description="Supervise job batches through the existing Node CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "version",
        help="Report the sidecar distribution version and bundled feature set.",
    )

    dry_run_batch = subparsers.add_parser(
        "supervise-dry-run-batch",
        help="Invoke ggr run-batch without --confirm and validate its JSON stdout.",
    )
    _add_batch_arguments(dry_run_batch)

    confirmed_batch = subparsers.add_parser(
        "supervise-confirmed-batch",
        help="Request sidecar approval, then invoke ggr run-batch with --confirm.",
    )
    _add_batch_arguments(confirmed_batch)
    confirmed_batch.add_argument("--approval-timeout-ms", type=int, default=60_000)

    single_job_loop = subparsers.add_parser(
        "supervise-single-job-loop",
        help="Run one token-gated fine-grained application loop through CLI tools.",
    )
    _add_single_job_loop_arguments(single_job_loop)

    tokened_batch = subparsers.add_parser(
        "supervise-tokened-batch",
        help="Run a bounded batch through token-gated fine-grained CLI tools.",
    )
    _add_tokened_batch_arguments(tokened_batch)

    preference_review = subparsers.add_parser(
        "review-application-preferences",
        help="Review recent local application records and JD summaries before real actions.",
    )
    preference_review.add_argument("--db-path", type=Path)
    preference_review.add_argument("--limit", type=int, default=100)

    preference_evidence = subparsers.add_parser(
        "build-preference-evidence",
        help="Build a redacted Preference Evidence Package from recent applications with JD.",
    )
    preference_evidence.add_argument("--recent-applications", type=Path)
    preference_evidence.add_argument("--candidate-statement", type=Path)
    preference_evidence.add_argument("--capability-profile", type=Path)
    preference_evidence.add_argument("--target-jd-samples", type=Path)
    preference_evidence.add_argument("--clarification-answers", type=Path)
    preference_evidence.add_argument("--output", type=Path)
    preference_evidence.add_argument("--now")

    preference_profile = subparsers.add_parser(
        "generate-application-preference-profile",
        help="Generate and validate an Application Preference Profile artifact.",
    )
    preference_profile.add_argument("--evidence-package", type=Path, required=True)
    preference_profile.add_argument("--output", type=Path, required=True)
    preference_profile.add_argument(
        "--llm-response",
        type=Path,
        help="Read a pre-generated model JSON response from a file instead of calling the configured LLM.",
    )

    clarification_answer = subparsers.add_parser(
        "record-preference-clarification-answer",
        help="Persist one redacted Preference Clarification Answer artifact record.",
    )
    clarification_answer.add_argument("--output", type=Path, required=True)
    clarification_answer.add_argument("--answer-id", required=True)
    clarification_answer.add_argument("--question-text", required=True)
    clarification_answer.add_argument("--recommended-answer", required=True)
    clarification_answer.add_argument("--user-answer", required=True)
    clarification_answer.add_argument("--affected-field", action="append", default=[])
    clarification_answer.add_argument("--created-at")

    clarification_question = subparsers.add_parser(
        "clarify-application-preferences",
        help="Emit one targeted preference clarification question from profile uncertainty.",
    )
    clarification_question.add_argument("--profile", type=Path, required=True)
    clarification_question.add_argument("--evidence-package", type=Path)

    profile_freshness = subparsers.add_parser(
        "check-application-preference-profile-freshness",
        help="Check whether a profile is stale against a current evidence package.",
    )
    profile_freshness.add_argument("--profile", type=Path, required=True)
    profile_freshness.add_argument("--evidence-package", type=Path, required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except RuntimeDiscoveryError as error:
        _write_json_payload(
            {
                "ok": False,
                "command": _requested_command(argv),
                "status": "runtime_error",
                "reasonCode": error.reason_code,
                "error": str(error),
            }
        )
        return 1


def _main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "version":
        _write_json_payload(build_version_report())
        return 0

    if args.command == "supervise-dry-run-batch":
        result = run_dry_run_batch(
            repo_root=args.repo_root,
            node=args.node,
            timeout_ms=args.timeout_ms,
            target_count=args.target_count,
            max_candidates=args.max_candidates,
            candidate_timeout_ms=args.candidate_timeout_ms,
            progress_file=args.progress_file,
            audit_file=args.audit_file,
            recall_keywords=args.recall_keyword,
            cities=args.city,
            llm=args.llm,
            headless=args.headless,
        )
        return _write_result_with_observability(result, args)

    if args.command == "supervise-confirmed-batch":
        result = run_confirmed_batch(
            repo_root=args.repo_root,
            node=args.node,
            timeout_ms=args.timeout_ms,
            target_count=args.target_count,
            max_candidates=args.max_candidates,
            candidate_timeout_ms=args.candidate_timeout_ms,
            progress_file=args.progress_file,
            audit_file=args.audit_file,
            recall_keywords=args.recall_keyword,
            cities=args.city,
            llm=args.llm,
            headless=args.headless,
            approval_requester=make_terminal_approval_requester(
                timeout_ms=args.approval_timeout_ms,
            ),
        )
        return _write_result_with_observability(result, args)

    if args.command == "supervise-single-job-loop":
        result = run_single_job_application_loop(
            repo_root=args.repo_root,
            node=args.node,
            timeout_ms=args.timeout_ms,
            job_file=args.job,
            from_browser=args.from_browser,
            run_id=args.run_id,
            token_file=args.token_file,
            audit_file=args.audit_file,
            recall_keywords=args.recall_keyword,
            cities=args.city,
            llm=args.llm,
            confirm=args.confirm,
            headless=args.headless,
            now=args.now,
            approval_requester=(
                make_terminal_approval_requester(timeout_ms=args.approval_timeout_ms)
                if args.confirm
                else None
            ),
        )
        _write_json_payload(
            result.model_dump(exclude_none=True),
        )
        return 0 if result.ok else 1

    if args.command == "supervise-tokened-batch":
        result = run_bounded_tokened_application_batch(
            repo_root=args.repo_root,
            node=args.node,
            timeout_ms=args.timeout_ms,
            batch_run_id=args.run_id,
            token_file=args.token_file,
            audit_file=args.audit_file,
            target_count=args.target_count,
            max_candidates=args.max_candidates,
            candidate_timeout_ms=args.candidate_timeout_ms,
            max_token_validation_failures=args.max_token_validation_failures,
            recall_keywords=args.recall_keyword,
            cities=args.city,
            llm=args.llm,
            confirm=args.confirm,
            headless=args.headless,
            now=args.now,
            approval_requester=(
                make_terminal_approval_requester(timeout_ms=args.approval_timeout_ms)
                if args.confirm
                else None
            ),
        )
        _write_json_payload(
            result.model_dump(exclude_none=True),
        )
        return 0 if result.ok else 1

    if args.command == "review-application-preferences":
        result = review_recent_application_preferences(
            db_path=args.db_path,
            limit=args.limit,
        )
        _write_json_payload(
            result.model_dump(exclude_none=True),
        )
        return 0 if result.ok else 1

    if args.command == "build-preference-evidence":
        result = build_preference_evidence_package_from_file(
            args.recent_applications,
            candidate_statement_path=args.candidate_statement,
            capability_profile_path=args.capability_profile,
            target_jd_samples_path=args.target_jd_samples,
            clarification_answers_path=args.clarification_answers,
            now=args.now,
        )
        payload = result.model_dump(exclude_none=True)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        _write_json_payload(payload)
        return 0

    if args.command == "generate-application-preference-profile":
        llm_client = None
        if args.llm_response is not None:
            llm_client = lambda _messages: args.llm_response.read_text(encoding="utf-8")
        result = generate_application_preference_profile_from_file(
            args.evidence_package,
            output_path=args.output,
            llm_client=llm_client,
        )
        _write_json_payload(result.model_dump(exclude_none=True))
        return 0 if result.ok else 1

    if args.command == "record-preference-clarification-answer":
        answer = build_preference_clarification_answer(
            answer_id=args.answer_id,
            question_text=args.question_text,
            recommended_answer_shown=args.recommended_answer,
            user_answer=args.user_answer,
            affected_fields=args.affected_field,
            created_at=args.created_at,
        )
        result = persist_preference_clarification_answer_to_file(
            args.output,
            answer,
        )
        _write_json_payload(result.model_dump(exclude_none=True))
        return 0

    if args.command == "clarify-application-preferences":
        result = propose_preference_clarification_question(
            args.profile,
            args.evidence_package,
        )
        _write_json_payload(
            {
                "ok": result is not None,
                "question": result.model_dump(exclude_none=True)
                if result is not None
                else None,
            }
        )
        return 0 if result is not None else 1

    if args.command == "check-application-preference-profile-freshness":
        result = evaluate_application_preference_profile_staleness(
            args.profile,
            args.evidence_package,
        )
        _write_json_payload(result.model_dump(exclude_none=True))
        return 1 if result.stale else 0

    parser.error(f"unknown command: {args.command}")
    return 2


def _add_batch_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--node")
    parser.add_argument("--timeout-ms", type=int, default=300_000)
    parser.add_argument("--target-count", type=int, default=1)
    parser.add_argument("--max-candidates", type=int)
    parser.add_argument("--candidate-timeout-ms", type=int)
    parser.add_argument("--progress-file", type=Path)
    parser.add_argument("--audit-file", type=Path)
    parser.add_argument("--recall-keyword", action="append", default=[])
    parser.add_argument("--city", action="append", default=[])
    parser.add_argument("--llm", action="store_true")
    parser.add_argument("--headless", action="store_true")


def _add_single_job_loop_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--node")
    parser.add_argument("--timeout-ms", type=int, default=300_000)
    parser.add_argument("--job", type=Path)
    parser.add_argument("--from-browser", action="store_true")
    parser.add_argument("--run-id")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--audit-file", type=Path)
    parser.add_argument("--recall-keyword", action="append", default=[])
    parser.add_argument("--city", action="append", default=[])
    parser.add_argument("--llm", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--now")
    parser.add_argument("--approval-timeout-ms", type=int, default=60_000)


def _add_tokened_batch_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--node")
    parser.add_argument("--timeout-ms", type=int, default=300_000)
    parser.add_argument("--run-id")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--audit-file", type=Path)
    parser.add_argument("--target-count", type=int, default=1)
    parser.add_argument("--max-candidates", type=int)
    parser.add_argument("--candidate-timeout-ms", type=int)
    parser.add_argument("--max-token-validation-failures", type=int, default=1)
    parser.add_argument("--recall-keyword", action="append", default=[])
    parser.add_argument("--city", action="append", default=[])
    parser.add_argument("--llm", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--now")
    parser.add_argument("--approval-timeout-ms", type=int, default=60_000)


def _write_result_with_observability(
    result: CliToolResult,
    args: argparse.Namespace,
) -> int:
    observability = build_observability_report(
        tool_result=result,
        progress_file=args.progress_file or _progress_file_from_result(result),
        audit_file=args.audit_file or _audit_file_from_result(result),
    )
    payload = result.model_dump(exclude_none=True)
    payload["observability"] = observability.model_dump(exclude_none=True)
    _write_json_payload(payload)
    return 0 if result.ok else 1


def _write_json_payload(payload) -> None:
    text = json.dumps(
        payload,
        ensure_ascii=False,
        indent=2,
    )
    data = f"{text}\n".encode("utf-8")
    stdout_buffer = getattr(sys.stdout, "buffer", None)
    if stdout_buffer is not None:
        stdout_buffer.write(data)
    else:  # pragma: no cover - defensive fallback for unusual stdout objects
        sys.stdout.write(data.decode("utf-8"))


def _requested_command(argv: list[str] | None) -> str | None:
    raw_argv = sys.argv[1:] if argv is None else argv
    return raw_argv[0] if raw_argv else None


def _progress_file_from_result(result) -> str | None:
    if result.output is None:
        return None
    return result.output.progressFile


def _audit_file_from_result(result) -> str | None:
    if result.output is None:
        return None
    for item in result.output.results:
        if item.auditFile:
            return item.auditFile
    return None
