# PRD: Package recent BOSS applications with JD crawl as a CLI command

## Problem Statement

用户在进行真实简历投递前，需要先了解自己最近一批已投岗位的真实情况：投了哪些岗位、对应 JD 写了什么、岗位是否真正匹配 Target Role Intent、哪些岗位只是数据标注、翻译、审核、兼职等噪声。

当前这项能力已经通过一次临时只读抓取验证可行，但实现散落在交互式 CDP 脚本和手工步骤里。它不能被重复运行、不能被 Python sidecar 稳定调用、不能纳入 CLI JSON contract，也不能作为后续 Application Authorization 前的标准偏好预检输入。

用户希望把“最近已投岗位 + 对应 JD + 偏好分析”的抓取能力封装成 CLI。CLI 必须保持只读，不发送消息、不投递、不上传简历、不绕过 BOSS 安全验证，并且符合 ADR-0009 和 ADR-0010：Python sidecar 只能调用稳定 CLI contract，不能直接操作浏览器；历史抓取输出只是 Decision Evidence，不是 Application Authorization。

## Solution

新增一个只读 CLI 能力，用于从已登录的 BOSS 求职者会话中抓取最近 N 条已投/已沟通岗位，并为每条记录补齐 JD。

建议命令形态：

```text
ggr recent-applications --from-browser --limit 100 --include-jd --analyze
```

该命令从 BOSS 聊天页读取 `chatStore.friendInfos` 作为最近沟通/投递清单来源，按 `lastTS` 或 `updateTime` 倒序取前 N 条。每条记录提取非秘密结构化字段，例如岗位名、公司、职位类别、城市、招聘者、`encryptJobId`、最后一条消息状态等。

JD 补齐使用稳定的只读详情页 DOM 策略：打开对应 `job_detail` 页面，等待真实职位详情页加载，从“职位描述”区域读取 `.job-sec-text` 文本。接口 `/wapi/zpgeek/job/detail.json` 可以作为可选快路径，但不能作为唯一实现，因为批量直接请求容易触发 BOSS 安全校验。遇到安全验证页、异常行为返回、登录失效或页面无法确认时，CLI 必须停止或保存 partial artifact，并报告需要人工处理，而不是继续请求或尝试绕过。

命令输出 JSON 到 stdout，并把完整结果保存到 storage artifact。可选 `--analyze` 生成偏好分析 artifact，统计标题类别、JD 技术词、城市、职位类别、明显噪声岗位、核心目标岗位和招聘方最后消息信号。

## User Stories

1. As a job seeker, I want to fetch my latest BOSS application conversations from the CLI, so that I can review my real application history before sending more resumes.
2. As a job seeker, I want each recent application record to include the corresponding JD, so that I can understand what I actually applied to rather than only seeing chat titles.
3. As a job seeker, I want the command to default to the latest 100 records, so that it matches my review workflow before a real application batch.
4. As a job seeker, I want to configure the record limit, so that I can inspect a smaller or larger recent window.
5. As a job seeker, I want the command to preserve application order by recent chat timestamp, so that the output reflects my actual recent behavior.
6. As a job seeker, I want the command to show company, job title, position category, city, recruiter name, and last message signal, so that I can quickly scan the results.
7. As a job seeker, I want the command to capture full JD text, so that preference analysis can be based on the actual job requirements.
8. As a job seeker, I want raw crawl output saved to a local artifact, so that I can inspect or reuse the data later.
9. As a job seeker, I want a separate preference analysis artifact, so that I can quickly see my real target pattern and noise pattern.
10. As a job seeker, I want AI/LLM/Agent, AI full-stack, Python backend, data annotation, translation, testing, remote part-time, and internship signals counted separately, so that I can see whether my applications match my Target Role Intent.
11. As a job seeker, I want the tool to identify likely noise applications, so that future batches can downrank pure data annotation, translation, audit, data entry, finance sales, or service jobs.
12. As a job seeker, I want the tool to identify cleaner core target applications, so that the agent can learn from the jobs I actually prefer.
13. As a job seeker, I want the command to report how many records were fully crawled, partially crawled, blocked, or failed, so that I know whether the artifact is reliable.
14. As a job seeker, I want the command to stop safely when BOSS shows a safety verification page, so that my account is not pushed into more abnormal requests.
15. As a job seeker, I want the command to let me complete safety verification manually in the browser and rerun the command, so that the tool works with platform safeguards instead of bypassing them.
16. As a job seeker, I want the command to avoid sending messages, clicking apply, clicking continue-chat, or uploading resumes, so that review cannot accidentally become real action.
17. As a job seeker, I want the command to avoid opening unrelated search results, so that the crawl stays scoped to my recent applications.
18. As a job seeker, I want the command to work with the existing logged-in persistent BOSS browser profile, so that I do not need to log in repeatedly.
19. As a job seeker, I want an optional way to attach to an already-open debug browser, so that a manual verification session can be reused.
20. As an agent operator, I want a JSON-first command contract, so that Python sidecar and future tools can consume the crawl without scraping terminal text.
21. As an agent operator, I want stable reason codes for login expiration, safety verification, missing chat store, missing job identity, DOM extraction failure, and partial completion, so that orchestration can stop predictably.
22. As an agent operator, I want the sidecar to call this CLI as a read-only preference precheck, so that it can inspect past applications without directly operating the browser.
23. As an agent operator, I want the command to emit a storage path and summary counts, so that a later planning step can load the artifact.
24. As an agent operator, I want the command to support dry-run-like planning output where possible, so that I can confirm what it would read before a long crawl.
25. As a maintainer, I want the browser logic to live in the Node CLI browser action layer, so that ADR-0009 remains intact.
26. As a maintainer, I want the extraction logic separated from the CLI argument parser, so that it can be tested without spawning a real browser.
27. As a maintainer, I want DOM extraction to prefer semantic section detection around “职位描述”, so that minor class changes do not immediately break the crawler.
28. As a maintainer, I want direct job detail API fetching treated as optional and guarded, so that anti-bot responses do not make the primary path brittle.
29. As a maintainer, I want partial artifacts written incrementally, so that an interrupted crawl does not lose completed records.
30. As a maintainer, I want output artifacts to avoid cookies, local storage, API keys, full browser state, and unneeded access tokens, so that review artifacts stay inspectable.
31. As a maintainer, I want full `securityId` persisted only behind an explicit unsafe/debug option if ever needed, so that default artifacts do not retain browser access parameters.
32. As a maintainer, I want the command to reuse existing BOSS browser launch configuration, stealth/laodeng setup, and persistent profile conventions, so that behavior is consistent with existing actions.
33. As a maintainer, I want tests to cover the CLI JSON contract with fake pages, so that live BOSS is not required for CI.
34. As a maintainer, I want preference analysis rules to be deterministic first, so that tests can verify category counts without LLM nondeterminism.
35. As an auditor, I want artifacts to distinguish read-only crawl evidence from Application Authorization or Audit Record evidence, so that no one mistakes historical review for permission to act.
36. As an auditor, I want the command to record capture time, source, page strategy, and status summaries, so that the artifact can be explained later.
37. As a future implementer, I want this feature to be one CLI-owned capability, so that Python sidecar can remain a thin Agent Orchestrator.
38. As a future implementer, I want clear out-of-scope boundaries around real actions, so that no future agent adds “auto-continue from history crawl” behavior accidentally.

