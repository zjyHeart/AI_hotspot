# 真实连接测试记录

> 历史本机版记录：以下实际 AI 调用来自当时的兼容服务，不能作为公开版 OpenRouter 真实联调的证明。当前对接见 [OpenRouter 发布版说明](openrouter-publication.md)。

日期：2026-10-04（Asia/Shanghai）。用户授权测试已配置服务；本次使用实际服务请求，不使用模拟数据，不记录凭证或邮箱地址。

## 首轮结果（已被后续 AI 重测更新）

| 项目 | 实际请求与结果 | 验证边界 |
| --- | --- | --- |
| Web | 本机开发服务启动，GET /api/dashboard 返回 200 | 配置状态仅表示字段存在，不代表外部连接通过 |
| X / twitterapi.io | POST /api/connections/x 返回 200；AI 关键词的真实 Latest 搜索返回 20 条推文 | 消耗真实 API 额度；不等于完整扫描与分页验证 |
| QQ SMTP | POST /api/connections/email 返回 200；verify 通过，sendMail 的 accepted 包含目标地址 | 测试邮件标题为 [Signal Desk] 邮件连接测试；用户尚需检查实际收件箱或垃圾邮件 |
| 历史兼容 AI 服务 | POST /api/connections/ai 返回 502；上游 Chat Completions 返回 400 | 未通过，尚未生成 AI 热点 |

## 首轮 AI 失败诊断

1. 生效模型为 gpt-5.6-sol，API 地址为 历史私有接口（不再作为公开版配置），输出模式为 json_schema。
2. 上游错误码为 protocol_not_supported，明确表示模型不支持 chat completions 协议。不是由本次证据确认的 JSON Schema 参数错误。
3. GET /v1/models 返回 200，当前令牌的模型均标记仅支持 openai-response。
4. 独立 POST /v1/responses 请求返回 403，服务商要求使用标准 Codex 客户端。因此只增加 Responses 适配仍不足以证明当前令牌可供本项目使用，未修改协议实现或伪装客户端。
5. 下一步：用户创建允许第三方调用 Chat Completions 的令牌，填写该分组的实际可用模型，再重启 Web 和 worker，重新测试 AI 连接及完整真实扫描。

## 首轮业务状态

检查时两个验收监控仍暂停，121 条真实原始内容待分析，通知数量为 0。没有为本次测试创建模拟热点、开启监控或修改用户凭证。

## 文档依据

Context7 优先查询 历史兼容 AI 服务，无匹配库；随后 Firecrawl MCP 核对 历史兼容服务 官方文档。协议结构经 Context7 的 OpenAI API Reference 查询，实际服务能力以上游请求结果为准。


先前 32 项模拟业务测试与构建结果见 acceptance.md，本次没有重复执行，不能代替此次真实账户联调。

## 用户更新配置后的重测

Web 和正式 worker 已重启。生效模型为 deepseek-v4-pro，地址仍为 历史私有接口（不再作为公开版配置）。该模型的真实响应拒绝 json_schema 参数，错误为 `This response_format type is unavailable now`。通过 Context7 查询 DeepSeek 官方 JSON Output 文档后，先在独立内存数据库使用 json_object 实测成功，再保存正式工作台输出模式为 json_object。项目继续使用本地结构校验和原文逐字引用校验，没有放宽业务验证。

正式 POST /api/connections/ai 返回 200，响应为 历史兼容 AI 服务 连接正常，json_object 模式返回 JSON 并通过本地校验。本次没有重复发送 SMTP 测试邮件。

## 独立数据库中的真实采集与分析

隔离数据库中的监控复制自原有 AI 编程监控，保留原始创建时间与筛选规则；测试预算为每轮 X 最多 1 页、AI 批次 3 条。使用真实外部请求，未模拟来源、AI 输出或证据，未开启正式频道。

| 来源 | 本轮保存条数 | 结果与边界 |
| --- | --- | --- |
| X | 20 | partial：达到测试 1 页预算，保留续采游标，尚未验证整段窗口覆盖 |
| HN | 6 | ok |
| RSS | 1 | ok |
| GitHub | 50 | partial：近期更新检索与有限条数，不代表完整发布榜 |

数据库实际计数为 77 条原始内容。AI 分析 3 条，生成 3 个事件，使用 3010 tokens；本地 Schema 与逐字引用校验通过，扫描 error=null。剩余 74 条未分析，未将有限批次描述为全部完成。

| 事件 | 来源与原文链接 | 证据状态 |
| --- | --- | --- |
| Osier 工具追踪 AI 编码代理表现 | https://news.ycombinator.com/item?id=49954178 | 待核实 |
| Gentle AI 推出 AI 编码生态系统 | https://news.ycombinator.com/item?id=49950595 | 待核实 |
| 16agents 项目为 AI 编码代理提供 MBTI 人格测试与自我意识评分 | https://news.ycombinator.com/item?id=49951064 | 待核实 |

事件名称为模型生成的候选摘要，不代表外部事实已获独立核实。三个事件均未达到当前提醒的证据要求，通知数为 0，未投递业务热点邮件。SMTP 接受测试邮件和符合条件业务事件的真实投递仍是不同验证项。

正式 Web http://127.0.0.1:3000 与 worker 在线，正式数据库未写入本轮测试事件。隔离生产验收页面 http://127.0.0.1:3001 与其 worker 在线，主页和 dashboard 均返回 200，页面 API 读取到 3 个真实候选事件。监控保持暂停。

机器可读报告：[live-connect-2026-10-04.json](../output/verification/live-connect-2026-10-04.json)。仍需用户确认测试邮件实际收到，以及页面、事件详情和引用的验收结果。

补充文档来源：Context7 `/websites/api-docs_deepseek`，https://api-docs.deepseek.com/guides/json_mode 与 https://api-docs.deepseek.com/api/create-chat-completion。
