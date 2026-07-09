# Add market-jobs --plan-only CLI contract

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Add the first `market-jobs` vertical slice: a `--plan-only` CLI path that expands Market Keyword and city inputs into a bounded sample grid without opening a browser.

This should establish the command name, argument parsing, limit rules, city normalization, JSON stdout summary, and artifact path planning for later slices.

## Acceptance criteria

- [ ] `ggr market-jobs --plan-only --keyword "AI Agent" --city 上海` returns JSON with `ok: true`, `command: "market-jobs"`, planned samples, requested limits, and planned artifact paths.
- [ ] `--from-browser` is not required in `--plan-only` mode, and no browser launch or BOSS navigation occurs.
- [ ] `--keyword` and `--city` are repeatable and expand as a Cartesian product.
- [ ] City names and city codes are accepted; output preserves `cityInput` and normalized `cityCode`.
- [ ] Per-sample `--limit` defaults to 200 and is capped or rejected above 500 with a stable reason code.
- [ ] The command uses `--keyword`, not `--recall-keyword`, and stdout remains JSON-first.
- [ ] Tests cover plan-only behavior without live BOSS or a real browser.

## Blocked by

None - can start immediately

