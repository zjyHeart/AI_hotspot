# 信息源可靠性改进：实施与验收记录

日期：2026-10-05（Asia/Shanghai）。 后续更新：用户已配置SerpAPI，Google/Bing真实联调完成，结果与当前预览状态见[SerpAPI专项记录](serpapi-validation-2026-10-05.md)。以下保留当时尚缺Key的历史验证边界。用户已确认方案，本轮完成代码、迁移、自动化验证和可用的真实来源联调，等待页面验收。Google/Bing 缺少本机 `SERPAPI_API_KEY`，用户明确选择稍后配置，因此不能把适配器测试描述为真实搜索账户联调。代码尚未提交 Git。

## 已实现

- X 双层过滤：查询排除回复与原生转发，本地检查 isReply / inReplyToId / retweeted_tweet；默认普通帖子点赞20或转发5，关注或可追溯原文可作为线索。缺少类型字段保守处理，过滤理由按频道持久化。
- Google/Bing 独立适配，共用 SerpAPI Key；基础采集30分钟、网页默认240分钟。全局默认搜索30次/天、900次/自然月、补查6次/天；事务预留、持久化、缓存和退避生效。补查计入总预算。
- 四个官方 RSS，HN / X 外链原文与 GitHub Releases。正文最多每频道每轮6个URL，并发2，常规与补查共享限额。全文、摘要、失败、未知日期分开展示；不同版本参数和未经读取的 canonical 不盲目合并。
- URL / 完全同文去重，保留跨渠道发现路径；同发布者、同原文、近乎逐字转载不增加独立证据。正文最终地址决定身份，跨域跳转不会继承旧官网身份。
- 来源轮转与等待时间排序，其他合格来源积压时限制 X 占比；额度不足跨轮轮转。待处理记录及过滤审计保留，不自动删除；本轮处理规模有限，持久存储仍会随使用增长。
- 可编辑发布者目录、关注/屏蔽账号、网页频率、关注仓库与搜索预算。关注名单不等同可信身份。策略和身份目录变化会重评历史候选；未扫描的旧频道在下一轮更新过滤审计，历史事件不会自动重发提醒。
- 两个增量迁移，旧库首次应用可靠性字段前通过 VACUUM INTO 自动备份。正式 `data/hotspot.db` 未用于业务测试或本轮验收预览。

## 自动化与本机验证

| 检查 | 结果与边界 |
| --- | --- |
| Vitest | 3个测试文件、71项通过；显式模拟外部响应，独立临时SQLite，不能等同真实API |
| TypeScript / production build | typecheck、Next16.3.8生产构建均通过 |
| 数据库升级 | 使用旧迁移初始化临时库；验证备份仍为旧结构，UTF-8旧数据保留，新字段增量添加 |
| HTTP实际分支 | 模拟 Undici request 的真实传输分支，验证重定向/错误流关闭、公开IP代理固定、Host、凭证隔离与大小限制 |
| API缺Key状态 | Google/Bing连接测试各返回400和明确的SERPAPI_API_KEY未配置说明；未消耗搜索额度 |
| 依赖与差异 | npm audit --omit=dev：0 vulnerabilities；git diff --check通过 |
| 浏览器 | 5个主页面 × 375/768/1024/1440宽度，scrollWidth等于viewport；新浏览器console 0 errors / 0 warnings |
| 表单 | 暂停验收频道：多账号连续输入、Google/Bing勾选、网页频率30分钟保存后API读取一致；全局预算29→30保存，目录10项保留 |
| 手机弹窗 | 对话框clientWidth/scrollWidth均339，焦点在弹窗内，Escape可关闭；已视觉检查 |

测试覆盖回复、转发、未知类型、低互动、名单、推广内容；预算共享/并发/缓存/自然月计数；正文日期、跨域与同域canonical、HTML/PDF、SSRF及跳转；原文复用、转载独立性、失效引用；来源公平、部分失败继续、过滤后恢复、迁移备份与历史通知去重。SMTP仍沿用原有投递与有限重试测试，本轮未发送测试或业务邮件。

## 真实外部联调

所有来源数据来自实际网络响应。仅使用新建临时数据库；复用此前真实采集的X候选进行最后一轮分析，减少重复调用，不用模拟材料填充页面。

