# 求职端 Agent CLI 改造 PRD

> 定位：记录求职端将现有 BOSS 自动化能力封装为 CLI，并进一步演进为 Agent 可编排投递系统的需求、边界和计划。
> 最后更新：2026-07-05

---

## 1. Problem Statement

当前求职端已经具备自动开聊、发送招呼语、上传图片、Recall Keyword 搜索、LLM 配置等能力，但这些能力主要藏在桌面应用配置和自动化流程内部。用户希望把系统能力拆成可被 Agent 调用的 CLI 命令，让 Agent 负责观察职位、读取 JD、判断是否符合求职目标，再调用 CLI 执行受控动作。

用户的核心痛点：

1. 仅靠 Recall Keyword 容易出现同一类岗位重复投递、城市/职位分布不均。
2. 职位标题不足以判断岗位是否合适，需要读取 JD 后再判断。
3. 不同岗位需要使用不同开场白，不能把 Python 后端文案发给日语翻译岗位。
4. 数据标注、信息录入、内容审核、运营跟播、无 Attention Technology 要求的 AI 岗等岗位需要明确排除。
5. 真实发送必须保守，避免误触发批量投递或重复发送。
6. 用户希望后续将该项目作为个人维护 fork 持续二次开发，因此需要清楚的文档化计划。

---

## 2. Solution

将求职端能力封装为 JSON-first CLI。CLI 是 Agent 的“手脚”，已配置的大模型是 Agent 的“大脑”。CLI 默认只做 dry-run，只有显式传入 `--confirm` 才允许执行真实发送动作。

当前 MVP 已实现：

| 命令 | 作用 | 当前状态 |
|------|------|----------|
| `snapshot` | 读取当前求职端配置摘要：Recall Keyword、静态条件、开场白规则、简历图片、LLM 状态 | 已实现 |
| `extract-job --from-browser` | 从浏览器当前选中职位提取职位详情和 JD | 已实现 |
| `extract-job --job job.json` | 从文件或参数归一化职位结构 | 已实现 |
| `evaluate-job` | 用规则判断职位是否投递 | 已实现 |
| `evaluate-job --llm` | 调用当前配置的大模型做 JD 判断 | 已实现 |
| `send-greeting` | 对最近聊天发送选中的开场白和图片；默认 dry-run | 已实现 |
| `run-once` | 串联提取、判断、输出预设任务；默认 dry-run | 已实现 |

后续目标是把 CLI 串成可控 Agent loop：

```
打开/切换职位
  -> extract-job 读取 JD
  -> evaluate-job 规则初筛
  -> evaluate-job --llm 复核
  -> apply: start-chat --confirm
  -> send-greeting --confirm
  -> audit-log
  -> next-job
```

---

## 3. User Stories

1. 作为求职者，我希望系统能读取当前职位 JD，以便不只根据标题判断岗位是否合适。
2. 作为求职者，我希望系统能识别 Python 后端、Python 开发、数据工程、数据开发、ETL、爬虫、自动化、AI 应用、LLM 应用、Agent 开发、全栈开发等方向，以便优先投递目标岗位。
3. 作为求职者，我希望系统能识别日语翻译、本地化、字幕等方向，以便覆盖非技术但符合偏好的岗位。
4. 作为求职者，我希望系统偏好远程、线上、居家办公岗位，以便提高投递质量。
5. 作为求职者，我希望系统识别 Java/J2EE/Spring/SpringBoot/MyBatis 等 Attention Technology，并要求 LLM 解释它们是否属于核心要求，以免混入不符合目标方向的职位。
6. 作为求职者，我希望系统排除数据标注、信息录入、内容审核、运营跟播、客服、销售、主播、推广、无 Attention Technology 要求的 AI 岗，以免浪费投递机会。
7. 作为求职者，我希望系统根据职位类型选择对应开场白，以免向日语岗位发送 Python 后端文案。
8. 作为求职者，我希望系统能在开聊后尽快发送自定义文案和图片，而不是等整轮结束后再补发。
9. 作为求职者，我希望真实发送必须显式确认，以免调试时误投递。
10. 作为维护者，我希望 CLI 输出结构化 JSON，以便 Agent、脚本和测试稳定解析。
11. 作为维护者，我希望 LLM 调用复用软件里已经配置好的模型服务，以便不用在源码里硬编码密钥。
12. 作为维护者，我希望提交不包含本地配置、密钥、简历路径、cookie 或 localStorage，以便 fork 仓库可公开维护。
13. 作为维护者，我希望 CLI 可以独立 dry-run 测试 Recall Keyword 追踪、JD 匹配、预设任务，以便每次改策略后快速回归。
14. 作为维护者，我希望后续有审计日志记录每个职位为什么投、为什么跳过，以便复盘投递偏好。
15. 作为维护者，我希望后续 Agent 可以控制“下一个职位”和“立即沟通”，以便形成完整闭环。

