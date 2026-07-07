from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .approval import make_terminal_approval_requester
from .observability import build_observability_report
from .schemas import CliToolResult
from .subprocess_runner import run_confirmed_batch, run_dry_run_batch


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ggr-sidecar",
        description="Supervise job batches through the existing Node CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

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

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

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

    parser.error(f"unknown command: {args.command}")
    return 2


def _add_batch_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo-root", type=Path, default=_default_repo_root())
    parser.add_argument("--node", default="node")
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
    sys.stdout.write(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
        )
    )
    sys.stdout.write("\n")
    return 0 if result.ok else 1


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


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
