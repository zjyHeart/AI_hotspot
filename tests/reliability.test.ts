import { stageResponse } from "./analysis-fixtures";
import { processNextAnalysis } from "../src/server/pipeline";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitors, articleMonitors } from "../src/server/schema";
import { randomUUID } from "node:crypto";
import { monitorInput, type Article, type Monitor } from "../src/shared/types";
import {
  collectTwitter,
  collectGithubReleases,
  twitterQuery,
} from "../src/server/sources";
import {
  qualityDecision,
  qualityTags,
  fairCandidates,
  normalizeUrl,
  fingerprint,
  policyFor,
  sameContent,
} from "../src/server/quality";
import {
  collectWeb,
  reserveSearch,
  searchUsage,
  extractBody,
  fetchBody,
  webDue,
  enrichArticles,
} from "../src/server/web-sources";
import {
  DEFAULT_PUBLISHERS,
  getSettings,
  writeSetting,
} from "../src/server/config";
import { evidenceStatus, hotspotScore } from "../src/server/ai";
import { saveMonitor, dashboard } from "../src/server/repository";
import { persistArticles, scanMonitor } from "../src/server/scanner";
import {
  safeError,
  isPublicAddress,
  requestText,
  type Fetcher,
} from "../src/server/http";
import { getStore } from "../src/server/db";

const now = Date.now(),
  text =
    "A detailed announcement describing a new AI coding workflow with concrete implementation changes.";
