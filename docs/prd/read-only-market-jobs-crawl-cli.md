# PRD: Add read-only market job crawl as a CLI command

## Problem Statement

用户需要在真实投递前，通过 BOSS 关键词和城市搜索页批量采样未沟通市场岗位，初步了解岗位供给、技术需求、薪资段、经验学历要求、公司类型和噪声岗位分布。

当前系统已有 `extract-job`、`run-once`、`run-batch` 和 `recent-applications`。这些能力分别面向单岗位检查、投递/沟通工作流、批量投递工作流、以及已沟通/已投递历史证据。它们都不能直接承担“海量只读市场采样”职责：市场采样需要稳定的只读边界、JSON-first 输出、raw artifact、分析 artifact、采样过程摘要、平台风险停止策略，以及和 Application Authorization 明确隔离。

## Solution

新增一个只读 CLI 命令：

```text
ggr market-jobs --from-browser --keyword "AI Agent" --city 上海 --limit 200 --include-jd --analyze
```

该命令打开 BOSS 求职者端关键词和城市搜索结果页，只读滚动加载岗位列表，提取可见结构化字段，按 `jobId` 去重，并保存 raw market artifact。可选 `--include-jd` 时，命令顺序导航岗位详情页并从 DOM 抽取完整 JD。可选 `--analyze` 时，命令生成确定性的 market analysis artifact。

`market-jobs` 不是投递工具，不点击“立即沟通”，不发送消息，不上传简历，不消耗或签发 Application Authorization Token，也不让市场证据授权任何后续真实动作。

## Command Contract

MVP 命令名：

```text
ggr market-jobs
```

Supported flags:

- `--from-browser`: required except for `--plan-only`.
- `--plan-only`: expand parameters and output the planned sample grid without browser access.
- `--keyword <value>`: repeatable Market Keyword. Do not use `--recall-keyword`.
- `--city <name-or-code>`: repeatable city input. Internally resolves to BOSS city code.
- `--limit <n>`: per keyword-city sample limit. Default `200`; maximum `500` per sample.
- `--include-jd`: optional detail-page DOM JD enrichment. Default off.
- `--analyze`: optional deterministic market analysis.
- `--output <file>`: optional raw artifact path.
- `--analysis-output <file>`: optional analysis artifact path.
- `--browser-url <url>` or `--cdp-port <port>`: optional browser attachment mode, consistent with `recent-applications`.
- `--headless`: supported consistently with existing browser commands, but visible mode remains safer for manual verification.

Multiple keywords and cities expand as a Cartesian product. For example, 2 keywords x 2 cities x limit 200 may inspect up to 800 visible list records across four samples. `--plan-only` should make that budget explicit before browser access.

Stdout should emit only a JSON summary:

```json
{
  "ok": true,
  "command": "market-jobs",
  "sampleCount": 1,
  "jobCount": 200,
  "statusSummary": {},
  "rawArtifactPath": "...",
  "analysisArtifactPath": "...",
  "reasonCode": null
}
```

Complete jobs, observations, and JD text belong in artifacts, not stdout.

## Raw Artifact

Raw artifact schema:

```text
schemaVersion: "market-jobs.v1"
```

The raw artifact should include:

- `captureMetadata`: capture time, command arguments, read-only marker, per-sample requested limit, `includeJd`, and authorization metadata showing this command neither issues nor consumes authorization.
- `sourceStrategy`: `boss_geek_search_results` for list sampling and `boss_job_detail_dom` or `not_requested` for JD.
- `samples[]`: one record per keyword-city sample.
- `jobs[]`: globally deduplicated market jobs.
- `statusSummary`: global counts and reason-code counts.

Each `sample` should include:

- `sampleKey`
- `keyword`
- `cityInput`
- `cityCode`
- `status`
- `reasonCode`
- `requestedLimit`
- `capturedCount`
- `dedupedJobCount`
- `scrollCount`
- `noNewItemCount`
- `startedAt`
- `endedAt`

Raw artifact stores two layers:

- `samples[]` preserves each keyword-city sampling process and original list ranking.
- `jobs[]` deduplicates by stable `jobId` where possible.

Each job has `observations[]`, recording which sample surfaced it, rank, contact-state evidence, list text, and source metadata.