## Implementation Decisions

- The feature is a read-only browser extraction capability, not an application action. It does not grant Application Authorization and must not consume or issue Application Authorization Tokens.
- The Node CLI owns the browser interaction. The Python sidecar may call the CLI and parse JSON, but must not directly inspect BOSS DOM, call BOSS APIs, or navigate browser pages.
- The initial CLI command should be exposed as `recent-applications` or an equivalently explicit name under the existing `ggr` CLI.
- The command should support `--from-browser`, `--limit`, `--include-jd`, `--analyze`, `--output`, and an optional browser attachment parameter such as `--cdp-port` or `--browser-url`.
- The default browser mode should reuse the existing persistent BOSS browser profile and launch conventions. The attach mode exists for cases where the user has already completed login or safety verification in a visible browser.
- The recent application list source is the BOSS chat page runtime state, specifically `chatStore.friendInfos` when available.
- The list extraction sorts records by `lastTS`, `updateTime`, or equivalent recent-message timestamp descending.
- The list extraction captures stable job and conversation evidence: rank, conversation id, recruiter summary, brand, title, position category, city, last message summary, last message direction, last message status, `encryptJobId`, and numeric job id if present.
- The canonical Job Identity Anchor for later application actions remains the job id. Historical crawl output must not be used as authorization for any future action.
- JD extraction should prefer the job detail DOM strategy proven in the manual tracer bullet: navigate to the `job_detail` page for the record and extract the text under the “职位描述” section, typically `.job-detail-section .job-sec-text`.
- The DOM strategy should also capture useful non-secret page evidence such as page title, resolved URL, salary text if visible, and company description when easy to extract.
- The direct BOSS detail API may be implemented as an optional `api-first` strategy, but the CLI must treat `code:36`, `code:37`, missing parameters, safety-check pages, and abnormal responses as stop or fallback signals rather than retry aggressively.
- If BOSS returns or renders a safety verification page, the CLI should stop the batch, write completed records, mark the blocking record as `blocked`, and report a stable reason code such as `BOSS_SAFETY_VERIFICATION_REQUIRED`.
- If login is missing or expired, the CLI should fail closed with a stable reason code such as `BOSS_LOGIN_REQUIRED`.
- If `chatStore.friendInfos` is unavailable, the CLI may fall back to DOM list scraping only if the output schema can preserve confidence and partial status. The first implementation may simply fail with `BOSS_CHAT_STORE_UNAVAILABLE`.
- Artifacts should be written incrementally under the existing storage directory. The stdout JSON should include paths to the raw crawl artifact and optional analysis artifact.
- The raw artifact should include a schema version, capture metadata, source strategy, status summary, and records.
- Default artifacts must not store cookies, local storage, full browser state, API keys, or resume paths.
- Default artifacts should not persist full `securityId`. If the implementation needs `securityId` during the run, it should keep it in memory and persist only a redacted summary or hash. Persisting raw browser access parameters should require an explicit debug option and be marked unsafe.
- The optional preference analysis should be deterministic and based on job title, position category, JD text, city, and last-message signals.
- Preference analysis should produce at least: title category counts, JD term counts, top cities, top position categories, core target examples, mixed target/noise examples, likely noise examples, and recruiter-last-message examples.
- Preference categories should include AI/LLM/Agent/AIGC, full-stack, Python/backend/data engineering, frontend/React/Vue, Java/traditional backend, data annotation/AI training, translation/localization/Japanese, testing/IT generic roles, product/operations/audit/data entry, remote/part-time, and internship/new-grad.
- The CLI should use stable status values per record: `pending`, `ok`, `failed`, `blocked`, and `skipped`.
- The command should be safe to interrupt. Completed records should remain readable, and rerunning the command should not perform real actions.
- The command may support `--resume-output` later, but the MVP can rely on rerunning from the current browser session if partial completion occurs.
- This capability can later feed an Application Preference precheck in the sidecar, but that precheck must remain advisory and must not bypass Rule Boundary, LLM Apply Decision, Application Authorization, Job Identity Anchor, or Job Match Guard.

