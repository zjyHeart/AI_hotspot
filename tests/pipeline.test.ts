import { stageResponse } from "./analysis-fixtures";
import { processNextAnalysis } from "../src/server/pipeline";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { monitorInput, type Monitor, type Article } from "../src/shared/types";
import { collectTwitter, twitterQuery, hash } from "../src/server/sources";
import {
  ServiceError,
  isPublicAddress,
  safeError,
  type Fetcher,
} from "../src/server/http";
import {
  analyze,
  evidenceStatus,
  hotspotScore,
  validateEvidence,
} from "../src/server/ai";
import { openRouterEndpoint, aiCompletion } from "../src/server/ai-client";
import {
  saveMonitor,
  dashboard,
  findMonitor,
  markRead,
  requestScan,
} from "../src/server/repository";
import {
  scanMonitor,
  claimMonitor,
  canNotify,
  nextDueMonitor,
} from "../src/server/scanner";
import { getDb } from "../src/server/db";
import {
  monitors,
  checkpoints,
  notifications,
  runs,
} from "../src/server/schema";
import {
  acceptedTarget,
  deliverNotifications,
  testMail,
} from "../src/server/mail";
import nodemailer from "nodemailer";

const now = Date.now();
const text =
  "Cursor released a new coding agent with an improved task workflow.";
const m = (): Monitor => ({
  ...monitorInput.parse({
    name: "AI 编程测试",
    kind: "keyword",
    keywords: "AI 编程",
    aliases: "AI coding, Cursor",
    sources: ["x"],
  }),
  id: "test-monitor",
  createdAt: now - 60000,
  lastRunAt: null,
  nextRunAt: now,
  lastStatus: "idle",
  leaseUntil: 0,
  scanRequested: false,
});
const tweet = (id = "t1") => ({
  id,
  url: `https://x.com/cursor_ai/status/${id}`,
  text,
  isReply: false,
  inReplyToId: "",
  createdAt: new Date(now - 10000).toISOString(),
  author: { userName: "cursor_ai" },
  likeCount: 100,
  replyCount: 10,
  retweetCount: 5,
});
const a = (id = "t1"): Article => ({
  id: hash(`x:${id}`),
  externalId: id,
  source: "x",
  title: text,
  text,
  url: `https://x.com/cursor_ai/status/${id}`,
  author: "cursor_ai",
  publishedAt: now - 10000,
  collectedAt: now,
  metrics: { likes: 100, replies: 10, reposts: 5 },
  originKey: "x:cursor_ai",
  isRepost: false,
  metadata: { isReply: false, contentKind: "post", contentStatus: "native" },
});
const event = (id = "t1") => ({
  eventKey: "cursor-agent-task-update",
  title: "Cursor 更新编码代理工作流",
  summary: "采集到的一手声明介绍了新的编码代理工作流。",
  relevance: 92,
  credibility: "supported",
  reason: "引用来自 Cursor 作者发布的原始帖子；没有额外独立核实。",
  evidence: [{ articleId: a(id).id, role: "first_party", excerpt: text }],
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function pipelineFetcher(aiData: unknown = { events: [event()] }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("twitterapi.io"))
      return json({ tweets: [tweet()], has_next_page: false, next_cursor: "" });
    if (href.includes("/chat/completions")) {
      const input = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content,
      );
      const data =
        input.knownGroups || input.group ? stageResponse(input) : aiData;
      return json({
        choices: [
          { message: { content: JSON.stringify(data) }, finish_reason: "stop" },
        ],
        usage: { total_tokens: 123 },
      });
    }
    throw new Error("Unexpected network call");
  }) as unknown as Fetcher;
}
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", `/tmp/signal-desk-test-${randomUUID()}.db`);
  vi.stubEnv("TWITTERAPI_API_KEY", "test-x-secret");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-secret");
  vi.stubEnv("AI_MODEL", "test-model");
  vi.stubEnv("AI_OUTPUT_MODE", "json_schema");
  vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
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

