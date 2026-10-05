# MCP 技术依据与 API 接入

检索日期：2026-10-03（Asia/Shanghai）。优先 Context7 MCP resolve_library_id → query_docs；缺失产品或需要当前官网资料时使用 Firecrawl MCP 官方页面 scrape。索引中的 main/canary 示例需与实际安装的稳定版本核对，检索日期不代表每份索引都绝对最新。以下为实现采用的依据。

## OpenRouter（当前公开版）

2026-10-05 通过 Context7 `/openrouterteam/docs` 核对标准 Chat Completions 端点 `https://openrouter.ai/api/v1/chat/completions`、Bearer 鉴权、完整模型 ID、JSON 对象/Schema 输出及统一 `reasoning` 参数。公开版改用 `OPENROUTER_API_KEY` 和 `OPENROUTER_BASE_URL`；不发送用于平台排名的可选请求头。

- https://openrouter.ai/docs/quickstart
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

模型参数能力各异；默认使用模型推理设置。关闭推理采用 `reasoning: {enabled: false}`，强制推理的模型可能拒绝。文档依据和模拟测试不替代真实账户验证；本次没有 OpenRouter Key，未发起真实请求。详见 [公开版迁移验证](openrouter-publication.md)。

下方日期较早的真实 AI 测试来自历史本机兼容服务，不是 OpenRouter 联调记录。

## X / twitterapi.io（必需可用渠道）

Firecrawl MCP 阅读官方资料：

- https://docs.twitterapi.io/authentication
- https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search
- https://docs.twitterapi.io/api-reference/endpoint/get_trends

GET https://api.twitterapi.io/twitter/tweet/advanced_search；请求头 X-API-Key；参数 query、queryType=Latest、cursor。返回 tweets、has_next_page、next_cursor。当前文档支持 since_time / until_time 的 Unix 秒写法，明确不支持旧的 since:日期_UTC。

每页可能短于 20 条，因此依据 has_next_page 继续，不能以条数判定终止。采用固定扫描窗口、有限预算和恢复游标；每页先保存，再请求下一页；无效游标停止并保留有效恢复状态。retweeted_tweet / quoted_tweet 类型不固定，防御性处理，不把转发当独立证据。

地区 trends 接口需要 woeid，不能直接充当“AI 编程”领域榜；首版不依赖地区榜。时间边界、索引延迟、配额和真实分页仍需账户联调。

## Next.js / React / Tailwind

Context7：`/vercel/next.js`、`/tailwindlabs/tailwindcss.com`。通过 MCP 官方资料并结合 npm registry 确定稳定 Next.js 16.3.8，已安装同版本。Next 自带 node_modules/next/dist/docs 的 Route Handlers、环境和图标指南用于匹配安装版本。

采用 App Router Route Handlers，Node.js runtime，await params；API GET 返回 no-store。服务端读取环境变量，worker 使用 @next/env 独立加载。实际 ESM 使用默认导入，Drizzle 配置通过 createRequire 读取，类型检查与迁移 CLI 验证过模块互操作。

Tailwind v4 使用 @tailwindcss/postcss 和 CSS @import，不采用旧版 init 流程。

官方来源：

- https://nextjs.org/docs/app/api-reference/file-conventions/route
- https://nextjs.org/docs/app/guides/environment-variables
- https://nextjs.org/docs/app/getting-started/installation
- https://tailwindcss.com/docs/installation/using-postcss

## SQLite / Drizzle

Context7：`/drizzle-team/drizzle-orm-docs`。better-sqlite3 驱动、migrate、事务、upsert 和返回更新记录用于持久化和任务领取。数据库启用 WAL、外键、busy timeout。drizzle-kit 生成迁移，包中旧 esbuild 的开发依赖通过局部 override 修复后，重新验证 generate / migrate，npm audit 当前为 0。

- https://orm.drizzle.team/docs/get-started-sqlite
- https://orm.drizzle.team/docs/migrations
- https://orm.drizzle.team/docs/transactions

## SMTP / Nodemailer

