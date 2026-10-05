# OpenRouter 公开版迁移与验证

日期：2026-10-05。只修改 GitHub 公开发布分支，本机正在运行的应用及其私有配置不变。

## 改动

- AI 接入 OpenRouter Chat Completions，环境变量 `OPENROUTER_API_KEY`、`OPENROUTER_BASE_URL`，默认 `https://openrouter.ai/api/v1`。
- 仅允许官方 HTTPS 目标，不向其它域名或带凭证/查询参数的地址发送 Key。
- 使用完整 `vendor/model` ID；JSON 对象、严格 Schema 和提示词 JSON 模式保留本地校验。
- 推理默认使用模型设置；可选关闭请求使用统一 `reasoning.enabled=false`，不继续发送历史供应商的 thinking 字段。
- README、配置示例、界面文案与协议测试同步更新。历史联调报告改为中性描述并明确来源边界，没有把旧测试改称 OpenRouter 实测。
- README 展示实际运行的首页截图；截图采用以前真实采集的公开单条样本，避开设置、密钥和邮箱，不作为新平台联调证据。

## 技术依据

Context7 MCP `/openrouterteam/docs` 核对 Chat Completions、JSON 输出和统一 reasoning；安装版本 Next.js 16.3.8 的 Server/Client Components 文档核对服务端凭证边界。

- https://openrouter.ai/docs/quickstart
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

## 验证边界

协议、预算、引用、队列及业务回归使用独立临时 SQLite 和模拟上游；不会写本机正式数据库。生产构建和页面展示另行检查。当前无 OpenRouter 账户凭证，不进行真实上游调用；部署者需要用自己的 Key、模型与输出能力完成连接测试。

实际验证：120 项 Vitest 回归通过，Next.js 16.3.8 webpack 生产构建和 TypeScript 检查通过。生产页面截图时控制台无错误/警告；后台未启动，无新增上游调用或邮件。图片位于 `docs/images/home-desktop.jpg`，已检查只含公开样本与页面控件。