| 来源 | 实际结果 |
| --- | --- |
| twitterapi.io | 单页20条，保留6条，过滤14条（互动不足且无可追溯原文）；样本中isReply均false，查询排除回复；有续页所以为partial，不承诺完整覆盖 |
| Hacker News | 31条、3次请求；达到每查询单页预算，有限样本，讨论仍标待核实 |
| RSS近7天逐源复测 | Hugging Face7条、Google AI2条、GitHub Blog5条、DeepMind2条，四个分别成功 |
| RSS综合扫描 | 近24小时1条；其中一次DeepMind返回Pi Tag解析失败，记录partial、不推进成功边界；随后上述逐源复测成功 |
| GitHub Releases | vercel/next.js近7天返回10条实际Release，包含明确标注的预发布；增量扫描窗口为空不伪造发布 |
| HTML原文 | Hugging Face ThinkingBox全文提取与发布时间成功；X外链JetBrains正文成功但日期未知；某HN外链无可提取正文，失败状态保留 |
| PackyAPI | deepseek-v4-pro/json_object，最后批次6条、4个事件、8179 tokens；结构和逐字引用通过本地校验 |
| Google/Bing | 缺Key，真实账户联调未执行；协议、缓存、预算与错误分支模拟测试通过 |
| 通知 | 最后真实批次0条新通知：材料为历史基线/未满足提醒条件；未发送历史邮件 |

最后4个事件中：ThinkingBox由官方全文支持其发布声明，状态为“有来源支持”；讨论、未知身份或缺正文的其余3个为“待核实”。来源身份支持具体发布声明，不代表宣传性能已获独立验证。JetBrains原文日期未知，未冒充刚发布。

原始机器记录：[live-result.json](../output/reliability/live-result.json)。该文件及截图为本机生成产物，不纳入Git。调试中遇到Undici8与Node内置fetch handler不兼容、网络需要代理，以及重定向响应流关闭问题；均已修复，并加入实际传输分支回归。失败扫描保留“中断”审计，不清理历史痕迹。

## 验收入口与待验证边界

验收预览：http://127.0.0.1:3001/ 。使用独立临时真实数据，所有频道暂停，未启动worker。可查看当前事件、引用、全文/摘要/失败标记、筛选设置与采集诊断；不会自动产生新扫描费用。正式数据未迁移、未启用新采集任务。

1. 在情报总览查看ThinkingBox官方全文与“有来源支持”的边界说明，检查待核实事件的具体缺口。
2. 编辑频道，展开“信息质量与多源设置”，验收回复过滤、账号列表、GitHub仓库及独立网页频率。
3. 在扫描记录检查过滤计数、各渠道待处理任务与实际失败；在设置查看预算、发布者目录及未配置Google/Bing状态。
4. 用户稍后配置`.env.local`中的SERPAPI_API_KEY并重启Web/worker后，还需分别真实测试Google/Bing搜索及搜索原文；目前不能确认账户额度、搜索覆盖率或账单。

动态/登录/非HTML页面可能提取失败；近乎逐字转载能保守归组，语义相近但文字不同的共同来源仍可能漏识别。目录及AI角色判断需要人工核对，系统不保证事实真实性或完整热点覆盖。Agent Skill未开发，继续遵守Web验收后再开发的约定。

截图：[桌面诊断](../output/playwright/reliability-runs-1440.png)、[手机设置](../output/playwright/reliability-settings-375.png)、[手机质量配置](../output/playwright/reliability-quality-mobile.png)。

## 技术资料

本轮通过Context7 MCP核对Readability、SerpAPI、twitterapi.io与Undici；GitHub当前API版本和Release字段通过Firecrawl MCP查官方资料。另读取安装版本Next Server/Client Components和Route Handler指南。

- [Readability](https://github.com/mozilla/readability/blob/main/README.md)：纯文本、日期、DOM限制，不执行页面脚本。
- [Google API](https://serpapi.com/search-api)、[Bing API](https://serpapi.com/bing-search-api)：engine分别适配，摘要不作发布时间证明。
- [X advanced search](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)：Latest、游标与回复字段；查询过滤另由本地字段检查。
- [GitHub Releases](https://docs.github.com/en/rest/releases/releases)：版本头2026-03-10，明确draft/prerelease/published_at。
- [Undici内置与安装版本](https://github.com/nodejs/undici/blob/main/docs/docs/best-practices/undici-vs-builtin-fetch.md)、[v8迁移](https://github.com/nodejs/undici/blob/main/docs/docs/best-practices/migrating-from-v7-to-v8.md)、[ProxyAgent](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)：匹配版本的request/dispatcher、固定CONNECT目标IP、原域名Host及TLS SNI。
