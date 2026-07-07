# PRD: Generate personalized greetings from cached capability profiles

## Problem Statement

当前求职端 Agent CLI 已经能读取职位、执行 Rule Boundary、调用 LLM Apply Decision，并在最终 `apply` 后执行受控浏览器动作。但开场白仍主要来自预设规则，无法根据用户简历描述、Target Role Intent、用户需求和目标职位 JD 生成更贴合岗位的开场白。

用户要解决的问题不是“写得更漂亮”本身，而是在不编造履历、不泄露敏感原文、不让生成内容影响投递授权的前提下，让系统先分析用户真实能力，再用 Evidence-Based Framing 对能力进行适度表达。预设开场白只应作为保底方案。

同时，系统不能每个职位都重新把完整简历交给 LLM 生成完整能力画像。完整简历可以作为一次性、瞬时输入用于生成能力画像，但持久化缓存、审计日志和每次职位开场白生成都只能使用非敏感、可审计的 Candidate Capability Profile 摘要。

## Solution

新增 Personalized Greeting MVP：

1. 先从 Candidate Profile、Target Role Intent 和用户需求中生成一次 Candidate Capability Profile。
2. 只缓存非敏感、可审计的能力画像摘要，不保存完整简历原文、联系方式、本地路径或完整开场白。
3. 在每次 `run-once` 中，只有最终 LLM Apply Decision 解析并通过、Final Decision 为 `apply` 后，才把 Candidate Capability Profile 和目标 JD 交给 LLM 生成 Personalized Greeting。
4. 使用 Greeting Guard 在发送前校验生成内容，阻止 unsupported claims、敏感信息、过长/过短文本和不安全内容。
5. 当个性化生成不可用、失败、解析失败或 Guard 不通过时，回退到现有预设 greeting。
6. 如果没有任何安全 greeting 文本，`start_chat` 仍可按已授权职位继续，但跳过文本发送；简历图片上传继续遵循现有配置。
7. MVP 复用当前启用的 LLM 配置；长期应拆分 `capability_profile_generation` 和 `greeting_generation` 两个场景键。
8. 不在本 PRD 中集成 OpenAI Agents SDK；先把当前 Node/CLI 体系内的能力边界做正确。

## User Stories

1. As a job seeker, I want the system to analyze my real abilities once, so that each job application can use a consistent and truthful ability baseline.
2. As a job seeker, I want the system to polish my positioning with Evidence-Based Framing, so that my greeting reads stronger without fabricating experience.
3. As a job seeker, I want personalized greetings to reference the target JD, so that recruiters see why I am relevant to that specific role.
4. As a job seeker, I want preset greetings to remain available as fallback, so that the application flow still works when personalization is unavailable.
5. As a job seeker, I want the system to avoid sending generic Python copy to Japanese translation jobs, so that the message matches the role context.
6. As a job seeker, I want the system to avoid sending Japanese localization copy to technical jobs, so that the message does not look mismatched.
7. As a job seeker, I want the system to generate greetings only after the final decision is apply, so that rejected or uncertain jobs do not consume generation budget or produce misleading content.
8. As a job seeker, I want generated greetings to avoid fake years of experience, fake companies, fake certifications, fake availability, or fake salary claims, so that the automation does not damage trust.
9. As a job seeker, I want the system to avoid exposing my full resume text during per-job greeting generation, so that repeated LLM calls do not spread sensitive originals.
10. As a job seeker, I want the cached profile to omit my contact details and local file paths, so that durable artifacts remain safe to inspect and share.
11. As a job seeker, I want short Chinese opening messages, so that recruiters receive a natural greeting instead of a long cover letter.
12. As a job seeker, I want the system to skip sending text when no safe greeting exists, so that it does not send unsafe or low-quality content just to complete the flow.
13. As a job seeker, I want existing image upload behavior to remain unchanged, so that the new greeting logic does not regress resume image delivery.
14. As an agent operator, I want `run-once` to orchestrate personalized greeting generation after apply, so that one command can execute the correct end-to-end behavior.
15. As an agent operator, I want dry-run output to report whether personalization would be attempted, so that I can verify the flow without clicking or sending messages.
16. As an agent operator, I want final browser actions to continue using Job Identity Anchor checks, so that greeting changes do not reintroduce wrong-job actions.
17. As an agent operator, I want skip and uncertain decisions to avoid greeting generation, so that the action phase remains tightly scoped to authorized applications.
18. As a maintainer, I want capability-profile generation to be separate from greeting generation, so that each stage can be tested and changed independently.
19. As a maintainer, I want a cache invalidation rule based on resume, intent, requirements, greeting rules, target changes, schema version, and prompt version, so that stale ability summaries are not reused accidentally.
20. As a maintainer, I want a stable non-sensitive summary schema, so that audit records and tests can verify what is stored.
21. As a maintainer, I want LLM failures to degrade to fallback greeting, so that model instability does not break application flow.
22. As a maintainer, I want malformed LLM output to fail closed into fallback, so that parsing errors do not send uncontrolled text.
23. As a maintainer, I want Greeting Guard to be deterministic where possible, so that obviously unsafe text can be blocked without another model call.
24. As a maintainer, I want generated greeting text to stay out of audit records, so that logs preserve evidence without storing message originals.
25. As a maintainer, I want audit records to include greeting source and guard outcome, so that later review can explain why preset or personalized text was used.
26. As a maintainer, I want the existing preset greeting rule to remain the fallback delivery contract, so that migration can be incremental.
27. As a maintainer, I want `send-greeting` to remain delivery-only, so that generation responsibility stays in profile/greeting modules and `run-once` orchestration.
28. As a maintainer, I want MVP to reuse current LLM configuration, so that we can ship the behavior before adding scenario-specific model config.
29. As a maintainer, I want long-term LLM scenes for capability profile and greeting generation, so that later model/prompt tuning can be separated cleanly.
30. As an auditor, I want durable records to show message source, fallback reason, guard result, summary, and character count, so that I can review safety without reading private message text.
31. As an auditor, I want cache and audit tests to prove raw resume text is absent, so that privacy guarantees are enforced by tests.
32. As a future implementer, I want this feature split into vertical slices, so that each slice can be implemented in a fresh agent session without loading the full conversation.