describe("X 时间窗口与分页", () => {
  it("使用 Unix 秒和显式 Latest，不使用旧日期过滤", async () => {
    const f = vi.fn(async (_url: string | URL | Request) =>
      json({ tweets: [], has_next_page: false, next_cursor: "" }),
    );
    await collectTwitter(
      m(),
      { from: now - 1800000, to: now, cursor: "" },
      3,
      f as Fetcher,
    );
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.searchParams.get("queryType")).toBe("Latest");
    expect(url.searchParams.get("query")).toContain(
      `since_time:${Math.floor((now - 1800000) / 1000)}`,
    );
    expect(url.searchParams.get("query")).not.toMatch(/since:\d{4}-/);
  });
  it("短页且 has_next_page=true 时继续分页，并按 ID 去重", async () => {
    let count = 0;
    const f = vi.fn(async () =>
      json(
        ++count === 1
          ? { tweets: [tweet()], has_next_page: true, next_cursor: "page2" }
          : { tweets: [tweet()], has_next_page: false, next_cursor: "" },
      ),
    );
    const out = await collectTwitter(
      m(),
      { from: now - 1800000, to: now, cursor: "" },
      3,
      f as Fetcher,
    );
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.articles).toHaveLength(1);
    expect(out.state?.completedAt).toBe(now);
  });
  it("达到页数上限保存固定窗口和后续游标", async () => {
    const f = async () =>
      json({
        tweets: [tweet()],
        has_next_page: true,
        next_cursor: "continue2",
      });
    const out = await collectTwitter(
      m(),
      { from: now - 1800000, to: now, cursor: "" },
      1,
      f as Fetcher,
    );
    expect(out.report.status).toBe("partial");
    expect(out.state).toMatchObject({
      from: now - 1800000,
      to: now,
      cursor: "continue2",
    });
    expect(out.state?.completedAt).toBeUndefined();
  });
  it("拒绝重复游标，避免无限循环与无限计费", async () => {
    const f = async () =>
      json({ tweets: [tweet()], has_next_page: true, next_cursor: "same" });
    await expect(
      collectTwitter(
        m(),
        { from: now - 1800000, to: now, cursor: "same" },
        3,
        f as Fetcher,
      ),
    ).rejects.toThrow("游标");
  });
  it("第二页失败前保存第一页，保留恢复游标", async () => {
    let count = 0;
    const onPage = vi.fn();
    const f = async () =>
      ++count === 1
        ? json({
            tweets: [tweet()],
            has_next_page: true,
            next_cursor: "continue2",
          })
        : json({}, 429);
    await expect(
      collectTwitter(
        m(),
        { from: now - 1800000, to: now, cursor: "" },
        3,
        f as Fetcher,
        onPage,
      ),
    ).rejects.toThrow("429");
    expect(onPage).toHaveBeenCalledOnce();
    expect(onPage.mock.calls[0][0]).toHaveLength(1);
    expect(onPage.mock.calls[0][1].cursor).toBe("continue2");
  });
  it("没有 Key 时不发请求，不伪造空成功", async () => {
    vi.stubEnv("TWITTERAPI_API_KEY", "");
    const f = vi.fn();
    const out = await collectTwitter(
      m(),
      { from: now - 1800000, to: now, cursor: "" },
      3,
      f as Fetcher,
    );
    expect(f).not.toHaveBeenCalled();
    expect(out.report.status).toBe("unconfigured");
  });
  it("异常游标不会覆盖最后有效的恢复位置", async () => {
    const onPage = vi.fn();
    const f = async () =>
      json({ tweets: [tweet()], has_next_page: true, next_cursor: "" });
    await expect(
      collectTwitter(
        m(),
        { from: now - 1800000, to: now, cursor: "valid-cursor" },
        3,
        f as Fetcher,
        onPage,
      ),
    ).rejects.toThrow("游标");
    expect(onPage.mock.calls[0][1].cursor).toBe("valid-cursor");
    expect(onPage.mock.calls[0][0]).toHaveLength(1);
  });
  it("安全编码用户查询，防止注入时间过滤或账号条件", () => {
    const query = twitterQuery(
      { ...m(), keywords: 'AI" from:attacker' },
      now - 10000,
      now,
    );
    expect(query).toContain('"AI  from:attacker"');
    expect(query.split("since_time:")).toHaveLength(2);
  });
});
describe("OpenRouter 兼容协议与证据校验", () => {
  it("规范化 /api/v1，限制凭证发送目标", () => {
    expect(openRouterEndpoint("https://openrouter.ai")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(openRouterEndpoint("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(() => openRouterEndpoint("https://attacker.test/v1")).toThrow();
    expect(() =>
      openRouterEndpoint("https://user:password@openrouter.ai/api/v1"),
    ).toThrow();
  });
  it("OpenRouter 模型 ID 按配置透传，不发送排名请求头", async () => {
    const f = pipelineFetcher();
    await analyze(m(), [a()], [], f);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init] = calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("test-model");
    expect(body.provider).toBeUndefined();
    expect(init.headers["HTTP-Referer"]).toBeUndefined();
    expect(body.response_format.json_schema.strict).toBe(true);
  });
  it("非 Schema 模式仍拒绝伪造引用", async () => {
    vi.stubEnv("AI_OUTPUT_MODE", "json_object");
    const f = pipelineFetcher({
      events: [
        {
          ...event(),
          evidence: [
            { articleId: "invented-id", role: "first_party", excerpt: text },
          ],
        },
      ],
    });
    await expect(analyze(m(), [a()], [], f)).rejects.toThrow("未采集");
  });
  it("拒绝原文中不存在的引用片段", () => {
    expect(() =>
      validateEvidence(
        [
          {
            articleId: a().id,
            role: "first_party",
            excerpt: "A totally fabricated assertion.",
          },
        ],
        [a()],
      ),
    ).toThrow("原文");
  });
  it("同一来源的多个转发不算多源证据，热度不证明真实", () => {
    const items = [
      a(),
      {
        ...a("t2"),
        author: "random",
        originKey: "x:cursor_ai",
        isRepost: true,
      },
    ];
    expect(
      evidenceStatus(
        "corroborated",
        items.map((i) => ({
          articleId: i.id,
          role: "independent",
          excerpt: i.text,
        })),
        items,
      ),
    ).toBe("unverified");
  });
  it("无法确认的账号自述不会升级为有来源支持", () => {
    const item = { ...a(), author: "unverified-account" };
    expect(
      evidenceStatus(
        "supported",
        [{ articleId: item.id, role: "first_party", excerpt: item.text }],
        [item],
      ),
    ).toBe("unverified");
  });
  it("第三方 RSS 伪造官方链接不会成为一手证据", () => {
    const item = {
      ...a(),
      source: "rss" as const,
      url: "https://openai.com/example",
      originKey: "untrusted.example",
    };
    expect(
      evidenceStatus(
        "supported",
        [{ articleId: item.id, role: "first_party", excerpt: item.text }],
        [item],
      ),
    ).toBe("unverified");
  });
  it("缺少多次采样时明确增长数据不足", () => {
    const score = hotspotScore(90, [a()], now);
    expect(score.scoreReason).toContain("增长数据不足");
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThanOrEqual(100);
  });
  it("拒绝非 JSON 输出和截断输出", async () => {
    await expect(
      aiCompletion([], {}, 100, (async () =>
        json({
          choices: [
            { message: { content: "not-json" }, finish_reason: "stop" },
          ],
        })) as Fetcher),
    ).rejects.toThrow("无效 JSON");
    await expect(
      aiCompletion([], {}, 100, (async () =>
        json({
          choices: [{ message: { content: "{}" }, finish_reason: "length" }],
        })) as Fetcher),
    ).rejects.toThrow("截断");
  });
});
describe("持久化、调度和通知完整链路", () => {
  it("真实迁移后配置持久化，默认间隔为30分钟，可编辑和暂停", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "测试频道",
        kind: "keyword",
        keywords: "AI coding",
        sources: ["x"],
        active: false,
      }),
    );
    expect(findMonitor(saved.id)?.intervalMinutes).toBe(30);
    expect(nextDueMonitor()).toBeUndefined();
    const changed = await saveMonitor(
      { ...saved, intervalMinutes: 60 },
      saved.id,
    );
    expect(changed.intervalMinutes).toBe(60);
    requestScan(saved.id);
    expect(nextDueMonitor()?.id).toBe(saved.id);
  });
  it("任务锁阻止两个 worker 同时领取一个监控", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "锁测试",
        kind: "keyword",
        keywords: "AI",
        sources: ["x"],
      }),
    );
    expect(claimMonitor(saved.id)).toBeDefined();
    expect(claimMonitor(saved.id)).toBeUndefined();
  });
  it("崩溃后重新领取时将旧扫描记录标为中断", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "恢复测试",
        kind: "keyword",
        keywords: "AI",
        sources: ["x"],
      }),
    );
    getDb()
      .insert(runs)
      .values({
        id: "stale-run",
        monitorId: saved.id,
        monitorName: saved.name,
        status: "running",
        startedAt: now - 900000,
        reports: [],
      })
      .run();
    expect(claimMonitor(saved.id)).toBeDefined();
    expect(dashboard().runs[0].status).toBe("interrupted");
  });
  it("X 第二页限流时日志保留已采集数量和失败请求次数", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "部分失败",
        kind: "keyword",
        keywords: "Cursor",
        sources: ["x"],
      }),
    );
    let calls = 0;
    const f = (async (url: string) =>
      url.includes("twitterapi.io")
        ? ++calls === 1
          ? json({
              tweets: [tweet()],
              has_next_page: true,
              next_cursor: "page2",
            })
          : json({}, 429)
        : json({
            choices: [
              { message: { content: '{"events":[]}' }, finish_reason: "stop" },
            ],
          })) as Fetcher;
    await scanMonitor(saved.id, f);
    const d = dashboard();
    expect(d.runs[0].reports[0]).toMatchObject({
      status: "error",
      count: 1,
      requests: 2,
    });
    expect(d.rawArticles).toHaveLength(1);
    const state = getDb()
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, `${saved.id}:x:keywords`))
      .get()?.state;
    expect(state?.cursor).toBe("page2");
  });
  it("采集→AI→事件→站内通知→已读，并且重复扫描不重复提醒", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "完整流程",
        kind: "keyword",
        keywords: "Cursor",
        sources: ["x"],
      }),
    );
    getDb()
      .update(monitors)
      .set({ createdAt: now - 60000 })
      .where(eq(monitors.id, saved.id))
      .run();
    const f = pipelineFetcher();
    await scanMonitor(saved.id, f);
    expect(dashboard().events).toHaveLength(0);
    await processNextAnalysis(f, saved.id);
    await processNextAnalysis(f, saved.id);
    let d = dashboard();
    expect(d.runs[0].status).toBe("success");
    expect(d.events).toHaveLength(1);
    expect(d.events[0].credibility).toBe("supported");
    expect(d.notifications).toHaveLength(1);
    expect(d.notifications[0].emailStatus).toBe("unconfigured");
    expect(d.runs[0].tokens).toBe(0);
    expect(d.pipeline.usage.tokens).toBe(246);
    markRead(d.notifications[0].id);
    expect(dashboard().notifications[0].readAt).toBeTruthy();
    await scanMonitor(saved.id, f);
    d = dashboard();
    expect(d.notifications).toHaveLength(1);
    expect(d.events).toHaveLength(1);
    expect(d.pendingCount).toBe(0);
  });
  it("历史内容只建立基线，不发送首轮提醒", () => {
    const monitor = { ...m(), createdAt: now };
    expect(
      canNotify(
        monitor,
        { relevance: 95, credibility: "supported", notifiedAt: null },
        [a()],
        now,
      ),
    ).toBe(false);
  });
  it("待核实内容默认不提醒，用户主动开启后可提醒；争议信息不提醒", () => {
    const e = {
      relevance: 90,
      credibility: "unverified" as const,
      notifiedAt: null,
    };
    expect(canNotify(m(), e, [a()], now)).toBe(false);
    expect(canNotify({ ...m(), notifyUnverified: true }, e, [a()], now)).toBe(
      true,
    );
    expect(
      canNotify(
        { ...m(), notifyUnverified: true },
        { ...e, credibility: "disputed" },
        [a()],
        now,
      ),
    ).toBe(false);
  });
  it("冷却时间限制事件重要更新的重复提醒", () => {
    expect(
      canNotify(
        m(),
        { relevance: 90, credibility: "supported", notifiedAt: now - 10000 },
        [{ ...a(), publishedAt: now - 1000 }],
        now,
      ),
    ).toBe(false);
  });
  it("AI 认证失败时保留原始内容和待分析队列", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "失败测试",
        kind: "keyword",
        keywords: "Cursor",
        sources: ["x"],
      }),
    );
    const f = (async (url: string) =>
      url.includes("twitterapi.io")
        ? json({ tweets: [tweet()], has_next_page: false, next_cursor: "" })
        : json({}, 401)) as Fetcher;
    await scanMonitor(saved.id, f);
    await processNextAnalysis(f, saved.id);
    const d = dashboard();
    expect(d.runs[0].status).toBe("success");
    expect(d.pipeline.recentJobs[0].state).toBe("retry");
    expect(d.pipeline.recentJobs[0].error).toContain("401");
    expect(d.pendingCount).toBe(1);
    expect(d.events).toHaveLength(0);
    expect(d.notifications).toHaveLength(0);
  });
  it("伪造证据导致整个批次拒绝，且不标记已分析", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "证据测试",
        kind: "keyword",
        keywords: "Cursor",
        sources: ["x"],
      }),
    );
    await scanMonitor(
      saved.id,
      pipelineFetcher({
        events: [
          {
            ...event(),
            evidence: [
              { articleId: "fake", role: "first_party", excerpt: text },
            ],
          },
        ],
      }),
    );
    expect(dashboard().pendingCount).toBe(1);
    expect(dashboard().events).toHaveLength(0);
  });
});
describe("SMTP 投递与本机数据保护", () => {
  it("服务器接受了别的地址也不能宣称目标邮件成功", () => {
    expect(acceptedTarget(["other@example.test"], "target@example.test")).toBe(
      false,
    );
    expect(
      acceptedTarget(
        [{ address: "target@example.test" }],
        "TARGET@example.test",
      ),
    ).toBe(true);
  });
  it("测试邮件拒收时返回失败", async () => {
    for (const [k, v] of Object.entries({
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "test",
      SMTP_PASSWORD: "test",
      EMAIL_FROM: "sender@example.test",
      EMAIL_TO: "target@example.test",
    }))
      vi.stubEnv(k, v);
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi
        .fn()
        .mockResolvedValue({ accepted: [], rejected: ["target@example.test"] }),
    } as never);
    await expect(testMail()).rejects.toThrow("没有接受");
  });
  it("投递超时写入有限重试队列与错误记录", async () => {
    const saved = await saveMonitor(
      monitorInput.parse({
        name: "邮件重试",
        kind: "keyword",
        keywords: "Cursor",
        sources: ["x"],
      }),
    );
    getDb()
      .update(monitors)
      .set({ createdAt: now - 60000 })
      .where(eq(monitors.id, saved.id))
      .run();
    await scanMonitor(saved.id, pipelineFetcher());
    await processNextAnalysis(pipelineFetcher(), saved.id);
    await processNextAnalysis(pipelineFetcher(), saved.id);
    for (const [k, v] of Object.entries({
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "user",
      SMTP_PASSWORD: "password",
      EMAIL_FROM: "sender@example.test",
      EMAIL_TO: "target@example.test",
    }))
      vi.stubEnv(k, v);
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("SMTP timeout"), { code: "ETIMEDOUT" }),
        ),
    } as never);
    await deliverNotifications();
    const n = dashboard().notifications[0];
    expect(n.emailStatus).toBe("retry");
    expect(n.attempts).toBe(1);
    expect(n.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(n.leaseUntil).toBe(0);
  });
  it("拒绝本机、私网及映射私网地址", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.0.1",
      "172.16.0.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });
  it("错误信息隐藏 API Key 与邮箱凭证", () => {
    vi.stubEnv("SMTP_PASSWORD", "secret-password");
    const message = safeError(
      new Error("Bearer test-openrouter-secret secret-password"),
    );
    expect(message).not.toContain("test-openrouter-secret");
    expect(message).not.toContain("secret-password");
  });
});