If a list item has no stable `jobId`, keep it with `jobIdentity.status = "missing"` and a temporary fingerprint derived from title, company, salary, city, sample key, and rank. Mark analysis identity confidence as low. Such records may inform market supply, but must not enter any future action chain that requires a Job Identity Anchor.

## Extracted Fields

List extraction should capture visible non-secret fields where available:

- title
- company
- city
- salary text
- experience
- degree
- job category or position category
- visible job tags
- stable `jobId` / encrypted job id when available
- contact state and evidence text
- recruiter summary: name, title, active text
- company summary: industry, financing stage, size, visible tags

The command must not persist cookies, local storage, raw `securityId`, API keys, resume paths, avatar URLs, personal homepage URLs, chat-entry parameters, or full browser state.

## Contact State

`contactState` is observed only from the current market page or detail page. It must not cross-check chat history or call the recent applications source.

Suggested values:

- `uncontacted`
- `contacted`
- `applied_or_chatting`
- `unknown`

Evidence examples:

- `立即沟通` -> `uncontacted`
- `继续沟通` / `已沟通` / chat entry -> `contacted`
- `已投递` or equivalent -> `applied_or_chatting`
- missing or conflicting visible text -> `unknown`

Default market analysis focuses on `uncontacted` jobs, but raw artifact may preserve contacted jobs for sampling integrity.

## JD Enrichment

`--include-jd` is off by default.

When enabled:

- Use normal browser page navigation and DOM extraction only.
- Reuse one browser page and process details sequentially.
- Do not implement concurrent JD fetching in MVP.
- Do not call BOSS `/wapi/.../job/detail.json` as an MVP fast path.
- Save full JD text in the raw artifact when successfully extracted.

If JD enrichment triggers login expiration, safety verification, abnormal environment, or unconfirmed page state, stop the command and write a partial artifact.

## Analysis Artifact

Analysis artifact schema:

```text
schemaVersion: "market-jobs-analysis.v1"
```

`--analyze` is deterministic in MVP. It must not call LLMs.

Default analysis:

- Counts market supply primarily from `contactState = uncontacted`.
- Does not exclude low-identity-confidence jobs from market supply counts.
- Separately reports `actionableJobCount` for jobs with stable `jobId`.
- Reports `identityConfidenceBreakdown`.
- Reports `sampleBreakdown` by keyword-city sample.

Reuse the existing category baseline from recent application preference analysis:

- `ai_llm_agent_aigc`
- `full_stack`
- `python_backend_data_engineering`
- `frontend_react_vue`
- `java_traditional_backend`
- `data_annotation_ai_training`
- `translation_localization_japanese`
- `testing_it_generic`
- `product_operations_audit_data_entry`
- `remote_part_time`
- `internship_new_grad`

Add market-specific statistics:

- salary buckets
- experience buckets
- degree buckets
- city distribution
- company industry
- company size
- financing stage
- contact state
- identity confidence
- likely noise examples
- core target examples
- mixed target/noise examples

Salary analysis should keep original `salaryText` and use conservative buckets such as monthly low/mid/high, daily rate, negotiable, and unknown. Do not infer annual compensation in MVP.

Experience and degree analysis should normalize only explicit fields, not infer requirements from JD prose.

## Safety Behavior

The command must stop safely and write a partial artifact when platform-level risk appears:

- `BOSS_LOGIN_REQUIRED`
- `BOSS_SAFETY_VERIFICATION_REQUIRED`
- `BOSS_ABNORMAL_ENVIRONMENT`
- unconfirmed detail page
- search list DOM unavailable after navigation

Platform-level risk stops the whole command. Ordinary sample exhaustion, no-new-items threshold, or reaching the requested limit ends only the current sample.

The list stage should scroll and extract cards until the limit, no-new-items threshold, sample end condition, or platform risk. It should not click each job during list sampling. Detail navigation occurs only under `--include-jd`.

MVP does not support true resume-from-partial behavior. Partial artifacts must remain readable and analyzable, and rerunning the command must be safe. A future `--resume-output` can be considered later.

## User Stories