## Implementation Decisions

- The feature is split into two layers: Candidate Capability Profile and Personalized Greeting.
- Candidate Capability Profile is the reusable, cached ability analysis derived from Candidate Profile, Target Role Intent, user requirements, and greeting rules.
- Personalized Greeting is a per-job short opening message derived from the cached capability profile and the target JD.
- Evidence-Based Framing is the only allowed “beautification” strategy. The system may emphasize demonstrated or plausibly transferable strengths, but must not invent credentials, tenure, employers, certifications, project outcomes, availability, salary expectations, or personal history.
- Full resume text may be used only as transient input when generating or refreshing the capability profile.
- The cached capability profile must be a non-sensitive, auditable structure. It must not contain full resume original text, contact information, image paths, local filesystem paths, cookies, local storage, API keys, full greeting text, or other sensitive originals.
- The capability profile cache should include enough metadata to decide freshness: schema version, prompt version, source fingerprints, generated time, and the input categories that caused the profile to be valid.
- Cache invalidation should occur when resume content, target role intent, user requirements, greeting rules, candidate target, schema version, or prompt version changes.
- The MVP may expose profile building through `snapshot` or a distinct CLI command. The implementation should keep the profile-building capability separate from greeting generation even if `snapshot` triggers it initially.
- Greeting generation must run only after Final Decision is `apply`. Rule Boundaries and incomplete or malformed LLM Apply Decisions must not trigger greeting generation.
- Greeting generation does not grant Application Authorization. Authorization still comes from the existing final apply decision path.
- `run-once` is the orchestration point for per-job greeting generation because it already has the job profile, rule evaluation, LLM evaluation, final decision, dry-run/confirm mode, browser action sequence, and audit context.
- `send-greeting` remains delivery-only. It should not analyze resumes, generate capability profiles, or generate personalized text.
- The existing rule-selected greeting message remains the fallback greeting source.
- Fallback must be used when there is no cached capability profile, the profile is stale, LLM is unavailable, generation fails, parsing fails, output is empty, Guard fails, or the generated text is otherwise unsafe.
- If both personalized and preset greetings are unavailable or unsafe, the action phase may continue with `start_chat` when authorization and Job Identity Anchor checks pass, but text sending is skipped.
- Image upload behavior follows the existing configuration and should not depend on whether text personalization succeeds.
- Greeting Guard is required before sending any generated personalized greeting.
- Greeting Guard must block unsupported claims, fabricated or unverifiable claims, full resume text, contact information, local paths, image paths, API credentials, and unsuitable length.
- Greeting Guard should enforce a target Chinese greeting length of roughly 80 to 160 characters for MVP, with implementation tolerance for natural punctuation and whitespace.
- Greeting Guard should return structured results containing pass/fail, reasons, character count, and a safe summary suitable for audit.
- `run-once` dry-run may report that personalization would be attempted after an apply decision, but it should not click or send. Durable audit must still avoid storing full generated text.
- Audit records should store greeting source, guard result, fallback reason, message summary, and character count. They must not store full generated greeting text.
- The existing audit redaction rules should be extended rather than bypassed.
- MVP reuses the current enabled LLM configuration.
- Long-term model configuration should distinguish two scene keys: `capability_profile_generation` and `greeting_generation`.
- This PRD intentionally does not introduce OpenAI Agents SDK. Agent framework integration can happen later after the CLI capability boundary is correct.
- Existing browser action correctness based on Job Identity Anchor must remain unchanged.
- The MVP implementation should be delivered in vertical slices: capability profile cache first, greeting generator and Guard second, then `run-once` integration and audit behavior third.