Context7：`/nodemailer/nodemailer`，官方仓库 API 文档。

createTransport、verify、sendMail；465 secure=true，587 secure=false + STARTTLS。保留 TLS 证书校验，检查 accepted 是否包含实际目标地址。verify 成功不表示邮件最终送达，SMTP 接受也不等于进收件箱。临时错误有限重试，认证及永久错误终止自动重试。

- https://nodemailer.com/smtp
- https://nodemailer.com/usage
- https://github.com/nodemailer/nodemailer

## HN / GitHub / RSS / 验证工具

在 Context7 查询限额或无适合索引时，通过 Firecrawl MCP 阅读官方资料，实际版本见 package-lock.json。

- https://hn.algolia.com/api ：search_by_date、story、numericFilters 与分页；正文只取返回 story_text。
- https://docs.github.com/en/rest/search/search?apiVersion=2026-03-10#search-repositories ：仓库搜索、更新时间排序、有限结果；X-GitHub-Api-Version=2026-03-10。
- https://github.com/NaturalIntelligence/fast-xml-parser ：RSS/Atom XML 解析，关闭实体扩展。
- https://zod.dev/ ：运行时结构校验。
- https://vitest.dev/guide/ ：业务测试；独立临时 SQLite 数据库，API 响应使用显式模拟。
- Playwright 按本机技能 CLI 操作实际浏览器，避免只以构建代替交互验证。

Google 旧订阅地址实际返回 301，已使用其重定向目标 https://blog.google/innovation-and-ai/technology/ai/rss/。预置 Hugging Face https://huggingface.co/blog/feed.xml。已进行真实网络与 XML 解析验证；近期窗口没有内容时允许合法空结果。

## Node 网络代理

RSS 联调发现 curl 成功、Node fetch 超时，确认本机代理环境已存在，但 fetch 没有启用对应能力。通过 Context7 `/websites/nodejs_latest-v24_x_api` 查询官方 CLI / HTTP 文档，核实 --use-env-proxy 和 NODE_USE_ENV_PROXY 的启动行为。使用 --use-env-proxy 启动 Web、worker，继承 HTTP_PROXY、HTTPS_PROXY、NO_PROXY；不关闭 TLS。项目明确使用已验证的 Node 24.16+。

- https://nodejs.org/docs/latest-v24.x/api/cli.html#--use-env-proxy
- https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support

## 历史本机 AI 验证

早期私有配置曾遇到 Chat Completions 协议权限不匹配以及模型不支持严格 JSON Schema 的问题；未伪装客户端或放宽校验。后续在当时可用模型的 JSON 对象模式完成真实小样本验证。公开版不沿用其供应商地址、模型 ID 或专用 thinking 字段，也不把这些旧结果算作 OpenRouter 已验证。历史样本范围见 [连接测试记录](connection-test-2026-10-04.md)。

## 2026-10-05 分阶段分析

通过 Context7 MCP `/drizzle-team/drizzle-orm-docs` 核对 SQLite immediate 事务、索引、upsert 和增量迁移；新增阶段队列及调用审计使用同步 better-sqlite3 事务，不在事务内等待网络。

通过 Context7 `/llmstxt/twitterapi_io_llms_txt` 核对 Advanced Search 分页和 `GET /twitter/tweets?tweet_ids=` 父帖查询；通过 `/websites/serpapi` 核对 Google start / Bing first 分页差异。分页和根帖恢复主要由独立数据库回归验证，不能把模拟响应当真实外部联调。

历史兼容服务 在 Context7 无匹配库，经 Firecrawl MCP 重读官方 历史兼容服务文档（不再作为当前协议依据），确认 OpenAI 兼容地址加 `/v1`；该页不证明具体模型的输出模式兼容性。通过 Context7 `/websites/api-docs_deepseek` 重新核对 JSON Output 的 json_object、提示词 JSON 和 max_tokens 截断边界：https://api-docs.deepseek.com/guides/json_mode 。本轮先不假定 thinking / reasoning_effort 兼容；随后在 历史兼容服务 的 deepseek-v4-pro 真实请求中验证 `thinking: {type: "disabled"}`，该字段仅用于精确匹配的这个模型及 screen/deep 阶段。其他模型保持原配置，不新增未经验证的 reasoning_effort。