---

## 4. Current Implementation

### 4.1 CLI 包

当前新增包为 `@geekgeekrun/job-agent-cli`，位于 `packages/job-agent-cli`。

主要模块：

| 模块 | 职责 |
|------|------|
| `bin/ggr.mjs` | 命令入口，解析参数，输出 JSON |
| `src/config.mjs` | 读取运行时配置、Recall Keyword、开场白规则、图片路径、浏览器状态、LLM 配置 |
| `src/job-profile.mjs` | 把 BOSS 页面数据、Vue 数据、文件输入归一化为 `JobProfile` |
| `src/policy.mjs` | 规则判断：硬排除、类别识别、Recall Keyword 追踪、JD 匹配、远程信号、开场白选择、预设任务 |
| `src/llm-evaluator.mjs` | 复用项目 OpenAI SDK 封装调用已配置模型，并解析 JSON 返回 |
| `src/browser-actions.mjs` | 打开浏览器、注入登录态、提取当前职位、向最近聊天发送消息和图片 |

### 4.2 当前验证结论

已验证：

1. `snapshot` 能读取 46 个 Recall Keyword、3 个开场白规则、简历图片状态、LLM 配置状态。
2. `run-once --from-browser` 能从真实 BOSS 当前职位提取 JD。
3. Python/数据开发/ETL 正例能判断为 `apply` 并输出预设任务。
4. 日语翻译远程正例能判断为 `apply` 并选择日语开场白。
5. Java/Spring/MyBatis JD 会被硬拒。
6. 数据标注等排除岗位会被硬拒。
7. “英语文案里出现翻译”不会再误判为日语岗位。
8. “线上线下活动”不会再误判为远程岗位。
9. `--llm` 能调用当前配置的大模型并解析结构化结果。
10. 默认 dry-run，不传 `--confirm` 不会真实发送。

---

## 5. Implementation Decisions

### 5.1 CLI 是 Agent 的唯一外部动作接口

Agent 不直接操作浏览器 DOM，也不直接读取运行时配置文件。Agent 调用 CLI，CLI 负责执行浏览器动作、读取配置和返回结构化 JSON。

### 5.2 规则判断先于 LLM

规则判断负责硬边界：

- 记录 Attention Technology 风险并要求 LLM 解释。
- 明确岗位类型排除。
- 配置正则约束。
- Recall Keyword 追踪和类别初筛。
- 开场白模板选择。

LLM 负责 JD 语义复核，但不能覆盖硬拒绝边界。

### 5.3 LLM 调用使用现有 OpenAI SDK 封装

不新增模型 SDK。继续复用项目中的 OpenAI SDK 兼容封装，从运行时 `llm.json` 读取启用配置。源码不硬编码 endpoint、api key 或模型名。

### 5.4 默认 dry-run

所有可能改变外部状态的命令默认只返回 `dryRun: true`。真实动作必须显式传入 `--confirm`。

### 5.5 JSON-first 输出

CLI 输出必须是稳定 JSON，便于 Agent 消费。错误也应返回：

```json
{
  "ok": false,
  "error": "message"
}
```

### 5.6 JobProfile 是主要数据契约

职位信息统一归一化为 `JobProfile`：

```json
{
  "jobId": "",
  "title": "",
  "company": "",
  "city": "",
  "salary": "",
  "experience": "",
  "degree": "",
  "labels": [],
  "jd": "",
  "recallKeyword": "",
  "bossName": "",
  "bossTitle": "",
  "raw": {}
}
```

### 5.7 预设任务是 Agent 计划契约