## Testing Decisions

- The highest-value test seam is CLI JSON behavior, because the feature is consumed by agents and scripts through the CLI contract.
- Pure module tests are appropriate for cache freshness, non-sensitive serialization, greeting generation parsing, and Greeting Guard validation.
- Tests should verify external behavior and safety guarantees, not private helper implementation details.
- Capability profile tests should prove that raw resume originals are not persisted in the cache output.
- Capability profile tests should prove that contact information, local paths, and image paths are not persisted.
- Cache tests should cover fresh cache reuse and stale cache regeneration when relevant fingerprints or versions change.
- Greeting generator tests should cover generated personalized text, fallback on missing profile, fallback on LLM absence, fallback on parse failure, and fallback on unsafe generated content.
- Greeting Guard tests should cover unsupported claims, fake years, fake company/certification claims, contact information, local paths, full resume leakage, and length boundaries.
- `run-once` behavior tests should prove greeting generation is attempted only when Final Decision is `apply`.
- `run-once` behavior tests should prove skip and uncertain paths do not generate personalized greetings.
- `run-once` behavior tests should prove fallback greeting is used when personalization fails or Guard rejects generated text.
- Browser action tests should continue proving that apply actions relocate or verify by Job Identity Anchor before real actions.
- Audit tests should prove full generated greeting text and full resume text are absent from durable records.
- Regression tests should preserve existing behavior for preset greeting selection, LLM Apply Decision validation, audit JD summarization, and browser action dry-run.
- Existing test prior art includes candidate profile signal extraction tests, policy tests, final decision tests, audit redaction tests, and browser action fake-page tests.
- Before implementation is considered done, the job-agent CLI package check and test commands should pass.

## Out of Scope

- Integrating `openai-agents-python` or any OpenAI Agents SDK.
- Replacing the current Node CLI architecture with a Python sidecar.
- Building a multi-agent planning system.
- Letting generated greetings authorize applications.
- Generating a full new capability profile for every job.
- Persisting full resume text, raw private profile details, contact information, image paths, local paths, cookies, local storage, API keys, or full greeting text.
- Automatically rewriting the user's resume.
- Fabricating experience, education, employment, projects, outcomes, certifications, availability, salary, or identity details.
- Bypassing BOSS Zhipin platform safeguards or adding aggressive bulk-apply behavior.
- Changing the existing Job Identity Anchor browser-action correctness model.
- Redesigning the desktop UI.
- Adding scenario-specific LLM configuration UI in the MVP.
- Generating long cover letters or multi-turn recruiter conversations.
- Sending personalized greetings for jobs whose final decision is skip or uncertain.

## Further Notes

This PRD follows the domain terms in the project glossary: Application Authorization, LLM Apply Decision, Rule Boundary, Target Role Intent, Candidate Profile, Evidence-Based Framing, Candidate Capability Profile, Personalized Greeting, Greeting Guard, Audit Record, and Job Identity Anchor.

The architectural source of truth for this direction is the ADR titled “Generate greetings from cached capability profiles”. The next recommended skills step is `/to-issues`, splitting this PRD into independently implementable vertical slices.
