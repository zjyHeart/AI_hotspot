# Signal Desk — 轻量技术情报工作台

设计日期：2026-10-04。用户确认：浅色工作台 + 深色侧栏。使用 ui-ux-pro-max 检索 AI / operations dashboard 方向，并按实际监控工具调整，保留可读性和低动效。

## 视觉与布局

- 冷白内容区，深蓝侧栏；蓝紫色用于主操作，绿色/琥珀/红色仅表达状态。
- 卡片、边框与留白分层，统一 12–18px 圆角；主要正文 13–16px，表单输入 14px（移动端 16px）；说明文字以 12–13px 为主，英文栏目、状态徽标与元数据使用 9–11px。
- 系统字体与中文系统字体，不从外部字体服务加载资源。
- 桌面固定导航、移动端五项底部导航；核心操作保留文字标签。
- 总览突出真实统计、筛选和情报；大幅装饰缩减为一处引擎状态卡。

## Aceternity UI

按官方手动安装方式采用 Bento Grid 与 SVG Spotlight 源码，保存于 src/components/ui/，注明来源并按项目主题调整。

- Bento Grid 用于真实统计；去掉卡片内文字的横向 hover 位移。
- Spotlight 只用于引擎卡片的装饰，不接管鼠标、不拦截点击，CSS 入场一次。
- 保留系统减少动画偏好；禁用动效时光效静态可见，主要内容立即显示。
- 只安装实际用到的 clsx 和 tailwind-merge；组件不依赖动画运行时、Canvas、WebGL 或远程图片。

## 功能约束

保留频道创建/编辑/启停、手动扫描、事件详情与原文、筛选/排序、通知、设置与连接测试。数值来自实际 dashboard 数据，不添加模拟趋势、示例热点或成功提示。

## 验证

检查 375 / 768 / 1024 / 1440px，无横向溢出；检查弹窗、键盘焦点、减少动画和表单。UI 业务操作使用独立临时数据库，外部 API 及邮件按钮不因样式验收而自动调用。比较生产首屏脚本 gzip 体积，不用开发构建判断发布包大小。

## 来源

- 技能：~/.codex/skills/ui-ux-pro-max/SKILL.md
- Context7：/websites/ui_aceternity，Bento Grid、Spotlight、Tailwind v4。
- 官方：https://ui.aceternity.com/components/bento-grid
- 官方：https://ui.aceternity.com/components/spotlight
- 源码：https://ui.aceternity.com/registry/bento-grid.json
- 源码：https://ui.aceternity.com/registry/spotlight.json
- 安装版本的 Next.js docs：Server and Client Components、CSS。

MCP 页面解析器省略了注册表字符串内的 JSX 标签，因此在 MCP 核对官方来源后，通过 CLI 读取同一注册表的原始 JSON 完整源码；未以省略后的内容作为可运行组件。