规则判断输出 `presetTasks`，让 Agent 明确下一步可执行动作：

```json
[
  { "type": "start_chat", "dryRun": true },
  { "type": "send_greeting", "template": "Python/后端/数据工程", "dryRun": true },
  { "type": "upload_resume_image", "dryRun": true },
  { "type": "audit_log", "dryRun": true }
]
```

---

## 6. CLI Contract

### 6.1 `snapshot`

用途：查看当前运行时配置摘要。

输出重点：

- `recallKeywordCount`
- `recallKeywords`
- `staticConditionCount`
- `combineRecommendJobFilterType`
- `rotateJobSourceAfterChatStartup`
- `greetingRules`
- `resumeImageConfigured`
- `llmConfigured`

### 6.2 `extract-job`

用途：提取职位信息。

输入：

- `--from-browser`
- `--job job.json`
- `--title`
- `--jd`
- `--recall-keyword`

输出：

- `profile`
- `raw`

### 6.3 `evaluate-job`

用途：规则判断职位是否投递。

输出：

- `decision`: `apply` | `skip` | `uncertain`
- `score`
- `category`
- `recallKeyword`
- `configuredRegex`
- `jdMatch`
- `remoteFit`
- `greetingTemplate`
- `presetTasks`
- `reasons`

### 6.4 `evaluate-job --llm`

用途：在规则判断基础上调用模型做 JD 复核。

要求：

- LLM 输入不应包含本地图片路径。
- LLM 输入不应包含完整开场白正文。
- 模型返回 Markdown fenced JSON 时必须兼容解析。

### 6.5 `send-greeting`

用途：对最近聊天发送对应开场白和图片。

边界：

- 默认 dry-run。
- 真实发送必须 `--confirm`。
- 当前能力仅面向最近聊天，不负责点击当前职位的“立即沟通”。

### 6.6 `run-once`

用途：执行一次“提取/读取职位 -> 判断 -> 输出任务 -> dry-run 发送计划”。

当前限制：

- `run-once --from-browser` 能读取当前职位并判断。
- `run-once --confirm` 还不能完成“当前职位合适 -> 点击立即沟通 -> 发送开场白图片”的完整闭环。

---

## 7. Matching Policy

### 7.1 目标方向

技术方向：

- Python 后端实习
- Python 开发实习
- 后端开发实习，但必须偏 Python 或接口/服务端方向
- 数据工程实习
- 数据开发实习
- ETL 实习
- 爬虫实习
- 自动化 Python
- AI 应用开发实习
- LLM 应用开发实习
- Agent 开发实习
- 全栈开发实习

语言/内容方向：

- 日语翻译
- 日文本地化
- 中日/日中翻译
- 字幕翻译
- 游戏本地化日语

工作方式偏好：

- 远程
- 线上
- 居家办公
- 不坐班

### 7.2 硬排除方向

- Java
- J2EE
- Spring / Spring Boot / SpringBoot
- MyBatis
- 信息录入
- 纯兼职
- 运营跟播
- 内容审核
- 销售
- 客服
- 主播
- 带货
- 推广
- 运营助理
- 数据标注
- AI 训练师
- 无 Attention Technology 要求的 AI 内容测评

### 7.3 已修正的误判

- “翻译”本身不能代表日语岗位，必须有日语相关信号。
- “线上线下”不能代表远程岗位。
- 多词 Recall Keyword 不能只命中“实习/远程/线上/兼职”等泛词，必须命中核心词。

---

## 8. Testing Decisions

测试应优先覆盖 CLI 外部行为，而不是内部函数细节。当前最高价值测试 seam 是 CLI 命令输出 JSON。

### 8.1 必测命令

1. `pnpm --filter @geekgeekrun/job-agent-cli check`
2. `node packages/job-agent-cli/bin/ggr.mjs snapshot`
3. `node packages/job-agent-cli/bin/ggr.mjs evaluate-job --title ... --jd ... --recall-keyword ...`
4. `node packages/job-agent-cli/bin/ggr.mjs run-once --title ... --jd ... --recall-keyword ...`
5. `node packages/job-agent-cli/bin/ggr.mjs evaluate-job --llm ...`
6. `node packages/job-agent-cli/bin/ggr.mjs run-once --from-browser`