const monitor = (): Monitor => ({
  ...monitorInput.parse({
    kind: "keyword",
    name: "质量测试",
    keywords: "AI Agent",
    sources: ["x", "rss", "google", "bing"],
    active: false,
  }),
  id: "quality-test",
  createdAt: now - 60000,
  lastRunAt: null,
  nextRunAt: now,
  lastStatus: "idle",
  leaseUntil: 0,
  scanRequested: false,
});
const article = (patch: Partial<Article> = {}): Article => ({
  id: randomUUID(),
  source: "x",
  externalId: randomUUID(),
  title: text,
  text,
  url: "https://x.com/cursor_ai/status/1",
  author: "cursor_ai",
  publishedAt: now - 10000,
  collectedAt: now,
  metrics: { likes: 0, reposts: 0 },
  originKey: "x:cursor_ai",
  isRepost: false,
  metadata: { isReply: false, contentKind: "post", contentStatus: "native" },
  ...patch,
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const webResponse = (
  url = "https://huggingface.co/blog/test?utm_source=google",
) => ({
  search_metadata: { status: "Success" },
  organic_results: [
    {
      title: "Test announcement",
      link: url,
      snippet: text,
      date: "1 hour ago",
    },
  ],
});
const html = `<!doctype html><html><head><title>Verified announcement</title><meta property="article:published_time" content="${new Date(now - 10000).toISOString()}"></head><body><article><h1>Verified announcement</h1>${Array.from({ length: 8 }, () => "<p>" + text.repeat(3) + "</p>").join("")}</article></body></html>`;
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "/tmp/signal-reliability-" + randomUUID() + ".db");
  vi.stubEnv("SERPAPI_API_KEY", "test-serp-secret");
  vi.stubEnv("TWITTERAPI_API_KEY", "test-x-secret");
  vi.stubEnv("PACKY_API_KEY", "test-ai-secret");
  vi.stubEnv("AI_MODEL", "test-model");
  vi.stubEnv("AI_OUTPUT_MODE", "json_object");
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "EMAIL_FROM",
    "EMAIL_TO",
    "GITHUB_TOKEN",
  ])
    vi.stubEnv(key, "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("X 候选质量", () => {
  it("回复保留供 AI 分析，纯转发过滤，原创零回复公告保留", () => {
    expect(
      qualityDecision(
        article({ metadata: { isReply: true }, metrics: { likes: 1000 } }),
        monitor(),
        DEFAULT_PUBLISHERS,
      ),
    ).toBeUndefined();
    expect(
      qualityDecision(
        article({ isRepost: true }),
        monitor(),
        DEFAULT_PUBLISHERS,
      ),
    ).toBe("纯转发");
    expect(
      qualityDecision(article(), monitor(), DEFAULT_PUBLISHERS),
    ).toBeUndefined();
  });
  it("未知类型和低互动只标记，不阻止 AI 分析", () => {
    expect(
      qualityDecision(article({ metadata: {} }), monitor(), DEFAULT_PUBLISHERS),
    ).toBeUndefined();
    const a = article({ author: "small_developer" });
    expect(qualityDecision(a, monitor(), DEFAULT_PUBLISHERS)).toBeUndefined();
    expect(qualityTags(a, monitor())).toContain("低互动");
    expect(
      qualityDecision(
        {
          ...a,
          metadata: {
            isReply: false,
            linkedUrls: ["https://example.com/release"],
          },
        },
        monitor(),
        DEFAULT_PUBLISHERS,
      ),
    ).toBeUndefined();
  });
  it("关注名单绕过互动门槛但不绕过回复/屏蔽过滤，也不自动授予可信身份", () => {
    const m = monitor();
    m.quality.followedAccounts = ["small_developer"];
    const a = article({ author: "small_developer" });
    expect(qualityDecision(a, m, DEFAULT_PUBLISHERS)).toBeUndefined();
    expect(
      evidenceStatus(
        "supported",
        [{ articleId: a.id, role: "first_party", excerpt: text }],
        [a],
      ),
    ).toBe("unverified");
    m.quality.blockedAccounts = ["small_developer"];
    expect(qualityDecision(a, m, DEFAULT_PUBLISHERS)).toBe("屏蔽账号");
  });
  it("推广关键词只做标签，价值交给 AI 判断", () => {
    expect(
      qualityDecision(
        article({ author: "developer", metrics: { reposts: 5 } }),
        monitor(),
        DEFAULT_PUBLISHERS,
      ),
    ).toBeUndefined();
    expect(
      qualityDecision(
        article({
          text: "Join our giveaway and airdrop for AI agents today",
          metrics: { likes: 5000 },
        }),
        monitor(),
        DEFAULT_PUBLISHERS,
      ),
    ).toBeUndefined();
  });
  it("上游不排除回复，诊断记录采集数量", async () => {
    const m = monitor();
    expect(twitterQuery(m, now - 60000, now)).not.toContain("-filter:replies");
    const tweets = [false, true].map((isReply, i) => ({
      id: String(i),
      text,
      createdAt: new Date(now - 10000).toISOString(),
      author: { userName: "cursor_ai" },
      isReply,
      replyCount: 0,
    }));
    const result = await collectTwitter(
      m,
      { from: now - 60000, to: now, cursor: "" },
      1,
      (async () =>
        response({ tweets, has_next_page: false, next_cursor: "" })) as Fetcher,
    );
    expect(result.report).toMatchObject({
      count: 2,
      rawCount: 2,
      filteredCount: 0,
      filterReasons: {},
    });
  });
});
describe("来源调度与数据库增量升级", () => {
  it("X 积压不挤占其他合格来源，批次1时跨轮轮转", () => {
    const xs = Array.from({ length: 100 }, () => article());
    const sources: Article[] = ["rss", "hn", "github"].map((source) =>
      article({ source: source as Article["source"] }),
    );
    const picked = fairCandidates(
      [...xs, ...sources],
      12,
      0,
      DEFAULT_PUBLISHERS,
    );
    for (const a of sources)
      expect(picked.some((p) => p.id === a.id)).toBe(true);
    const heads = new Set(
      Array.from(
        { length: 4 },
        (_, i) =>
          fairCandidates([...xs, ...sources], 1, i, DEFAULT_PUBLISHERS)[0]
            .source,
      ),
    );
    expect(heads.size).toBe(4);
  });
  it("只有 X 时不伪造来源，并能填满现有容量", () => {
    expect(
      fairCandidates(
        Array.from({ length: 20 }, () => article()),
        12,
        0,
        DEFAULT_PUBLISHERS,
      ),
    ).toHaveLength(12);
    expect(fairCandidates([], 12, 0, DEFAULT_PUBLISHERS)).toEqual([]);
  });
  it("迁移保持旧表并增加元数据、频道策略及过滤审计字段", () => {
    const sqlite = getStore().sqlite;
    expect(
      (sqlite.pragma("table_info(monitors)") as { name: string }[]).some(
        (c) => c.name === "quality",
      ),
    ).toBe(true);
    expect(
      (
        sqlite.pragma("table_info(article_monitors)") as { name: string }[]
      ).some((c) => c.name === "filter_reason"),
    ).toBe(true);
  });
  it("被过滤内容保留审计但不显示为原始候选或待分析任务", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "过滤",
        keywords: "AI",
        sources: ["x"],
        active: false,
      }),
    );
    m.quality.blockedAccounts=["blocked_author"];
    persistArticles(m, [article({ author:"blocked_author",metadata: { isReply: true } })]);
    expect(dashboard().rawArticles).toHaveLength(0);
    expect(dashboard().pendingCount).toBe(0);
    expect(
      dashboard().sourceStats.find((s) => s.source === "x")?.filtered,
    ).toBe(1);
  });
});
describe("搜索预算、协议和缓存", () => {
  it("Google/Bing 独立使用正确 engine，共享 Key，摘要日期不伪装发布时间", async () => {
    const f = vi.fn(async () => response(webResponse()));
    for (const engine of ["google", "bing"] as const) {
      const result = await collectWeb(monitor(), engine, f as Fetcher);
      expect(result.articles[0].publishedAt).toBe(0);
      expect(result.articles[0].metadata?.contentStatus).toBe("snippet");
    }
    expect(f.mock.calls).toHaveLength(2);
    expect(searchUsage().day).toBe(2);
  });
  it("缓存命中不增加调用或预算，缺 Key 为未配置", async () => {
    const f = vi.fn(async () => response(webResponse()));
    await collectWeb(monitor(), "google", f as Fetcher);
    await collectWeb(monitor(), "google", f as Fetcher);
    expect(f).toHaveBeenCalledOnce();
    expect(searchUsage().day).toBe(1);
    vi.stubEnv("SERPAPI_API_KEY", "");
    expect(
      (await collectWeb(monitor(), "bing", f as Fetcher)).report.status,
    ).toBe("unconfigured");
  });
  it("日/月/核验额度任一到达即阻止请求，并持久化计数", async () => {
    writeSetting("app", {
      searchDailyLimit: 1,
      searchMonthlyLimit: 2,
      verificationDailyLimit: 0,
    });
    expect(reserveSearch(true)).toBe(false);
    expect(reserveSearch()).toBe(true);
    const f = vi.fn();
    expect(
      (await collectWeb(monitor(), "google", f as Fetcher)).report.status,
    ).toBe("budget");
    expect(f).not.toHaveBeenCalled();
    expect(searchUsage()).toMatchObject({ day: 1, month: 1, verification: 0 });
    writeSetting("app", { searchDailyLimit: 10, searchMonthlyLimit: 1 });
    expect(reserveSearch()).toBe(false);
  });
  it("并发预留在 SQLite 事务中不会突破全局上限", async () => {
    writeSetting("app", { searchDailyLimit: 3 });
    const results = await Promise.all(
      Array.from({ length: 15 }, async () => reserveSearch()),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(searchUsage().day).toBe(3);
  });
  it("错误响应不会被当作空成功，失败退避且隐藏密钥", async () => {
    const f = vi.fn(async () =>
      response({
        search_metadata: { status: "Error" },
        error: "test-serp-secret api_key=test-serp-secret",
      }),
    );
    const result = await collectWeb(monitor(), "google", f as Fetcher);
    expect(result.report.status).toBe("error");
    expect(result.report.message).not.toContain("test-serp-secret");
    await collectWeb(monitor(), "google", f as Fetcher);
    expect(f).toHaveBeenCalledOnce();
    expect(
      safeError(new Error("https://serpapi.com?api_key=another-value")),
    ).not.toContain("another-value");
  });
  it("网页每4小时到期，不受频道基础30分钟频率误触发", () => {
    const m = monitor();
    writeSetting(`web-at:${m.id}:google`, now);
    expect(webDue(m, "google", now + 30 * 60000)).toBe(false);
    expect(webDue(m, "google", now + 240 * 60000)).toBe(true);
    expect(policyFor(m).webIntervalMinutes).toBe(240);
  });
});
describe("原文获取与证据独立性", () => {
  it("HTML 提取正文和发布日期，不执行脚本，不接受跨域 canonical", () => {
    const result = extractBody(
      html
        .replace("<body>", "<body><script>globalThis.attack=1</script>")
        .replace(
          "</head>",
          '<link rel="canonical" href="https://attacker.test/"></head>',
        ),
      "https://huggingface.co/blog/test",
    );
    expect(result.metadata?.contentStatus).toBe("full");
    expect(result.publishedAt).toBeGreaterThan(0);
    expect(result.text).not.toContain("globalThis.attack");
    expect(result.metadata?.originalUrl).toBe(
      "https://huggingface.co/blog/test",
    );
  });
  it("日期未知或未来时不提升新鲜度；薄页面不伪造正文", () => {
    const unknown = extractBody(
      html.replace(/<meta[^>]+>/, ""),
      "https://example.com/post",
    );
    expect(unknown.publishedAt).toBe(0);
    expect(
      hotspotScore(90, [article({ ...unknown })], now).scoreReason,
    ).toContain("新鲜度 0/20");
    expect(() =>
      extractBody(
        "<html><body>Login required</body></html>",
        "https://example.com",
      ),
    ).toThrow("正文");
  });
  it("URL 归一仅删除跟踪参数，保留版本和正文参数", () => {
    expect(
      normalizeUrl("https://example.com/post?version=2&utm_source=x#section"),
    ).toBe("https://example.com/post?version=2");
  });
  it("内网正文和跳转被阻止，失败记录不冒充全文", async () => {
    const f = vi.fn();
    const result = await fetchBody("http://127.0.0.1/private", f as Fetcher);
    expect(result.error).toBeTruthy();
    expect(f).not.toHaveBeenCalled();
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });
  it("Google/Bing 同一原文只有一个记录和一个待处理任务，保留发现渠道", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "去重",
        keywords: "AI",
        sources: ["google", "bing"],
        active: false,
      }),
    );
    const make = (source: "google" | "bing") =>
      article({
        id: fingerprint("web:https://huggingface.co/blog/test"),
        source,
        url: "https://huggingface.co/blog/test",
        originKey: "huggingface.co",
        metadata: {
          contentKind: "web",
          contentStatus: "snippet",
          discoverySources: [source],
        },
      });
    persistArticles(m, [make("google"), make("bing")]);
    expect(dashboard().pendingCount).toBe(1);
    expect(dashboard().rawArticles).toHaveLength(1);
    expect(dashboard().rawArticles[0].metadata?.discoverySources).toEqual([
      "google",
      "bing",
    ]);
  });
  it("完全相同的转载正文被合并，避免不同域名假装两份证据", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "转载",
        keywords: "AI",
        sources: ["rss"],
        active: false,
      }),
    );
    persistArticles(m, [
      article({
        source: "rss",
        url: "https://huggingface.co/blog/one",
        originKey: "huggingface.co",
        metadata: {
          contentKind: "web",
          contentStatus: "full",
          contentHash: "same-body",
        },
      }),
      article({
        source: "rss",
        url: "https://blog.google/two",
        originKey: "blog.google",
        metadata: {
          contentKind: "web",
          contentStatus: "full",
          contentHash: "same-body",
        },
      }),
    ]);
    expect(dashboard().rawArticles).toHaveLength(1);
  });
  it("摘要/仓库更新不能升级为来源支持，配置小众项目后可支持其实际发布声明", () => {
    const a = article({
      source: "google",
      url: "https://smallproject.example/release",
      originKey: "smallproject.example",
      metadata: { contentKind: "web", contentStatus: "full" },
    });
    const e = [
      { articleId: a.id, role: "first_party" as const, excerpt: text },
    ];
    expect(evidenceStatus("supported", e, [a])).toBe("unverified");
    writeSetting("app", {
      publishers: [
        {
          id: "small-project",
          name: "Small Project",
          domains: ["smallproject.example"],
          xAccounts: [],
          githubOwners: [],
          proofUrl: "https://smallproject.example/",
        },
      ],
    });
    expect(evidenceStatus("supported", e, [a])).toBe("supported");
    expect(
      evidenceStatus("supported", e, [
        { ...a, metadata: { contentStatus: "snippet" } },
      ]),
    ).toBe("unverified");
    expect(
      evidenceStatus("supported", e, [
        { ...a, metadata: { contentKind: "repository" } },
      ]),
    ).toBe("unverified");
  });
  it("同发布者、同正文不计独立；两组已识别独立报道才能升级", () => {
    const one = article({
      source: "rss",
      url: "https://techcrunch.com/a",
      originKey: "techcrunch.com",
      metadata: { contentStatus: "full", contentHash: "one" },
    });
    const two = article({
      source: "rss",
      url: "https://arstechnica.com/b",
      originKey: "arstechnica.com",
      metadata: { contentStatus: "full", contentHash: "two" },
    });
    const evidence = [one, two].map((a) => ({
      articleId: a.id,
      role: "independent" as const,
      excerpt: text,
    }));
    expect(evidenceStatus("corroborated", evidence, [one, two])).toBe(
      "corroborated",
    );
    expect(
      evidenceStatus("corroborated", evidence, [
        one,
        { ...two, metadata: { contentStatus: "full", contentHash: "one" } },
      ]),
    ).toBe("unverified");
  });
  it("GitHub 发布只采用实际 Release，忽略草稿和窗口外旧版本", async () => {
    const m = monitor();
    m.quality.githubRepos = ["vercel/next.js"];
    const make = (id: number, patch = {}) => ({
      id,
      html_url: `https://github.com/vercel/next.js/releases/tag/v${id}`,
      name: "Release",
      tag_name: "v" + id,
      body: text,
      draft: false,
      prerelease: false,
      published_at: new Date(now - 1000).toISOString(),
      ...patch,
    });
    const out = await collectGithubReleases(m, now - 60000, now, (async () =>
      response([
        make(1),
        make(2, { draft: true }),
        make(3, { published_at: new Date(now - 86400000).toISOString() }),
      ])) as Fetcher);
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0].metadata?.contentKind).toBe("release");
    expect(out.articles[0].metrics.stars).toBeUndefined();
  });
});

