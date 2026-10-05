import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { monitorInput, type Article } from "../src/shared/types";
import { getDb } from "../src/server/db";
import {
  candidates,
  analysisJobs,
  articles,
  monitors,
} from "../src/server/schema";
import { getSettings, writeSetting } from "../src/server/config";
import { saveMonitor, dashboard } from "../src/server/repository";
import {
  persistArticles,
  scanMonitor,
  claimMonitor,
} from "../src/server/scanner";
import {
  enqueuePipeline,
  processNextAnalysis,
  claimAnalysis,
  retryAnalysis,
  requestAnalysis,
  addFeedback,
} from "../src/server/pipeline";
import {
  selectPassages,
  screenArticles,
  analyzeEvent,
} from "../src/server/analysis-stages";
import { aiUsage, reserveAI, finishAI } from "../src/server/ai-budget";
import { collectWebDiscovery } from "../src/server/web-sources";
import { threadContext, contextUsage } from "../src/server/thread-context";
import { type Fetcher } from "../src/server/http";
import { screened, deepResponse, stageResponse } from "./analysis-fixtures";
import { aiCompletion } from "../src/server/ai-client";

const now = Date.now(),
  text =
    "Cursor released a new coding agent with a concrete task workflow update.";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const article = (patch: Partial<Article> = {}): Article => ({
  id: randomUUID(),
  externalId: randomUUID(),
  source: "x",
  title: text,
  text,
  url: "https://x.com/cursor_ai/status/" + randomUUID(),
  author: "cursor_ai",
  publishedAt: now - 10000,
  collectedAt: now,
  metrics: { likes: 0, reposts: 0 },
  originKey: "x:cursor_ai",
  isRepost: false,
  metadata: { contentKind: "post", contentStatus: "native", isReply: false },
  ...patch,
});
const create = () =>
  saveMonitor(
    monitorInput.parse({
      name: "分阶段测试",
      keywords: "Cursor coding agent",
      kind: "keyword",
      sources: ["x"],
      active: false,
      quality: { engagementMode: "loose" },
    }),
  );