## Testing Decisions

- The highest-value test seam is the CLI JSON contract for the new recent-applications command.
- Tests should verify external behavior and safety guarantees rather than private helper implementation details.
- Browser extraction should be tested with fake page objects or fixture HTML, following existing browser action test prior art.
- A fake chat page should prove that `chatStore.friendInfos` records are sorted by recent timestamp and normalized into the expected output schema.
- A fake job detail page should prove that the “职位描述” section is extracted from DOM without relying on one brittle selector only.
- A fake safety verification page should prove that the command stops, writes partial output, and returns `BOSS_SAFETY_VERIFICATION_REQUIRED`.
- A fake missing-login or missing-chat-store state should prove that the command fails closed with stable reason codes.
- Tests should prove the command never calls send-message, start-chat, upload-image, continue-chat, or any authorized-action path.
- Tests should prove default artifacts do not contain cookies, local storage, resume paths, or raw browser state.
- Tests should prove default artifacts redact or omit raw `securityId`.
- Preference analysis tests should use fixture records and JDs to verify deterministic category counts and examples.
- CLI tests should cover `--limit`, `--include-jd`, `--analyze`, custom output path, partial status, and stdout summary shape.
- Existing prior art includes browser action fake-page tests, audit redaction tests, job profile normalization tests, and sidecar CLI JSON schema tests.
- The package check and relevant Node tests should pass before the issue is considered complete.

## Out of Scope

- Sending messages to recruiters.
- Starting chats, continuing chats, applying to jobs, or uploading resumes.
- Issuing or consuming Application Authorization Tokens.
- Letting historical application data authorize future real actions.
- Bypassing BOSS safety verification, captcha, abnormal-account checks, or platform safeguards.
- Building a long-running RPC service or MCP server.
- Letting Python sidecar directly operate the browser.
- Replacing Rule Boundary, LLM Apply Decision, Target Role Intent, or Candidate Profile evaluation.
- Persisting cookies, local storage, API keys, full browser state, or resume image paths.
- Guaranteeing that BOSS DOM selectors will never change.
- Crawling arbitrary global search results outside recent applications/conversations.
- Automatically continuing a real application batch after this read-only crawl.

## Further Notes

The manual tracer bullet that proved the capability worked as follows:

1. Attach to the already logged-in Chrome DevTools session on the BOSS chat page.
2. Read `window.chatStore.friendInfos` and sort the values by `lastTS` or `updateTime`.
3. Extract the latest 100 structured records, including `encryptJobId`, numeric `jobId`, `securityId`, company, job title, position category, city, recruiter, and last message fields.
4. Validate that `/wapi/zpgeek/job/detail.json?securityId=...&jobId=<encryptJobId>` can return JD for a single record.
5. Observe that direct repeated API use can trigger BOSS abnormal-environment/account responses (`code:37` and `code:36`), so API-only batch crawling is not reliable enough.
6. Open a normal `job_detail/<encryptJobId>.html?securityId=...` page in the visible browser and let the user complete BOSS safety verification when required.
7. Navigate each record's job detail page in the browser and extract the DOM text under “职位描述”.
8. Save the raw artifact and generate a deterministic preference analysis artifact.

The CLI should preserve the successful part of this tracer bullet while removing ad hoc CDP scripts, avoiding raw API hammering, and making the output contract stable enough for the sidecar.

This PRD intentionally reinforces ADR-0009 and ADR-0010: the sidecar can use this capability as a read-only preference evidence tool, but the browser remains owned by the CLI and historical crawl output cannot authorize real actions.