1. As a job seeker, I want to sample BOSS jobs by keyword and city, so that I can understand current market demand before applying.
2. As a job seeker, I want the command to be read-only, so that market research cannot accidentally become recruiter contact.
3. As a job seeker, I want a default limit of 200 per sample and maximum 500 per sample, so that market sampling remains bounded.
4. As a job seeker, I want to run `--plan-only`, so that I can inspect the sampling budget before browser access.
5. As a job seeker, I want multiple keywords and cities, so that I can compare role directions and locations.
6. As a job seeker, I want contacted jobs preserved but excluded from default market-demand analysis, so that the sample remains faithful while the analysis focuses on untapped market supply.
7. As a job seeker, I want optional JD enrichment, so that I can trade speed and risk for deeper requirement analysis.
8. As a job seeker, I want full JD text saved when I request JD enrichment, so that I can inspect source evidence later.
9. As a job seeker, I want deterministic market analysis, so that repeated runs are explainable and testable.
10. As an agent operator, I want JSON stdout with artifact paths, so that sidecar tools can consume the command without parsing terminal text.
11. As an agent operator, I want stable reason codes, so that orchestration can stop predictably.
12. As a maintainer, I want raw artifacts to separate samples, deduped jobs, and observations, so that keyword-city rankings are preserved without double-counting jobs.
13. As a maintainer, I want low-confidence jobs retained but marked, so that market signal is not lost while action boundaries remain safe.
14. As an auditor, I want artifacts to state that market evidence is not Application Authorization, so that no future tool mistakes research for permission to act.

## Implementation Decisions

- The Node CLI owns all browser interaction. The Python sidecar may call this CLI and parse JSON, but must not directly inspect BOSS DOM, call BOSS APIs, or navigate BOSS pages.
- The command is named `market-jobs`.
- The command uses `--keyword`, not `--recall-keyword`.
- MVP data source is BOSS geek keyword-city search results only, not personalized recommendations.
- `--from-browser` is required except for `--plan-only`.
- `--include-jd` is default off.
- `--analyze` is deterministic and does not use LLMs.
- The command writes a raw artifact and optional analysis artifact.
- The command does not create or update an Application Preference Profile.
- Any later preference-profile synthesis should happen in a separate command or sidecar step using Market Job Evidence, Recent Application Evidence, Candidate Statement, and Candidate Profile.
- The command never clicks application or chat controls.
- The command does not issue or consume Application Authorization Tokens.

## Testing Decisions

- The highest-value test seam is CLI JSON contract and artifact shape.
- Use fake page objects or fixture HTML, not live BOSS, for CI.
- Test `--plan-only` without opening a browser.
- Test multi-keyword/multi-city sample-grid expansion.
- Test limit defaults, maximum limit enforcement, and per-sample counting.
- Test list extraction normalization into `samples[]`, `jobs[]`, and `observations[]`.
- Test global dedupe by `jobId`.
- Test low-confidence records when `jobId` is missing.
- Test contact-state classification from visible text.
- Test no-JD default behavior.
- Test JD DOM extraction only when `--include-jd` is true.
- Test partial artifact writing on safety verification, login expiration, abnormal environment, and missing list DOM.
- Test deterministic analysis category counts, salary buckets, experience buckets, degree buckets, contact-state breakdown, identity-confidence breakdown, and actionable job count.
- Test stdout summary excludes full jobs and JD text.
- Test artifacts do not contain cookies, local storage, raw `securityId`, resume paths, avatar URLs, homepage URLs, chat-entry parameters, or browser state.
- Existing package tests should continue passing.

## Out of Scope

- Sending recruiter messages.
- Starting chats, continuing chats, applying to jobs, or uploading resumes.
- Issuing or consuming Application Authorization Tokens.
- Letting market evidence authorize future real actions.
- Crawling personalized recommendation feeds in MVP.
- Direct BOSS job-detail API fetching in MVP.
- Concurrent JD enrichment.
- True partial-artifact resume.
- LLM-based market analysis.
- Creating or mutating Application Preference Profile.
- Opening company pages for extra company information.
- Calling chat history or `chatStore.friendInfos` to determine contact state.
- Bypassing BOSS login, safety verification, captcha, abnormal-account checks, or platform safeguards.

## Further Notes

This PRD follows `CONTEXT.md` terms: Market Job Evidence, Market Keyword, Contact State, Decision Evidence, Application Authorization, Application Authorization Token, Agent Orchestrator, and Job Identity Anchor.

The architectural decision is recorded in `docs/adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md`.