function model(patch?: (input: any, output: any) => unknown) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content,
      ),
      output = stageResponse(input);
    return json({
      choices: [
        {
          message: {
            content: JSON.stringify(patch ? patch(input, output) : output),
          },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 100 },
    });
  }) as unknown as Fetcher;
}
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "/tmp/signal-v2-test-" + randomUUID() + ".db");
  vi.stubEnv("PACKY_API_KEY", "test-packy-key");
  vi.stubEnv("AI_MODEL", "test-model");
  vi.stubEnv("AI_OUTPUT_MODE", "json_object");
  vi.stubEnv("TWITTERAPI_API_KEY", "test-x-key");
  vi.stubEnv("SERPAPI_API_KEY", "test-serp-key");
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "EMAIL_FROM",
    "EMAIL_TO",
  ])
    vi.stubEnv(key, "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("宽松策略下低互动重要回复进入初筛，每条保存结论，未知作者不自动可信", async () => {
  const m = await create(),
    a = article({
      author: "small_author",
      metadata: { isReply: true, contentKind: "post", contentStatus: "native" },
    });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  const f = model();
  await processNextAnalysis(f, m.id);
  await processNextAnalysis(f, m.id);
  const d = dashboard();
  expect(d.pipeline.candidates.selected).toBe(1);
  expect(d.events).toHaveLength(1);
  expect(d.events[0].credibility).toBe("unverified");
  expect(d.events[0].details?.claims).toHaveLength(1);
  expect(d.notifications).toHaveLength(0);
});
it("采集阶段不调用 AI；后续分析不再次搜索", async () => {
  const m = await create(),
    calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("advanced_search"))
      return json({
        tweets: [
          {
            id: "123",
            text,
            createdAt: new Date(now - 10000).toISOString(),
            author: { userName: "cursor_ai" },
            isReply: false,
          },
        ],
        has_next_page: false,
        next_cursor: "",
      });
    return model()(url, init);
  }) as Fetcher;
  await scanMonitor(m.id, f);
  expect(calls).toHaveLength(1);
  await processNextAnalysis(f, m.id);
  await processNextAnalysis(f, m.id);
  expect(calls.filter((x) => x.includes("advanced_search"))).toHaveLength(1);
  expect(dashboard().pipeline.usage.calls).toBe(2);
});
it("未知日期仍分析，旧文转背景，不拿采集时间冒充发布", async () => {
  const m = await create();
  persistArticles(m, [
    article({ publishedAt: 0 }),
    article({
      text: text + " Historical context",
      publishedAt: now - 8 * 86400000,
    }),
  ]);
  enqueuePipeline(m);
  expect(dashboard().pipeline.candidates.background).toBe(1);
  await processNextAnalysis(model(), m.id);
  await processNextAnalysis(model(), m.id);
  expect(dashboard().events).toHaveLength(1);
  expect(dashboard().notifications).toHaveLength(0);
  expect(dashboard().events[0].details?.gaps?.join(" ")).toContain("日期");
});
it("AI 必须覆盖全部输入，漏项拒绝且不误标已分析", async () => {
  const m = await create(),
    items = [article(), article({ text: text + " Unique second detail" })];
  persistArticles(m, items);
  enqueuePipeline(m);
  await processNextAnalysis(
    model((input, out) => ({ items: out.items.slice(0, 1) })),
    m.id,
  );
  expect(dashboard().pipeline.jobs.retry).toBe(1);
  expect(dashboard().pipeline.candidates.queued).toBe(2);
  expect(dashboard().pendingCount).toBe(2);
});
it("无关与低价值结论保存理由，不混入展示列表", async () => {
  const m = await create();
  persistArticles(m, [article()]);
  enqueuePipeline(m);
  await processNextAnalysis(
    model((input, out) => ({
      items: out.items.map((x: any) => ({
        ...x,
        decision: "irrelevant",
        relevance: 5,
        reason: "内容与编程代理无关",
      })),
    })),
    m.id,
  );
  expect(dashboard().pipeline.candidates.irrelevant).toBe(1);
  expect(dashboard().pipeline.assessments[0].reason).toContain("无关");
  expect(dashboard().events).toHaveLength(0);
});
it("日期未来或不同版本不能静默混成一个事件", async () => {
  const m = await create(),
    list = [article(), article({ text: text + " version two" })];
  persistArticles(m, list);
  enqueuePipeline(m);
  await processNextAnalysis(
    model((input, out) => ({
      items: out.items.map((x: any, i: number) => ({
        ...x,
        version: "v" + (i + 1),
      })),
    })),
    m.id,
  );
  expect(
    new Set(
      getDb()
        .select()
        .from(candidates)
        .all()
        .map((c) => c.groupKey),
    ).size,
  ).toBe(2);
  await expect(
    screenArticles(
      m,
      [list[0]],
      [],
      "future",
      model((input, out) => ({
        items: out.items.map((x: any) => ({ ...x, eventDate: "2099-01-01" })),
      })),
    ),
  ).rejects.toThrow("日期");
});
it("跨批次同事件重新核验时可以读取已有支持与反对材料", async () => {
  const m = await create(),
    first = article();
  persistArticles(m, [first]);
  enqueuePipeline(m);
  await processNextAnalysis(model(), m.id);
  await processNextAnalysis(model(), m.id);
  const second = article({
    text: "Independent report contradicts the reported coding agent workflow release.",
    author: "other",
    originKey: "x:other",
  });
  persistArticles(m, [second]);
  enqueuePipeline(m);
  await processNextAnalysis(model(), m.id);
  let ids: string[] = [];
  const f = model((input, out) => {
    if (input.group) {
      ids = input.articles.map((a: any) => a.id);
      return {
        ...out,
        credibility: "disputed",
        claims: [
          {
            claim: "是否发布该工作流",
            verdict: "contradicted",
            reason: "第二条材料与发布声明矛盾",
            articleIds: ids,
            quoteIds: input.articles.map((a: any) => a.quotations[0].quoteId),
          },
        ],
        evidence: input.articles.map((a: any) => ({
          articleId: a.id,
          role: "unknown",
          quoteId: a.quotations[0].quoteId,
        })),
      };
    }
    return out;
  });
  await processNextAnalysis(f, m.id);
  expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(dashboard().events).toHaveLength(1);
  expect(dashboard().events[0].credibility).toBe("disputed");
});
it("长文末尾相关段落进入深度材料，而非固定只读开头", () => {
  const full =
    "Unrelated introduction. ".repeat(300) +
    " GPU_AGENT_77 released version 2.0 with new task planning evidence. " +
    "Unrelated appendix. ".repeat(100);
  const chosen = selectPassages(full, "GPU_AGENT_77 version 2.0", 2250);
  expect(chosen.passages.some((p) => p.text.includes("GPU_AGENT_77"))).toBe(
    true,
  );
  expect(chosen.omitted).toBe(true);
  expect(chosen.originalLength).toBe(full.length);
});
it("深度分析拒绝未采集引用和只有单侧证据的争议结论", async () => {
  const m = await create(),
    a = article();
  await expect(
    analyzeEvent(
      m,
      [a],
      [screened(a.id) as any],
      "bad-reference",
      model((input, out) => ({
        ...out,
        evidence: [
          {
            articleId: "fabricated",
            role: "first_party",
            quoteId: input.articles[0].quotations[0].quoteId,
          },
        ],
      })),
    ),
  ).rejects.toThrow("Schema");
  await expect(
    analyzeEvent(
      m,
      [a],
      [screened(a.id) as any],
      "bad-dispute",
      model((input, out) => ({ ...out, credibility: "disputed" })),
    ),
  ).rejects.toThrow("双方证据");
});
it("相同 URL/相同正文归一，同时保留跨渠道发现路径", async () => {
  const m = await create(),
    first = article({
      source: "rss",
      url: "https://example.com/first",
      originKey: "example.com",
      metadata: { contentKind: "web", contentStatus: "full" },
      text: text + " more detailed full article context",
    });
  persistArticles(m, [first]);
  persistArticles(m, [
    {
      ...first,
      id: randomUUID(),
      source: "google",
      url: "https://other.example.com/copy",
      author: "other",
      originKey: "other.example.com",
    },
  ]);
  enqueuePipeline(m);
  const saved = getDb().select().from(articles).all();
  expect(saved).toHaveLength(1);
  expect(saved[0].metadata.discoverySources).toEqual(
    expect.arrayContaining(["rss", "google"]),
  );
  expect(saved[0].metadata.discoveryUrls).toHaveLength(2);
  expect(getDb().select().from(candidates).all()).toHaveLength(1);
});
it("AI 额度不足不发请求，未知失败 usage 保守计入预留", async () => {
  writeSetting("app", { aiDailyCallLimit: 0 });
  const m = await create();
  persistArticles(m, [article()]);
  enqueuePipeline(m);
  const f = model();
  await processNextAnalysis(f, m.id);
  expect(f).not.toHaveBeenCalled();
  expect(dashboard().pipeline.jobs.budget).toBe(1);
  writeSetting("app", { aiDailyCallLimit: 60 });
  const job = getDb().select().from(analysisJobs).get()!;
  retryAnalysis(job.id);
  const fail = vi.fn(async () => json({}, 401));
  await processNextAnalysis(fail as Fetcher, m.id);
  expect(aiUsage().calls).toBe(1);
  expect(aiUsage().unknown).toBe(1);
  expect(aiUsage().reserved).toBeGreaterThan(0);
});
it("初筛不能占用为深度预留的 20% 日调用额度", () => {
  writeSetting("app", { aiDailyCallLimit: 5, aiDailyTokenLimit: 100000 });
  for (let i = 0; i < 4; i++) {
    const id = reserveAI("screen", "screen-job", 100);
    finishAI(id, 50);
  }
  expect(() => reserveAI("screen", "blocked-screen", 100)).toThrow("预算");
  expect(() => reserveAI("deep", "allowed-deep", 100)).not.toThrow();
  expect(aiUsage().calls).toBe(5);
});
it("队列租约阻止同频道并发分析和采集，过期后可以恢复", async () => {
  const m = await create();
  persistArticles(m, [article()]);
  enqueuePipeline(m);
  const first = claimAnalysis(m.id)!;
  expect(first).toBeDefined();
  expect(claimAnalysis(m.id)).toBeUndefined();
  expect(claimMonitor(m.id)).toBeUndefined();
  getDb()
    .update(monitors)
    .set({ leaseUntil: 0 })
    .where(eq(monitors.id, m.id))
    .run();
  getDb()
    .update(analysisJobs)
    .set({ leaseUntil: 0 })
    .where(eq(analysisJobs.id, first.id))
    .run();
  const second = claimAnalysis(m.id)!;
  expect(second.leaseToken).not.toBe(first.leaseToken);
});
it("截断后减小批次，有限重试；成功项不重复初筛", async () => {
  const m = await create();
  persistArticles(m, [
    article(),
    article({ text: text + " Detail two" }),
    article({ text: text + " Detail three" }),
  ]);
  enqueuePipeline(m);
  await processNextAnalysis(
    (async () =>
      json({
        choices: [{ message: { content: "{}" }, finish_reason: "length" }],
        usage: { total_tokens: 30 },
      })) as Fetcher,
    m.id,
  );
  const job = getDb().select().from(analysisJobs).get()!;
  expect(job.batchLimit).toBe(1);
  expect(aiUsage().unknown).toBe(0);
  retryAnalysis(job.id);
  await processNextAnalysis(model(), m.id);
  expect(dashboard().pipeline.candidates.selected).toBe(1);
  expect(dashboard().pipeline.candidates.queued).toBe(2);
});
it("自动分析默认暂停，手动仅分析已有材料，并可恢复旧规则候选", async () => {
  const m = await create(),
    a = article();
  persistArticles(m, [a]);
  enqueuePipeline(m);
  expect(claimAnalysis()).toBeUndefined();
  requestAnalysis(m.id);
  expect(claimAnalysis()).toBeDefined();
  expect(getSettings().analysisEnabled).toBe(false);
});
it("Google 与 Bing 使用各自分页参数，失败保留查询位置", async () => {
  writeSetting("app", { webPages: 2 });
  const m = await create();
  const urls: URL[] = [];
  const f = (async (url: string) => {
    const u = new URL(url);
    urls.push(u);
    const engine = u.searchParams.get("engine");
    return json({
      search_metadata: { status: "Success" },
      organic_results: [
        {
          title: "Article",
          link: "https://example.com/" + urls.length,
          snippet: text,
        },
      ],
      serpapi_pagination: {
        next: `https://serpapi.com/search.json?${engine === "google" ? "start=10" : "first=11"}`,
      },
    });
  }) as Fetcher;
  await collectWebDiscovery(m, "google", f);
  await collectWebDiscovery(m, "bing", f);
  expect(urls[1].searchParams.get("start")).toBe("10");
  expect(urls[3].searchParams.get("first")).toBe("11");
  expect(urls[3].searchParams.has("start")).toBe(false);
});
it("回复按 ID 获取父帖并缓存；达到 X 上下文预算不继续收费查询", async () => {
  const a = article({
      metadata: {
        contentKind: "post",
        contentStatus: "native",
        isReply: true,
        replyToId: "12345",
      },
    }),
    f = vi.fn(async () =>
      json({
        status: "success",
        tweets: [
          {
            id: "12345",
            text,
            createdAt: new Date(now).toISOString(),
            author: { userName: "cursor_ai" },
            isReply: false,
          },
        ],
      }),
    );
  const first = await threadContext([a], f as Fetcher);
  expect(first.articles).toHaveLength(1);
  await threadContext([a], f as Fetcher);
  expect(f).toHaveBeenCalledOnce();
  expect(contextUsage()).toBe(1);
  writeSetting("app", { xContextDailyLimit: 0 });
  const blocked = await threadContext(
    [{ ...a, metadata: { ...a.metadata, replyToId: "67890" } }],
    f as Fetcher,
  );
  expect(blocked.gaps.join(" ")).toContain("上限");
  expect(f).toHaveBeenCalledOnce();
});
it("反馈保留作调优记录，不将用户反馈自动变成可信证据", async () => {
  const m = await create();
  persistArticles(m, [article({ author: "unknown" })]);
  enqueuePipeline(m);
  await processNextAnalysis(model(), m.id);
  await processNextAnalysis(model(), m.id);
  const event = dashboard().events[0];
  addFeedback(event.id, "valuable");
  expect(dashboard().events[0].credibility).toBe("unverified");
});

