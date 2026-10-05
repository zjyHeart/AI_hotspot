// Synthetic regression fixtures only. Never used to populate the preview.
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  monitorInput,
  xAccountsInput,
  type Article,
  type Event,
  type Monitor,
} from "../src/shared/types";
import { AI_CODING_ACCOUNTS } from "../src/shared/x-accounts";
import { feedFilterInput, filterFeed, socialHeat } from "../src/shared/feed";
import { getSettings, writeSetting } from "../src/server/config";
import { getDb } from "../src/server/db";
import {
  articles,
  articleMonitors,
  candidates,
  checkpoints,
  events,
} from "../src/server/schema";
import { saveMonitor, queryEvents, dashboard } from "../src/server/repository";
import { collectTwitter, twitterQuery } from "../src/server/sources";
import { scanMonitor, persistArticles } from "../src/server/scanner";
import { enqueuePipeline, processNextAnalysis } from "../src/server/pipeline";
import {
  qualityDecision,
  observationUntil,
  fairCandidates,
} from "../src/server/quality";
import { reserveX, xUsage } from "../src/server/x-budget";
import { threadContext } from "../src/server/thread-context";
import { analyzeEvent } from "../src/server/analysis-stages";
import { refreshObservations } from "../src/server/x-observation";
import { claimXSlot } from "../src/server/x-pacing";
import { stageResponse, deepResponse, screened } from "./analysis-fixtures";
import { GET, POST } from "../src/app/api/[...path]/route";
import type { Fetcher } from "../src/server/http";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const create = (quality: Record<string, unknown> = {}) =>
  saveMonitor(
    monitorInput.parse({
      name: "X 专题测试",
      keywords: "AI coding agent",
      kind: "topic",
      sources: ["x"],
      active: false,
      quality,
    }),
  );