真实测试发现临时库未继承 UI 保存的 json_object 配置，旧、新分析都 HTTP 400；复制已有已验证模型/模式后复测。不静默降级正式库的模式，不放宽本地校验。Next 16.3.8 的 Route Handlers 和 Server/Client Components 指南从本机安装包读取，API 使用异步 params，交互组件保持客户端边界。


通过 Context7 MCP `/colinhacks/zod` 核对 Zod 4 动态 enum、strict object、extend 与 z.toJSONSchema。引用锚点是本项目实现：输入服务器生成的连续短原文片段，输出动态允许的 quoteId，再在本地验证 articleId 归属和逐项引用集合。此协议在 历史兼容服务 json_object 模式下真实通过；并不意味着供应商支持严格 json_schema，也不证明引用内容的语义绝对真实。结果、费用与模型兼容边界见 [V2 验收记录](analysis-pipeline-v2-validation-2026-10-05.md)。

## 2026-10-05 X 精选账号、互动复查与筛选

Context7 MCP `/websites/twitterapi_io_api-reference` 核对 Advanced Search 的 `query`、`Latest`、Unix 秒与分页结构；批量互动复查使用 `GET /twitter/tweets?tweet_ids=id1,id2`。账号组合查询 `(from:handle1 OR from:handle2 ...)` 通过本轮真实联调返回 steipete、simonw、cline 三个预置账号的记录；这是有限页样本，不证明其余账号当时也有发帖或全部采集完成。

- https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search
- https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids

`author.isBlueVerified`、`verifiedType` 和 `followers` 按返回可选字段记录；蓝 V 代表认证标签，不能证明领域权威。八个账号与官网/仓库链接经 Firecrawl MCP 读取核对；个人身份与发言真实性分别处理。

本轮连续请求实际发生 HTTP 429。Context7 文档未提供当前用户套餐的确定 QPS，Firecrawl 官方介绍页也未提供试用套餐限制；首页仅宣传默认高 QPS，不能用它推断本账户额度。实现采用本机共享 6 秒时间槽及可调环境变量，在第二轮真实调用中账号搜索、关键词搜索与批量详情全部返回成功。仍保留供应商限流、缺失记录、预算耗尽及继续分页状态，不无界重试。

Next 的 `distDir` 经 Context7 `/vercel/next.js` 核对，并读取安装版本 `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/distDir.md`。验收使用独立专用构建目录，避免覆盖原有运行中的构建产物。Context7 canary 的额外说明不作为已安装版本行为保证。

新增 `GET /api/events?filters=<URL编码JSON>&page=1`，所有筛选经 Zod 校验，服务端从完整事件库筛选再分页；返回 `{items,total,page,pageSize}`。`filters` 字段定义见 `src/shared/feed.ts`。`GET /api/dashboard` 新增 `xUsage`；`PUT /api/settings` 支持 X 名单、日月预算与单轮额度，账号依据链接须为公开 HTTPS；名单重复校验不区分大小写。名单人工分类不自动添加可信证据，可信目录仍独立管理。

## 2026-10-05 首页数据同步

Context7 MCP `/reactjs/react.dev` 查询 useEffect 的定时器清理和异步响应竞态处理，使用 AbortController 及已取消判断。安装的 Next 16.3.8 文档 `node_modules/next/dist/docs/01-app/02-guides/client-side-data-fetching/index.md` 与 Server/Client Components 指南核对客户端交互边界。继续使用本机 no-store GET，不新增缓存库或外部服务调用。

Dashboard 新增 `pipeline.activity`，从所有未完成任务计算当前有效租约和队列状态，不使用有限的最近审计列表推断运行情况。`POST /api/monitors/:id/scan` 行为保持采集与显式分析一起排队，返回文字改为情报更新流程。浏览器与隔离测试边界见 [首页验收](home-ux-validation-2026-10-05.md)。