it("已确认媒体身份不等于事件主体的一手发布者", async () => {
  const m = await create(),
    a = article({
      source: "rss",
      author: "TechCrunch",
      url: "https://techcrunch.com/story",
      originKey: "techcrunch.com",
      metadata: { contentStatus: "full", contentKind: "web" },
    });
  const r = await analyzeEvent(
    m,
    [a],
    [screened(a.id) as any],
    "publisher-scope",
    model(),
  );
  expect(r.result.credibility).toBe("unverified");
  expect(r.result.gaps.join(" ")).toContain("一手关系");
});

it("过期租约的迟到响应不能覆盖新 worker 的候选或租约", async () => {
  const m = await create();
  persistArticles(m, [article()]);
  enqueuePipeline(m);
  let release: (value: Response) => void = () => {},
    input: any;
  const blocked = (async (_url: string | URL | Request, init?: RequestInit) => {
    input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as Fetcher;
  const pending = processNextAnalysis(blocked, m.id);
  for (let i = 0; i < 10 && !input; i++) await Promise.resolve();
  expect(input).toBeDefined();
  vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60000);
  const replacement = claimAnalysis(m.id)!;
  expect(replacement).toBeDefined();
  release(
    json({
      choices: [
        {
          message: { content: JSON.stringify(stageResponse(input)) },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 20 },
    }),
  );
  await pending;
  expect(
    getDb()
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.id, replacement.id))
      .get()?.leaseToken,
  ).toBe(replacement.leaseToken);
  expect(
    getDb().select().from(monitors).where(eq(monitors.id, m.id)).get()
      ?.leaseUntil,
  ).toBe(replacement.leaseUntil);
  expect(dashboard().pipeline.candidates.queued).toBe(1);
});