### 8.2 固定样例

正例：

- Python 后端实习生，JD 含 Python / FastAPI / 接口 / 远程。
- 数据开发实习生，JD 含 Python / ETL / 数据仓库。
- 日语翻译远程兼职，JD 含 中日翻译 / 本地化 / 字幕 / 远程。

反例：

- Java 后端实习生，JD 含 Spring Boot / MyBatis。
- 数据标注兼职。
- 英语文案/移民文案，JD 含翻译但不含日语信号。
- 客户成功/客服专员。
- 线上线下活动协助，不应判定为远程。

### 8.3 安全检查

提交前必须扫描：

- API key
- 本地用户路径
- 模型 endpoint
- 简历文件名
- cookie/localStorage
- 个人开场白正文

---

## 9. Next Plan

### Phase 1：补齐投递闭环 CLI

目标：当前职位合适时，能完成“立即沟通 -> 发送对应开场白 -> 上传图片”。

新增命令建议：

| 命令 | 作用 |
|------|------|
| `start-chat --from-browser --confirm` | 点击当前职位的“立即沟通”，进入最近聊天 |
| `next-job --confirm` | 切换到职位列表下一条 |
| `audit-log` | 写入本轮职位判断和动作结果 |

注意：

- `start-chat` 也必须默认 dry-run。
- 真实点击必须检测当前职位和判断结果一致，避免对错职位开聊。
- 开聊后应立即发送文案和图片，再进入下一个职位。

### Phase 2：Agent loop

目标：把 CLI 组织为一次受控投递任务。

建议流程：

```
for each job in current list:
  extract-job --from-browser
  evaluate-job
  if decision == uncertain:
    evaluate-job --llm
  if final decision == apply:
    start-chat --confirm
    send-greeting --confirm
    audit-log
  else:
    audit-log
  next-job --confirm
```

### Phase 3：审计与偏好学习

目标：持续记录投递行为，后续基于历史投递优化偏好。

记录字段：

- runId
- timestamp
- jobId
- title
- company
- city
- salary
- experience
- degree
- recallKeyword
- category
- decision
- score
- reasons
- llmEvaluation
- greetingTemplate
- actions
- errors

### Phase 4：配置化策略

目标：把硬编码策略逐步迁移为配置或 profile。

可配置项：

- 目标方向
- 排除方向
- 远程偏好
- 类别到开场白的映射
- LLM 复核阈值
- 每轮投递上限
- 同公司/同岗位去重规则

### Phase 5：UI 集成

目标：让桌面应用能启动 Agent 模式，并展示每个职位的判断结果。

界面建议：

- Agent 模式开关
- dry-run / confirm 模式
- 本轮上限
- 实时日志
- apply / skip / uncertain 列表
- 每条职位的 JD 摘要、规则原因、LLM 结论、最终动作

---

## 10. Out of Scope

当前 PRD 不包含：

1. 绕过平台风控或规避平台限制的新增能力。
2. 无限制批量投递。
3. 自动修改用户简历。
4. 自动生成虚假经历或夸大匹配度。
5. 多平台投递。
6. 招聘端候选人筛选功能改造。
7. 桌面 UI 重设计。

---

## 11. Open Questions

1. `start-chat` 应复用现有求职端核心自动开聊逻辑，还是在 CLI 中直接实现当前职位点击？
2. 审计日志写 SQLite 还是先写 JSONL？
3. LLM 的最终决策权如何分配：硬规则永远优先，LLM 只允许从 `apply` 降到 `uncertain/skip`，还是可从 `uncertain` 升为 `apply`？
4. 每轮真实投递默认上限是多少更合适？
5. 遇到验证码、登录失效、今日沟通上限时，Agent 应立即停止还是进入人工确认状态？

---

## 12. Current Status

已完成：

- CLI 包创建。
- 运行时配置读取。
- 当前职位 JD 提取。
- 规则判断。
- LLM 判断。
- 开场白选择。
- 图片发送 dry-run/confirm 边界。
- pnpm 11 配置迁移。
- 敏感信息提交扫描。

待完成：

- 当前职位点击立即沟通 CLI。
- 切换下一职位 CLI。
- 审计日志。
- 完整 Agent loop。
- UI 入口。
