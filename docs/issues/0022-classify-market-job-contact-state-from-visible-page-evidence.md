# Classify market job contact state from visible page evidence

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Classify Contact State for market jobs using only visible evidence from the current market search or detail page.

This slice should keep market sampling separate from historical chat/application evidence while preserving enough evidence text to audit the classification.

## Acceptance criteria

- [ ] Visible page text such as `立即沟通` maps to `uncontacted`.
- [ ] Visible page text such as `继续沟通`, `已沟通`, or a chat entry maps to `contacted`.
- [ ] Visible page text such as `已投递` or equivalent application/chatting state maps to `applied_or_chatting`.
- [ ] Missing or conflicting evidence maps to `unknown`.
- [ ] Each classified job or observation preserves concise `contactStateEvidence.text` suitable for review.
- [ ] The implementation does not navigate to the chat page, inspect `chatStore.friendInfos`, or call recent-application extraction to determine contact state.
- [ ] Tests cover all contact-state values and prove chat-history sources are not required.

## Blocked by

- [Crawl one search sample into market-jobs.v1 raw artifact](0020-crawl-one-search-sample-into-market-jobs-raw-artifact.md)