describe("补充可靠性边界与完整链路", () => {
  it("跨域重定向按实际响应域名判断发布者，拒绝非 HTML", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("huggingface")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://example.com/mirror" },
          })
        : new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const a = article({
      source: "google",
      url: "https://huggingface.co/blog/redirect",
      originKey: "huggingface.co",
      metadata: { contentKind: "web", contentStatus: "snippet" },
    });
    const out = await enrichArticles([a], monitor(), f as Fetcher);
    expect(out[0].url).toBe("https://example.com/mirror");
    expect(out[0].originKey).toBe("example.com");
    expect(
      evidenceStatus(
        "supported",
        [{ articleId: a.id, role: "first_party", excerpt: text }],
        out,
      ),
    ).toBe("unverified");
    const pdf = await fetchBody(
      "https://example.com/manual.pdf",
      (async () =>
        new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        })) as Fetcher,
    );
    expect(pdf.error).toContain("HTML");
  });
  it("重定向到内网在第二次请求前被阻止", async () => {
    const f = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
    );
    await expect(
      requestText("https://example.com/redirect", {}, f as Fetcher, true),
    ).rejects.toThrow("内网");
    expect(f).toHaveBeenCalledOnce();
  });
  it("缺失结果的畸形成功不能被搜索信息字段掩盖", async () => {
    const malformed = await collectWeb(monitor(), "google", (async () =>
      response({
        search_metadata: { status: "Success" },
        search_information: { query_displayed: "AI" },
      })) as Fetcher);
    expect(malformed.report.status).toBe("error");
    const empty = await collectWeb(monitor(), "bing", (async () =>
      response({
        search_metadata: { status: "Success" },
        search_information: { organic_results_state: "Fully empty" },
      })) as Fetcher);
    expect(empty.report.status).toBe("ok");
    expect(empty.articles).toHaveLength(0);
  });
  it("目录不同但正文近乎相同的转载不计两组独立证据", () => {
    const long = Array.from(
      { length: 30 },
      (_, i) =>
        `Release detail ${i}: a distinct coding workflow and model evaluation with engineering evidence. `,
    ).join("");
    const a = article({
      source: "rss",
      url: "https://techcrunch.com/a",
      originKey: "techcrunch.com",
      text: long,
      metadata: { contentStatus: "full" },
    });
    const b = article({
      source: "rss",
      url: "https://arstechnica.com/b",
      originKey: "arstechnica.com",
      text: "Editor introduction. " + long,
      metadata: { contentStatus: "full" },
    });
    expect(sameContent(a, b)).toBe(true);
    expect(
      evidenceStatus(
        "corroborated",
        [a, b].map((x) => ({
          articleId: x.id,
          role: "independent",
          excerpt: long.slice(0, 100),
        })),
        [a, b],
      ),
    ).toBe("unverified");
  });
  it("修改过滤策略后可恢复原来被过滤的候选，仍保留审计记录", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "重评",
        keywords: "AI",
        sources: ["x"],
        active: false,
      }),
    );
    const item = article({
      author:"blocked_author",metadata: { isReply: true, contentKind: "post", contentStatus: "native" },
    });
    m.quality.blockedAccounts=["blocked_author"];
    persistArticles(m, [item]);
    expect(dashboard().pendingCount).toBe(0);
    const changed = await saveMonitor(
      { ...m, quality: { ...m.quality, blockedAccounts: [] } },
      m.id,
    );
    persistArticles(changed, [item]);
    expect(dashboard().pendingCount).toBe(1);
    expect(getStore().db.select().from(articleMonitors).all()).toHaveLength(1);
  });
  it("同文跨引擎发现统计可重叠，保留一份正文和处理任务", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "渠道统计",
        keywords: "AI",
        sources: ["google", "bing"],
        active: false,
      }),
    );
    const first = article({
      source: "google",
      url: "https://huggingface.co/blog/count",
      originKey: "huggingface.co",
      metadata: {
        contentKind: "web",
        contentStatus: "full",
        contentHash: "first",
        discoverySources: ["google"],
      },
    });
    persistArticles(m, [first]);
    persistArticles(m, [
      {
        ...first,
        source: "bing",
        text: "snippet",
        metadata: {
          contentKind: "web",
          contentStatus: "snippet",
          discoverySources: ["bing"],
        },
      },
    ]);
    const d = dashboard();
    expect(d.rawArticles).toHaveLength(1);
    expect(d.rawArticles[0].text).toBe(text);
    for (const source of ["google", "bing"])
      expect(d.sourceStats.find((x) => x.source === source)?.collected).toBe(1);
  });
  it("一轮扫描与事件补查共享原文请求上限", async () => {
    const budget = { remaining: 1 };
    const f = vi.fn(
      async () =>
        new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const make = (n: number) =>
      article({
        source: "google",
        url: `https://example.com/budget/${n}`,
        metadata: { contentKind: "web", contentStatus: "snippet" },
      });
    await enrichArticles([make(1), make(2)], monitor(), f as Fetcher, budget);
    await enrichArticles([make(3)], monitor(), f as Fetcher, budget);
    expect(f).toHaveBeenCalledOnce();
    expect(budget.remaining).toBe(0);
  });
  it("旧库增量升级前自动备份，保留监控和历史数据", () => {
    const directory = mkdtempSync(join(tmpdir(), "signal-upgrade-"));
    const migrations = join(directory, "legacy-migrations");
    mkdirSync(join(migrations, "meta"), { recursive: true });
    const journal = JSON.parse(
      readFileSync("drizzle/meta/_journal.json", "utf-8"),
    );
    journal.entries = journal.entries.slice(0, 1);
    writeFileSync(
      join(migrations, "meta/_journal.json"),
      JSON.stringify(journal),
      "utf-8",
    );
    writeFileSync(
      join(migrations, "0000_hesitant_owl.sql"),
      readFileSync("drizzle/0000_hesitant_owl.sql", "utf-8"),
      "utf-8",
    );
    const file = join(directory, "old.db");
    const sqlite = new Database(file);
    migrate(drizzle(sqlite), { migrationsFolder: migrations });
    sqlite
      .prepare("insert into settings(key,value) values(?,?)")
      .run("legacy-record", JSON.stringify({ note: "旧数据UTF-8" }));
    sqlite.close();
    vi.stubEnv("DATABASE_URL", file);
    const migrated = getStore().sqlite;
    expect(
      migrated
        .prepare("select value from settings where key='legacy-record'")
        .get(),
    ).toEqual({ value: JSON.stringify({ note: "旧数据UTF-8" }) });
    const backups = readdirSync(join(directory, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(directory, "backups", backups[0]), {
      readonly: true,
    });
    expect(
      (backup.pragma("table_info(monitors)") as { name: string }[]).some(
        (x) => x.name === "quality",
      ),
    ).toBe(false);
    expect(backup.prepare("select count(*) as n from settings").get()).toEqual({
      n: 1,
    });
    backup.close();
  });
  it("混合采集一源失败仍分析其他源，重复扫描和新策略不会重发历史通知", async () => {
    const m = await saveMonitor(
      monitorInput.parse({
        kind: "keyword",
        name: "多源流程",
        keywords: "AI",
        sources: ["x", "hn", "google", "bing", "github"],
        active: false,
        quality: { githubRepos: ["vercel/next.js"] },
      }),
    );
    getStore()
      .db.update(monitors)
      .set({ createdAt: now - 60000 })
      .where(eq(monitors.id, m.id))
      .run();
    let seenSources: string[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("twitterapi.io"))
        return response({
          tweets: [
            {
              id: "mix",
              text,
              createdAt: new Date(now - 10000).toISOString(),
              author: { userName: "cursor_ai" },
              isReply: false,
            },
          ],
          has_next_page: false,
          next_cursor: "",
        });
      if (href.includes("algolia"))
        return new Response("rate limit", { status: 429 });
      if (href.includes("serpapi"))
        return response(webResponse("https://huggingface.co/blog/mixed"));
      if (href.includes("api.github.com"))
        return response([
          {
            id: 1,
            html_url: "https://github.com/vercel/next.js/releases/tag/v1",
            name: "Release",
            tag_name: "v1",
            body: text + " Specific release version details.",
            draft: false,
            prerelease: false,
            published_at: new Date(now - 1000).toISOString(),
          },
        ]);
      if (href.includes("huggingface.co"))
        return new Response(html, { headers: { "content-type": "text/html" } });
      if (href.includes("/chat/completions")) {
        const input = JSON.parse(
          JSON.parse(String(init?.body)).messages[1].content,
        );
        seenSources = [...new Set([...seenSources,...input.articles.map((x: { source: string }) => x.source)])];
        const a = input.articles.find(
          (x: { source: string }) => x.source === "x",
        );
        return response({choices:[{message:{content:JSON.stringify(stageResponse(input))},finish_reason:"stop"}],usage:{total_tokens:10}});
      }
      throw new Error("Unexpected call");
    }) as Fetcher;
    await scanMonitor(m.id, f);
    for(let i=0;i<6;i++)await processNextAnalysis(f,m.id);
    const d = dashboard();
    expect(d.runs[0].status).toBe("partial");
    expect(d.runs[0].reports.find((r) => r.source === "hn")?.status).toBe(
      "error",
    );
    expect(seenSources).toEqual(
      expect.arrayContaining(["x", "github", "google"]),
    );
    expect(d.notifications).toHaveLength(1);
    await scanMonitor(m.id, f);
    for(let i=0;i<6;i++)await processNextAnalysis(f,m.id);
    expect(dashboard().notifications).toHaveLength(1);
  });
});

it("同域 canonical 不能静默抹掉版本参数或合并另一篇文章", () => {
  const a = extractBody(
    html.replace(
      "</head>",
      '<link rel="canonical" href="https://example.com/another"></head>',
    ),
    "https://example.com/post?version=2",
  );
  expect(a.metadata?.originalUrl).toBe("https://example.com/post?version=2");
  const b = extractBody(
    html.replace(
      "</head>",
      '<link rel="canonical" href="https://example.com/post"></head>',
    ),
    "https://example.com/post?version=2",
  );
  expect(b.metadata?.originalUrl).toBe("https://example.com/post?version=2");
});
it("缺少旧记录正文类型与已失效引用时，不能升级证据状态", () => {
  const a = article({ metadata: {} });
  expect(
    evidenceStatus(
      "supported",
      [{ articleId: a.id, role: "first_party", excerpt: text }],
      [a],
    ),
  ).toBe("unverified");
  expect(
    evidenceStatus(
      "supported",
      [
        {
          articleId: a.id,
          role: "first_party",
          excerpt: "An outdated excerpt missing in the current article.",
        },
      ],
      [article({ id: a.id })],
    ),
  ).toBe("unverified");
});