it("仅已验证的 DeepSeek v4 Pro 分阶段请求携带稳定输出参数", async () => {
  vi.stubEnv("AI_MODEL", "deepseek-v4-pro");
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { total_tokens: 20 },
    });
  }) as Fetcher;
  await aiCompletion([], {}, 100, f, { stage: "deep", jobId: "verified-deep" });
  expect(bodies[0].thinking).toEqual({ type: "disabled" });
  await aiCompletion([], {}, 100, f, {
    stage: "connection",
    jobId: "connection",
  });
  expect(bodies[1].thinking).toBeUndefined();
  writeSetting("app", { thinkingMode: "auto" });
  await aiCompletion([], {}, 100, f, { stage: "deep", jobId: "explicit-auto" });
  expect(bodies[2].thinking).toBeUndefined();
});

it("深度引用锚点还原连续原文，拒绝未知、错配、重复引用和模型改写", async () => {
  const m = await create(),
    a = article({ text: text.repeat(10) }),
    b = article({ text: text + " Independent coverage." });
  let sent: any;
  const ok = await analyzeEvent(
    m,
    [a, b],
    [screened(a.id) as any],
    "anchors",
    model((input, out) => {
      sent = input;
      return out;
    }),
  );
  const cited = sent.articles.find(
    (x: any) => x.id === ok.result.evidence[0].articleId,
  );
  const quote = cited.quotations[0];
  expect(ok.result.evidence[0].excerpt).toBe(quote.text);
  expect(ok.result.claims[0].citations[0].excerpt).toBe(quote.text);
  expect(a.text.slice(quote.start, quote.end)).toBe(quote.text);
  expect(
    cited.quotations.every(
      (q: any) => q.text.length >= 8 && q.text.length <= 250,
    ),
  ).toBe(true);
  expect(cited.quotations.map((q: any) => q.text).join("")).toBe(a.text);
  for (const kind of [
    "unknown",
    "mismatch",
    "duplicate",
    "rewrite",
    "claim_unknown",
    "claim_mismatch",
    "claim_duplicate",
  ]) {
    await expect(
      analyzeEvent(
        m,
        [a, b],
        [screened(a.id) as any],
        "invalid-" + kind,
        model((input, out) => {
          const e = out.evidence[0];
          if (kind.startsWith("claim_"))
            return {
              ...out,
              claims: [
                {
                  ...out.claims[0],
                  quoteIds:
                    kind === "claim_unknown"
                      ? ["invented"]
                      : kind === "claim_mismatch"
                        ? [input.articles[1].quotations[0].quoteId]
                        : [e.quoteId, e.quoteId],
                },
              ],
            };
          if (kind === "unknown")
            return { ...out, evidence: [{ ...e, quoteId: "invented" }] };
          if (kind === "mismatch")
            return {
              ...out,
              evidence: [
                { ...e, quoteId: input.articles[1].quotations[0].quoteId },
              ],
            };
          if (kind === "duplicate") return { ...out, evidence: [e, e] };
          return { ...out, evidence: [{ ...e, excerpt: "rewritten text" }] };
        }),
      ),
    ).rejects.toThrow();
  }
});