const article = (patch: Partial<Article> = {}): Article => ({
  id: randomUUID(),
  externalId: randomUUID(),
  source: "x",
  title: "Agent workflow",
  text: "A concrete coding agent workflow update with task execution and debugging support.",
  url: "https://x.com/person/status/" + randomUUID(),
  author: "person",
  publishedAt: Date.now() - 3 * 3600000,
  collectedAt: Date.now(),
  metrics: { likes: 0, replies: 0, reposts: 0 },
  originKey: "x:person",
  isRepost: false,
  metadata: { contentKind: "post", contentStatus: "native", isReply: false },
  ...patch,
});
const tweet = (
  id: string,
  author = "cursor_ai",
  metrics: Record<string, number> = {},
) => ({
  id,
  text: "Released coding agent workflow update with new debugging support.",
  author: {
    userName: author,
    isBlueVerified: true,
    verifiedType: "business",
    followers: 100,
  },
  createdAt: new Date(Date.now() - 10000).toUTCString(),
  isReply: false,
  ...metrics,
});
const event = (a: Article, patch: Partial<Event> = {}): Event => ({
  id: randomUUID(),
  monitorId: "m",
  eventKey: randomUUID(),
  title: a.title,
  summary: a.text,
  relevance: 80,
  credibility: "unverified",
  reason: "Test",
  evidence: [{ articleId: a.id, role: "unknown", excerpt: a.text }],
  score: 90,
  scoreReason: "legacy recommendation",
  createdAt: Date.now() - 10000,
  updatedAt: Date.now(),
  notifiedAt: null,
  revision: 1,
  articles: [a],
  details: {
    value: 80,
    importance: "medium",
    importanceReason: "Test",
    firstDiscoveredAt: Date.now() - 10000,
    publishedAt: a.publishedAt,
  },
  ...patch,
});
beforeEach(() => {
  vi.stubEnv(
    "DATABASE_URL",
    "/tmp/signal-x-watch-test-" + randomUUID() + ".db",
  );
  vi.stubEnv("TWITTERAPI_API_KEY", "synthetic-x-key");
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-ai-key");
  vi.stubEnv("AI_MODEL", "test-model");
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "EMAIL_FROM",
    "EMAIL_TO",
    "SERPAPI_API_KEY",
  ])
    vi.stubEnv(key, "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("精选名单重复账号拒绝，暂停账号不进入查询", async () => {
  expect(
    xAccountsInput.safeParse([
      AI_CODING_ACCOUNTS[0],
      { ...AI_CODING_ACCOUNTS[0], handle: "openai" },
    ]).success,
  ).toBe(false);
  const s = getSettings();
  writeSetting("app", {
    ...s,
    xAccounts: s.xAccounts.map((a) => ({ ...a, active: a.handle === "cline" })),
  });
  const m = await create({ useCuratedAccounts: true });
  let query = "";
  const f = (async (url: string) => {
    query = new URL(url).searchParams.get("query")!;
    return json({
      tweets: [tweet("1", "cline"), tweet("2", "outsider")],
      has_next_page: false,
      next_cursor: "",
    });
  }) as Fetcher;
  const r = await collectTwitter(
    m,
    { from: Date.now() - 3600000, to: Date.now(), cursor: "" },
    1,
    f,
    undefined,
    "accounts",
  );
  expect(query).toContain("from:cline");
  expect(query).not.toContain("from:openai");
  expect(query).not.toContain('"AI coding agent"');
  expect(r.articles).toHaveLength(1);
  expect(r.articles[0].metadata).toMatchObject({
    isBlueVerified: true,
    verifiedType: "business",
    followers: 100,
    xDiscovery: ["accounts"],
  });
});
it("账号组合使用括号 OR 与时间戳，不在上游用互动门槛误删精选", () => {
  const q = twitterQuery(
    { keywords: "AI", aliases: "", excludes: "ads" },
    10000,
    20000,
    ["openai", "cline"],
  );
  expect(q).toContain("(from:openai OR from:cline)");
  expect(q).toContain("since_time:10 until_time:20");
  expect(q).not.toContain("min_faves");
});
it("普通账号任一互动门槛达标即可，蓝 V 不豁免过滤", async () => {
  const m = await create(),
    s = getSettings(),
    a = article({ metadata: { isBlueVerified: true } });
  expect(qualityDecision(a, m, s.publishers, s.xAccounts)).toBe(
    "普通账号互动不足",
  );
  for (const metrics of [{ likes: 10 }, { reposts: 3 }, { replies: 5 }])
    expect(
      qualityDecision({ ...a, metrics }, m, s.publishers, s.xAccounts),
    ).toBeUndefined();
});
it("精选开发者和官方账号低互动保留，自定义关注账号也豁免", async () => {
  const m = await create({
      useCuratedAccounts: true,
      followedAccounts: ["new_builder"],
    }),
    s = getSettings();
  for (const author of ["simonw", "Cursor_AI", "new_builder"])
    expect(
      qualityDecision(article({ author }), m, s.publishers, s.xAccounts),
    ).toBeUndefined();
});
it("屏蔽优先于精选，纯转发和闲聊回复过滤，技术回复保留", async () => {
  const m = await create({
      useCuratedAccounts: true,
      blockedAccounts: ["simonw"],
    }),
    s = getSettings();
  expect(
    qualityDecision(
      article({ author: "simonw" }),
      m,
      s.publishers,
      s.xAccounts,
    ),
  ).toBe("屏蔽账号");
  expect(
    qualityDecision(
      article({ author: "cline", isRepost: true }),
      m,
      s.publishers,
      s.xAccounts,
    ),
  ).toBe("纯转发");
  expect(
    qualityDecision(
      article({ author: "cline", text: "Great!", metadata: { isReply: true } }),
      m,
      s.publishers,
      s.xAccounts,
    ),
  ).toBe("无实质内容的回复");
  expect(
    qualityDecision(
      article({
        author: "cline",
        text: "复现后错误日志为 TypeError",
        metadata: { isReply: true },
      }),
      m,
      s.publishers,
      s.xAccounts,
    ),
  ).toBeUndefined();
});
it("新帖观察不调用 AI；期满先真实接口复查再入队，首次发布时间不刷新", async () => {
  const m = await create(),
    s = getSettings();
  const a = article({ externalId: "100", publishedAt: Date.now() - 10000 });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  expect(dashboard().pipeline.candidates.observing).toBe(1);
  const f = vi.fn(async () =>
    json({ tweets: [], has_next_page: false, next_cursor: "" }),
  ) as unknown as Fetcher;
  expect(await processNextAnalysis(f, m.id)).toBe(false);
  expect(f).not.toHaveBeenCalled();
  const published = Date.now() - 3 * 3600000,
    collected = published + 10000;
  getDb()
    .update(articles)
    .set({ publishedAt: published, collectedAt: collected })
    .where(eq(articles.id, a.id))
    .run();
  const refreshed = (async () =>
    json({ tweets: [tweet("100", "person", { likeCount: 12 })] })) as Fetcher;
  expect(await refreshObservations(m, refreshed, 1)).toMatchObject({
    requests: 1,
  });
  enqueuePipeline(m);
  expect(dashboard().pipeline.candidates.queued).toBe(1);
  const stored = getDb()
    .select()
    .from(articles)
    .where(eq(articles.id, a.id))
    .get()!;
  expect(stored.publishedAt).toBe(published);
  expect(stored.collectedAt).toBe(collected);
  expect(stored.metrics.likes).toBe(12);
  expect(xUsage().categories.observation).toBe(1);
});
it("观察期结束后复查仍低互动会过滤，原始记录和原因保留", async () => {
  const m = await create(),
    a = article({ externalId: "101", publishedAt: Date.now() - 10000 });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  const published = Date.now() - 3 * 3600000;
  getDb()
    .update(articles)
    .set({ publishedAt: published, collectedAt: published + 1000 })
    .where(eq(articles.id, a.id))
    .run();
  await refreshObservations(
    m,
    (async () =>
      json({
        tweets: [
          tweet("101", "person", {
            likeCount: 1,
            retweetCount: 0,
            replyCount: 0,
          }),
        ],
      })) as Fetcher,
    1,
  );
  enqueuePipeline(m);
  expect(dashboard().pipeline.candidates.filtered).toBe(1);
  expect(getDb().select().from(articles).all()).toHaveLength(1);
  expect(getDb().select().from(articleMonitors).get()?.filterReason).toBe(
    "普通账号互动不足",
  );
});
it("互动复查缺失或预算用尽不能以旧数据作最终过滤", async () => {
  const m = await create(),
    a = article({ externalId: "102", publishedAt: Date.now() - 10000 });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  const published = Date.now() - 3 * 3600000;
  getDb()
    .update(articles)
    .set({ publishedAt: published, collectedAt: published + 1000 })
    .where(eq(articles.id, a.id))
    .run();
  await refreshObservations(
    m,
    (async () => json({ tweets: [] })) as Fetcher,
    1,
  );
  enqueuePipeline(m);
  expect(dashboard().pipeline.candidates.observing).toBe(1);
  const stored = getDb().select().from(articles).get()!;
  expect(stored.metadata.engagementRefreshError).toContain("缺失");
  expect(
    observationUntil(
      stored,
      m,
      getSettings().publishers,
      getSettings().xAccounts,
    ),
  ).not.toBeNull();
});
it("全局日月预算在请求前检查，失败也计数，跨日不跨月重置", async () => {
  const s = getSettings();
  writeSetting("app", { ...s, xDailyRequestLimit: 1, xMonthlyRequestLimit: 2 });
  reserveX("accounts");
  expect(() => reserveX("keywords")).toThrow("上限");
  expect(xUsage().day).toBe(1);
  expect(xUsage(Date.now() + 86400000).day).toBe(0);
  const m = await create();
  const f = vi.fn() as unknown as Fetcher;
  const r = await collectTwitter(
    m,
    { from: 0, to: Date.now(), cursor: "keep" },
    1,
    f,
  );
  expect(r.report.status).toBe("budget");
  expect(r.state?.cursor).toBe("keep");
  expect(f).not.toHaveBeenCalled();
});
it("失败请求保留预算计数和成功页的游标", async () => {
  const m = await create();
  let count = 0;
  const f = (async () =>
    ++count === 1
      ? json({ tweets: [tweet("1")], has_next_page: true, next_cursor: "next" })
      : json({}, 429)) as Fetcher;
  await expect(
    collectTwitter(
      m,
      { from: Date.now() - 3600000, to: Date.now(), cursor: "" },
      2,
      f,
    ),
  ).rejects.toMatchObject({ report: { requests: 2, count: 1 } });
  expect(xUsage().day).toBe(2);
});
it("双通道分页游标独立，单轮上限不会被账号和关键词各自扩大", async () => {
  const m = await create({ useCuratedAccounts: true });
  writeSetting("app", { ...getSettings(), xRequestsPerScan: 2 });
  const queries: string[] = [];
  const f = (async (url: string) => {
    const q = new URL(url).searchParams.get("query")!;
    queries.push(q);
    return json({
      tweets: [tweet(String(queries.length))],
      has_next_page: true,
      next_cursor: q.includes("from:") ? "accounts-next" : "keywords-next",
    });
  }) as Fetcher;
  await scanMonitor(m.id, f);
  expect(queries).toHaveLength(2);
  expect(queries.some((q) => q.includes("from:"))).toBe(true);
  expect(queries.some((q) => q.includes('"AI coding agent"'))).toBe(true);
  for (const lane of ["accounts", "keywords"])
    expect(
      getDb()
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, `${m.id}:x:${lane}`))
        .get()?.state.cursor,
    ).toBe(`${lane}-next`);
  expect(xUsage().day).toBe(2);
});
it("上下文与连接测试共用 X 总预算，超限无网络调用", async () => {
  writeSetting("app", { ...getSettings(), xDailyRequestLimit: 0 });
  const f = vi.fn() as unknown as Fetcher;
  const r = await threadContext(
    [article({ metadata: { replyToId: "100" } })],
    f,
  );
  expect(r.gaps.length).toBeGreaterThan(0);
  expect(f).not.toHaveBeenCalled();
  const res = await POST(
    new Request("http://localhost/api/connections/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ path: ["connections", "x"] }) },
  );
  expect(res.status).toBe(429);
  expect(xUsage().day).toBe(0);
});
it("筛选维度 OR / AND，渠道合并，推荐和 X 互动排序互不混用", async () => {
  const m = await create({ useCuratedAccounts: true }),
    s = getSettings();
  const a = event(
    article({
      author: "simonw",
      metrics: { likes: 1 },
      metadata: { discoverySources: ["x", "google"] },
    }),
    {
      monitorId: m.id,
      details: { importance: "high", value: 80, publishedAt: null },
    },
  );
  const b = event(article({ author: "ordinary", metrics: { likes: 100 } }), {
    monitorId: m.id,
    details: {
      importance: "medium",
      value: 80,
      publishedAt: Date.now() - 10000,
    },
  });
  const all = { hours: "all" } as const;
  expect(filterFeed([b, a], feedFilterInput.parse(all), [m], s)[0].id).toBe(
    a.id,
  );
  expect(
    filterFeed(
      [b, a],
      feedFilterInput.parse({ ...all, sort: "heat" }),
      [m],
      s,
    )[0].id,
  ).toBe(b.id);
  expect(
    filterFeed(
      [b, a],
      feedFilterInput.parse({
        ...all,
        sources: ["google", "bing"],
        importance: "high",
        accountScope: "curated",
      }),
      [m],
      s,
    ).map((e) => e.id),
  ).toEqual([a.id]);
  expect(
    filterFeed(
      [a, b],
      feedFilterInput.parse({ ...all, sort: "publication" }),
      [m],
      s,
    )[1].id,
  ).toBe(a.id);
  expect(
    filterFeed(
      [a, b],
      feedFilterInput.parse({ timeField: "publication" }),
      [m],
      s,
    ).map((e) => e.id),
  ).toEqual([b.id]);
  expect(socialHeat(b)).toBe(100);
});
it("发布时间和首次发现排序不随转述或 updatedAt 刷新", async () => {
  const m = await create(),
    s = getSettings(),
    now = Date.now();
  const old = event(article(), {
    monitorId: m.id,
    createdAt: now - 48 * 3600000,
    updatedAt: now,
    details: {
      value: 80,
      firstDiscoveredAt: now - 48 * 3600000,
      publishedAt: now - 72 * 3600000,
    },
  });
  expect(filterFeed([old], feedFilterInput.parse({}), [m], s)).toHaveLength(0);
  expect(
    filterFeed([old], feedFilterInput.parse({ hours: "all" }), [m], s),
  ).toHaveLength(1);
});
it("完整事件库先过滤再分页，200 条以外的匹配也能找到，旧事件重要性未评估", async () => {
  const m = await create();
  const a = article({
    source: "google",
    metadata: { discoverySources: ["google"] },
  });
  persistArticles(m, [a]);
  for (let i = 0; i < 231; i++) {
    const e = event(a, {
      monitorId: m.id,
      title: i === 0 ? "rare match" : "normal",
      createdAt: Date.now() - i,
      details: { value: 80 },
    });
    const { articles: _, ...row } = e;
    getDb().insert(events).values(row).run();
  }
  const f = feedFilterInput.parse({
    hours: "all",
    query: "rare",
    sources: ["google"],
    importance: "unassessed",
  });
  expect(queryEvents(f).total).toBe(1);
  const page = queryEvents(feedFilterInput.parse({ hours: "all" }), 2);
  expect(page.total).toBe(231);
  expect(page.items).toHaveLength(30);
  expect(page.page).toBe(2);
  const res = await GET(
    new Request(
      "http://localhost/api/events?" +
        new URLSearchParams({ filters: JSON.stringify(f) }),
    ),
    { params: Promise.resolve({ path: ["events"] }) },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).total).toBe(1);
});
it("AI 深度分析保存独立重要性，无安全中断证据不能称紧急", async () => {
  const m = await create(),
    a = article({ author: "cursor_ai" });
  const f = (async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(
      JSON.parse(String(init?.body)).messages[1].content,
    );
    return json({
      choices: [
        {
          message: {
            content: JSON.stringify(
              deepResponse(input, {
                importance: "urgent",
                importanceReason: "New update",
              }),
            ),
          },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 100 },
    });
  }) as Fetcher;
  const r = await analyzeEvent(
    m,
    [a],
    [screened(a.id) as any],
    "importance-test",
    f,
  );
  expect(r.result.importance).toBe("high");
  expect(r.result.importanceReason).toContain("紧急级别缺少");
});
it("分阶段发布的事件保留重要性与真实发现时间，验证仍生效", async () => {
  const m = await create(),
    a = article({ author: "cursor_ai" });
  persistArticles(m, [a]);
  enqueuePipeline(m);
  const f = (async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(
      JSON.parse(String(init?.body)).messages[1].content,
    );
    return json({
      choices: [
        {
          message: { content: JSON.stringify(stageResponse(input)) },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 100 },
    });
  }) as Fetcher;
  await processNextAnalysis(f, m.id);
  await processNextAnalysis(f, m.id);
  const e = dashboard().events[0];
  expect(e.details?.importance).toBe("high");
  expect(e.details?.firstDiscoveredAt).toBe(a.collectedAt);
  expect(e.details?.publishedAt).toBe(a.publishedAt);
});

it("多个 X 调用入口共享请求间隔，过长排队拒绝而非无限等待", () => {
  vi.stubEnv("X_REQUEST_INTERVAL_MS", "6000");
  expect(claimXSlot(10000)).toBe(0);
  expect(claimXSlot(10000)).toBe(6000);
  expect(claimXSlot(10000)).toBe(12000);
  expect(() => claimXSlot(10000)).toThrow("排队较多");
});

it("初筛优先精选账号，保留等待年龄避免普通来源饥饿", async () => {
  const m = await create({ useCuratedAccounts: true }),
    s = getSettings(),
    now = Date.now();
  const curated = article({ author: "simonw", metrics: { likes: 0 } }),
    ordinary = article({ metrics: { likes: 1000 } });
  expect(
    fairCandidates([ordinary, curated], 1, 0, s.publishers, now, {
      monitor: m,
      accounts: s.xAccounts,
    })[0].id,
  ).toBe(curated.id);
  const waited = { ...ordinary, collectedAt: now - 72 * 3600000 };
  expect(
    fairCandidates([waited, curated], 1, 0, s.publishers, now, {
      monitor: m,
      accounts: s.xAccounts,
    })[0].id,
  ).toBe(waited.id);
});
