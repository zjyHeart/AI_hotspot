# 本机 API 与命令

脚本仅依赖 Python 3.9+ 标准库；JSON 为 UTF-8，成功输出 JSON 到 stdout，错误到 stderr 并返回退出码 1。全局参数 `--base-url`、`--timeout` 放在子命令前。默认超时 15 秒，无自动重试、无自动轮询，不加载 `.env`。

## 命令映射

| 命令 | 已有接口 | 效果 |
| --- | --- | --- |
| `status` | GET `/api/dashboard` | 心跳、真实队列、来源统计和预算；不输出完整设置/原始材料 |
| `monitors` | GET `/api/dashboard` | 频道列表及完整频道配置 |
| `notifications` | GET `/api/dashboard` | 最近最多 200 条站内通知；不是完整历史 |
| `jobs` | GET `/api/dashboard` | 最近最多 20 条分析任务审计，用于查任务 ID、阶段及错误；不是完整队列 |
| `events --filters JSON --page N` | GET `/api/events` | 完整事件库先筛选后分页，每页 30 条 |
| `event ID` | GET `/api/events/:id` | 详情与引用原文 |
| `create-monitor --file PATH` | POST `/api/monitors` | 新建，封装默认 `active=false` |
| `edit-monitor ID --file PATH` | PUT `/api/monitors/:id` | 读取原配置后合并部分修改；quality 按字段合并 |
| `set-active ID --active / --paused` | PATCH `/api/monitors/:id` | 开启或暂停定时采集；开启可能消耗上游额度 |
| `update ID` | POST `/api/monitors/:id/scan` | 采集与显式分析排队；不启用暂停频道的定时任务 |
| `analyze ID` | POST `/api/monitors/:id/analyze` | 仅分析已有材料排队，不重新搜索；深度任务仍可能补查 |
| `retry-job ID` | POST `/api/analysis/:id/retry` | 指定任务重新排队 |
| `feedback ID --verdict VALUE` | POST `/api/events/:id/feedback` | `valuable/irrelevant/duplicate/insufficient`，不改变事实可信状态 |
| `read-notification ID` | POST `/api/notifications/:id/read` | 标记已读；不发送邮件 |

`update/analyze/retry-job` 先检查 worker 心跳；离线时不 POST。心跳在线不保证该请求马上完成。`status.pipeline.activity` 是有效租约和当前队列，最近任务审计是有限列表；不要用有限审计列表推断整个后台。

## 筛选示例

```sh
python3 scripts/signal_desk.py --base-url http://127.0.0.1:3000 events --filters '{"query":"Agent","sources":["x","github"],"credibility":"supported","hours":"168","sort":"recommended"}'
python3 scripts/signal_desk.py --base-url http://127.0.0.1:3000 events --filters '{"monitorIds":["实际频道ID"],"hours":"all","sort":"discovery"}' --page 1
```

相对脚本路径示例从 Skill 根目录执行；其它目录请使用绝对脚本路径。频道、事件及任务 ID 从实际响应读取，不用频道名代替 ID。

| FeedFilters 字段 | 可选值 / 默认 |
| --- | --- |
| `query` | 标题和摘要的子串，默认空；最多 200 字符 |
| `sources` | `x/hn/github/rss/google/bing` 的数组，默认全部 |
| `monitorIds` | ID 数组，默认全部 |
| `credibility` | `all/supported/corroborated/unverified/disputed`；默认 all |
| `importance` | `all/urgent/high/medium/low/unassessed`；默认 all |
| `accountScope` | `all/curated/official`；默认 all |
| `engagement` | `all/standard/strict/custom`；默认 all |
| `minLikes/minReposts/minReplies` | 自定义互动阈值，默认 10/3/5；任意一个满足即可 |
| `minRelevance` | 0–100，默认 0；仍受频道阈值和全局信息价值阈值影响 |
| `hours` | 字符串 `1/6/24/168/all`；默认 `24` |
| `timeField` | `discovery/publication`；默认 discovery |
| `sort` | `recommended/importance/relevance/heat/publication/discovery` |

同维度 OR、跨维度 AND。限时发布时间筛选排除未知发布时间，发布排序把未知放最后；“全部时间”仍会执行质量与价值规则，不等于原始数据库全集。

## 创建和编辑频道

从 [../assets/ai-coding-monitor.json](../assets/ai-coding-monitor.json) 创建暂停的专题频道：

```sh
python3 scripts/signal_desk.py create-monitor --file assets/ai-coding-monitor.json
```

创建允许 `name/kind/keywords/aliases/excludes/sources/rssUrls/intervalMinutes/minRelevance/notifyUnverified/cooldownMinutes/active/quality`。必须填写名称、`kind` (`keyword/topic`)、关键词及至少一个来源；其它由现有 API 验证和补默认值。`quality` 支持互动模式、精选名单、关注/屏蔽账号、观察期、网页间隔及仓库列表，完整 Schema 在项目 `src/shared/types.ts`。

编辑文件可以只包含 `{"intervalMinutes":60}` 或 `{"quality":{"engagementMode":"strict"}}`。客户端读取现有频道后合并，不发送数据库内部字段。列表数组整体替换；服务端正在扫描时返回 409。此 API 没有编辑版本锁，避免与网页同时保存同一频道。

创建不会自动扫描暂停频道。明确要求更新时使用 `update`；明确要求定时运行时用 `set-active --active`。Web 和 worker 必须使用同一数据库，Skill 本身不提供定时器。

技术依据：2026-10-05 经 Context7 `/python/cpython` 核对 urllib.request 的 JSON Request、超时、ProxyHandler 和 HTTPRedirectHandler；接口以项目 Route Handler 和共享 Schema 为准。没有新的上游协议或凭证。
