import type { Monitor, XAccount } from "./types";

// Profile links verified against these official sites through Firecrawl MCP on 2026-10-05.
export const AI_CODING_ACCOUNTS: XAccount[] = [
  {
    handle: "OpenAI",
    name: "OpenAI",
    kind: "official",
    focus: "Codex、Agent 开发能力",
    proofUrl: "https://openai.com/",
    active: true,
  },
  {
    handle: "AnthropicAI",
    name: "Anthropic",
    kind: "official",
    focus: "Claude Code、Agent 工具",
    proofUrl: "https://www.anthropic.com/",
    active: true,
  },
  {
    handle: "cursor_ai",
    name: "Cursor",
    kind: "official",
    focus: "AI 编程工作流",
    proofUrl: "https://cursor.com/",
    active: true,
  },
  {
    handle: "cline",
    name: "Cline",
    kind: "official",
    focus: "开源编程 Agent",
    proofUrl: "https://cline.bot/",
    active: true,
  },
  {
    handle: "opencode",
    name: "OpenCode",
    kind: "official",
    focus: "OpenCode 更新与实践",
    proofUrl: "https://github.com/anomalyco/opencode",
    active: true,
  },
  {
    handle: "LangChain",
    name: "LangChain",
    kind: "official",
    focus: "Agent 框架与工程实践",
    proofUrl: "https://www.langchain.com/",
    active: true,
  },
  {
    handle: "simonw",
    name: "Simon Willison",
    kind: "expert",
    focus: "LLM 工具、技术分析与实验",
    proofUrl: "https://simonwillison.net/about/",
    active: true,
  },
  {
    handle: "steipete",
    name: "Peter Steinberger",
    kind: "expert",
    focus: "AI 编程与 Agent 实践",
    proofUrl: "https://steipete.me/",
    active: true,
  },
];
export function monitoredHandles(
  m: Pick<Monitor, "quality">,
  accounts: XAccount[],
) {
  const blocked = new Set(
    (m.quality?.blockedAccounts || []).map((x) => x.toLowerCase()),
  );
  return [
    ...new Set(
      [
        ...(m.quality?.useCuratedAccounts
          ? accounts.filter((a) => a.active).map((a) => a.handle)
          : []),
        ...(m.quality?.followedAccounts || []),
      ].map((x) => x.toLowerCase()),
    ),
  ].filter((x) => !blocked.has(x));
}
export function curatedAccount(
  author: string,
  m: Pick<Monitor, "quality">,
  accounts: XAccount[],
) {
  return monitoredHandles(m, accounts).includes(author.toLowerCase());
}
