<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 项目约束

- 所有源码和文档使用 UTF-8 编码。
- 禁止递归删除、批量删除、清空目录及删除项目、系统、用户目录。禁止 rm -rf、rm -r、git clean -fd、git clean -fdx、find -delete、通配符删除和等价写法。
- 如需删除，只能一次删除一个用户明确指定的完整路径普通文件。
- Shell 命令遵循 ~/.codex/RTK.md，使用 rtk 前缀。
- 技术文档必须通过 MCP 优先查询 Context7；缺失时通过 Firecrawl MCP 查官方资料并注明验证边界。
- 当前 AI 供应商是 OpenRouter，X 使用 twitterapi.io，默认扫描间隔 30 分钟，支持站内通知和邮件。
- 完成 Web 真实联调并获得用户验收后，再开发本项目 Agent Skill。
- 不输出凭证；业务测试使用独立临时数据库；不得伪造页面热点或将模拟测试当真实外部联调。
