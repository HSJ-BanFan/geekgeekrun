from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .subprocess_runner import run_dry_run_batch


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ggr-sidecar",
        description="Supervise dry-run job batches through the existing Node CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    batch = subparsers.add_parser(
        "supervise-dry-run-batch",
        help="Invoke ggr run-batch without --confirm and validate its JSON stdout.",
    )
    batch.add_argument("--repo-root", type=Path, default=_default_repo_root())
    batch.add_argument("--node", default="node")
    batch.add_argument("--timeout-ms", type=int, default=300_000)
    batch.add_argument("--target-count", type=int, default=1)
    batch.add_argument("--max-candidates", type=int)
    batch.add_argument("--candidate-timeout-ms", type=int)
    batch.add_argument("--progress-file", type=Path)
    batch.add_argument("--recall-keyword", action="append", default=[])
    batch.add_argument("--city", action="append", default=[])
    batch.add_argument("--llm", action="store_true")
    batch.add_argument("--headless", action="store_true")

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
            recall_keywords=args.recall_keyword,
            cities=args.city,
            llm=args.llm,
            headless=args.headless,
        )
        sys.stdout.write(
            json.dumps(
                result.model_dump(exclude_none=True),
                ensure_ascii=False,
                indent=2,
            )
        )
        sys.stdout.write("\n")
        return 0 if result.ok else 1

    parser.error(f"unknown command: {args.command}")
    return 2


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]