it("调整时间窗口及模型思考配置会重排旧结论，失效任务不重复调用", async () => {
  const m = await create(),
    a = article({ publishedAt: Date.now() - 5 * 3600000 });
  writeSetting("app", { eventWindowHours: 1 });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  expect(getDb().select().from(candidates).get()!.state).toBe("background");
  writeSetting("app", { eventWindowHours: 24, thinkingMode: "disabled" });
  enqueuePipeline(m);
  const oldDigest = getDb().select().from(candidates).get()!.digest;
  expect(getDb().select().from(candidates).get()!.state).toBe("queued");
  expect(getDb().select().from(candidates).get()!.assessment.history).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: "background" })]),
  );
  writeSetting("app", { eventWindowHours: 24, thinkingMode: "auto" });
  enqueuePipeline(m);
  expect(getDb().select().from(candidates).get()!.digest).not.toBe(oldDigest);
  const f = model();
  await processNextAnalysis(f, m.id);
  expect(f).not.toHaveBeenCalled();
  await processNextAnalysis(f, m.id);
  expect(f).toHaveBeenCalledTimes(1);
});

it("旧数据库增量升级前创建一致备份，并保留原有配置", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
    readdirSync,
  } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const root = mkdtempSync(join(tmpdir(), "signal-v2-migration-")),
    migrations = join(root, "migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync("drizzle/meta/_journal.json", "utf-8"),
  );
  journal.entries = journal.entries.filter((e: any) => e.idx < 3);
  writeFileSync(
    join(migrations, "meta/_journal.json"),
    JSON.stringify(journal),
    "utf-8",
  );
  for (const entry of journal.entries)
    copyFileSync(
      "drizzle/" + entry.tag + ".sql",
      join(migrations, entry.tag + ".sql"),
    );
  const path = join(root, "legacy.db"),
    legacy = new Database(path);
  migrate(drizzle(legacy), { migrationsFolder: migrations });
  legacy
    .prepare("insert into settings (key,value) values (?,?)")
    .run("preserved", JSON.stringify("原有频道配置"));
  legacy.close();
  vi.stubEnv("DATABASE_URL", path);
  const { settings } = await import("../src/server/schema");
  expect(
    getDb().select().from(settings).where(eq(settings.key, "preserved")).get()!
      .value,
  ).toBe("原有频道配置");
  expect(getDb().select().from(candidates).all()).toEqual([]);
  const backupPaths = readdirSync(join(root, "backups"));
  expect(backupPaths).toHaveLength(1);
  const backup = new Database(join(root, "backups", backupPaths[0]), {
    readonly: true,
  });
  expect(
    backup.prepare("select value from settings where key='preserved'").get(),
  ).toEqual({ value: JSON.stringify("原有频道配置") });
  expect(
    backup
      .prepare(
        "select name from sqlite_master where name='analysis_candidates'",
      )
      .get(),
  ).toBeUndefined();
  backup.close();
});
