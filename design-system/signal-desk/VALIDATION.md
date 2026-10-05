# 前端改版验收记录

日期：2026-10-04。

- 使用 ui-ux-pro-max 设计检索，按用户确认的浅色工作台 + 深色侧栏实现。
- 通过 Context7 MCP 查询 Aceternity UI，手动集成官方 Bento Grid / Spotlight 源码并调整主题，来源见 MASTER.md。
- `npm run typecheck` 与 `npm run build` 成功；`npm test` 32 项通过，业务测试使用独立临时数据库。
- 浏览器验收使用独立真实联调数据库，未修改正式业务库。创建一个明确标注“界面验收”的暂停频道，保存后编辑扫描间隔为 60 分钟，确认修改保留且仍暂停。
- 搜索无匹配内容显示空态；证据筛选、RSS 来源筛选、按热度 / 最新切换成功；事件详情显示原始来源链接，Esc 可关闭。
- 情报总览、监控频道、通知中心、扫描记录、连接与设置在 375 / 768 / 1024 / 1440px 均无页面横向溢出；检查桌面、手机和表单截图。
- 通知中心验证现有真实数据的空态与导航，本次未生成通知、发送邮件或重试外部采集。设置页检查表单展示，未修改正式配置或调用付费连接测试。
- 375px 手机弹窗外宽 341px，scrollWidth 与 clientWidth 均 339px，无内部横向溢出；Esc 关闭正常。
- 系统减少动画偏好下 Spotlight 的 animationName 为 none；无循环动画、鼠标追踪、Canvas、WebGL、远程字体或图片。
- 浏览器 console：0 errors / 0 warnings。
- 同一生产首页脚本 URL 的文件分别 gzip 后求和：改版前 276355 bytes，改版后 285558 bytes，增加 9203 bytes（约 9.0 KiB / 3.3%）；7 个脚本。此指标为文件压缩体积估算，不代表网络速度或 Core Web Vitals。
- 截图与体积原始记录存于被 Git 忽略的 output/playwright 和 output/verification。

业务后台与 API 行为保持原样；本次验证关注前端回归，真实外部服务联调结果沿用此前已完成的验证。
