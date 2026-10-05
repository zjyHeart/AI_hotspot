// Synthetic responses for deterministic regression tests only, never preview data.
export function screened(
  articleId: string,
  patch: Record<string, unknown> = {},
) {
  return {
    articleId,
    decision: "relevant",
    relevance: 92,
    value: 85,
    reason: "包含具体编程代理工作流变更",
    novelty: "新增任务工作流",
    subject: "cursor",
    action: "update",
    version: "workflow-v1",
    eventDate: null,
    eventKey: "cursor-agent-workflow-v1",
    claims: ["Cursor 更新代理工作流"],
    ...patch,
  };
}
export function deepResponse(
  input: {
    articles: {
      id: string;
      source: string;
      quotations: { quoteId: string; text: string }[];
    }[];
  },
  patch: Record<string, unknown> = {},
) {
  const a = input.articles.find((a) => a.source === "x") || input.articles[0];
  return {
    disposition: "publish",
    title: "Cursor 更新代理工作流",
    summary: "材料介绍了代理工作流的具体变更。",
    relevance: 92,
    value: 85,
    impact: "可关注开发流程变化；性能尚无独立验证。",
    importance: "high",
    importanceReason: "编程代理的具体工作流变更。",
    credibility: "supported",
    reason: "原始发布声明支持该说法",
    gaps: [],
    claims: [
      {
        claim: "Cursor 更新代理工作流",
        verdict: "supported",
        reason: "材料中有明确发布声明",
        articleIds: [a.id],
        quoteIds: [a.quotations[0].quoteId],
      },
    ],
    evidence: [
      {
        articleId: a.id,
        role: "first_party",
        quoteId: a.quotations[0].quoteId,
      },
    ],
    ...patch,
  };
}
export function stageResponse(input: {
  knownGroups?: unknown[];
  group?: unknown;
  articles: {
    id: string;
    source: string;
    quotations: { quoteId: string; text: string }[];
  }[];
}) {
  if (input.knownGroups)
    return { items: input.articles.map((a) => screened(a.id)) };
  return deepResponse(input);
}
