import { z } from "zod";
import {
  dashboard,
  saveMonitor,
  requestScan,
  findMonitor,
  getEvent,
  markRead,
  retryEmail,
  queryEvents,
} from "@/server/repository";
import { monitorInput, settingsInput } from "@/shared/types";
import { collectWeb } from "@/server/web-sources";
import { getSettings, writeSetting } from "@/server/config";
import {
  requestJson,
  safeError,
  ServiceError,
  validatePublicUrl,
} from "@/server/http";
import { testMail } from "@/server/mail";
import { aiCompletion, packyEndpoint } from "@/server/ai-client";
import { getDb } from "@/server/db";
import { monitors } from "@/server/schema";
import { eq } from "drizzle-orm";
import {
  requestAnalysis,
  retryAnalysis,
  addFeedback,
  enqueuePipeline,
} from "@/server/pipeline";
import { feedFilterInput } from "@/shared/feed";
import { reserveX } from "@/server/x-budget";
import { paceX } from "@/server/x-pacing";

export const runtime = "nodejs";
type Context = { params: Promise<{ path: string[] }> };
const respond = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError("请求缺少 JSON 内容", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 20000) {
      await reader.cancel();
      throw new ServiceError("请求内容过大", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new ServiceError("请求不是有效 JSON", 400);
  }
}
async function handle(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    const [resource, id, action] = path;
    const method = request.method;
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      const target = new URL(request.url);
      const expectedOrigin = `${target.protocol}//${request.headers.get("host") || target.host}`;
      if (origin && origin !== expectedOrigin)
        throw new ServiceError("不允许跨站请求", 403);
      if (!request.headers.get("content-type")?.includes("application/json"))
        throw new ServiceError("请求必须使用 JSON", 415);
      if (Number(request.headers.get("content-length") || 0) > 20000)
        throw new ServiceError("请求内容过大", 413);
    }
    const body = method === "GET" ? undefined : await readBody(request);
    if (method === "GET" && resource === "dashboard")
      return respond(dashboard());
    if (method === "GET" && resource === "events" && !id) {
      const params = new URL(request.url).searchParams;
      const raw = params.get("filters") || "{}";
      if (raw.length > 10000) throw new ServiceError("筛选条件过长", 400);
      let filters: unknown;
      try {
        filters = JSON.parse(raw);
      } catch {
        throw new ServiceError("筛选条件不是有效 JSON", 400);
      }
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(params.get("page") || 1);
      return respond(queryEvents(feedFilterInput.parse(filters), page));
    }
    if (method === "GET" && resource === "events" && id) {
      const e = getEvent(id);
      if (!e) throw new ServiceError("事件不存在", 404);
      return respond(e);
    }
    if (method === "POST" && resource === "monitors" && !id)
      return respond(await saveMonitor(monitorInput.parse(body)), 201);
    if (
      method === "POST" &&
      resource === "monitors" &&
      id &&
      action === "analyze"
    ) {
      requestAnalysis(id);
      return respond({
        message: "已有材料的分析已排队，不会重新搜索；受 AI 预算约束",
      });
    }
    if (
      method === "POST" &&
      resource === "analysis" &&
      id &&
      action === "retry"
    ) {
      retryAnalysis(id);
      return respond({ message: "分析任务已重新排队" });
    }
    if (
      method === "POST" &&
      resource === "events" &&
      id &&
      action === "feedback"
    ) {
      const input = z
        .object({
          verdict: z.enum([
            "valuable",
            "irrelevant",
            "duplicate",
            "insufficient",
          ]),
        })
        .parse(body);
      addFeedback(id, input.verdict);
      return respond({ message: "反馈已保存，用于调优，不会自动改变可信状态" });
    }
    if (method === "PUT" && resource === "monitors" && id)
      return respond(await saveMonitor(monitorInput.parse(body), id));
    if (method === "PATCH" && resource === "monitors" && id) {
      const { active } = z.object({ active: z.boolean() }).parse(body);
      if (!findMonitor(id)) throw new ServiceError("监控不存在", 404);
      getDb().update(monitors).set({ active }).where(eq(monitors.id, id)).run();
      return respond(findMonitor(id));
    }
    if (
      method === "POST" &&
      resource === "monitors" &&
      id &&
      action === "scan"
    ) {
      requestScan(id);
      return respond({ message: "情报更新已排队：采集 → AI 分析 → 首页展示" });
    }
    if (
      method === "POST" &&
      resource === "notifications" &&
      id &&
      action === "read"
    ) {
      markRead(id);
      return respond({ ok: true });
    }
    if (
      method === "POST" &&
      resource === "notifications" &&
      id &&
      action === "retry"
    ) {
      retryEmail(id);
      return respond({ ok: true });
    }
    if (method === "PUT" && resource === "settings") {
      const input = settingsInput.parse(body);
      packyEndpoint(input.baseUrl);
      if (input.xAccounts)
        for (const a of input.xAccounts) {
          const u = await validatePublicUrl(a.proofUrl);
          if (u.protocol !== "https:")
            throw new ServiceError("账号依据须为公开 HTTPS 地址", 400);
        }
      if (input.publishers) {
        if (
          new Set(input.publishers.map((p) => p.id)).size !==
          input.publishers.length
        )
          throw new ServiceError("来源 ID 不能重复", 400);
        for (const p of input.publishers) {
          const u = await validatePublicUrl(p.proofUrl);
          if (u.protocol !== "https:" || u.username || u.password)
            throw new ServiceError("来源验证链接必须为公开 HTTPS 地址", 400);
        }
      }
      writeSetting("app", { ...getSettings(), ...input });
      for (const m of getDb().select().from(monitors).all()) enqueuePipeline(m);
      return respond(getSettings());
    }
    if (
      method === "POST" &&
      resource === "connections" &&
      (id === "google" || id === "bing")
    ) {
      const sample = {
        ...monitorInput.parse({
          kind: "keyword",
          name: "搜索连接测试",
          keywords: "AI agent",
          sources: [id],
          active: false,
        }),
        id: "connection-test",
        createdAt: Date.now(),
        lastRunAt: null,
        nextRunAt: Date.now(),
        lastStatus: "idle",
        leaseUntil: 0,
        scanRequested: false,
      };
      const result = await collectWeb(sample, id);
      if (result.report.status !== "ok")
        throw new ServiceError(result.report.message, 400);
      return respond({
        message: `${id} 搜索连接正常，返回 ${result.report.count} 个网页候选；本次受搜索预算与缓存控制`,
      });
    }
    if (method === "POST" && resource === "connections" && id === "email")
      return respond(await testMail());
    if (method === "POST" && resource === "connections" && id === "x") {
      if (!process.env.TWITTERAPI_API_KEY)
        throw new ServiceError("X 未配置，请填写 TWITTERAPI_API_KEY", 400);
      const u = new URL(
        "https://api.twitterapi.io/twitter/tweet/advanced_search",
      );
      u.search = new URLSearchParams({
        query: "AI",
        queryType: "Latest",
        cursor: "",
      }).toString();
      reserveX("connection");
      await paceX();
      const data = await requestJson(u.href, {
        headers: { "X-API-Key": process.env.TWITTERAPI_API_KEY },
      });
      if (
        !data ||
        typeof data !== "object" ||
        !("tweets" in data) ||
        !Array.isArray(data.tweets)
      )
        throw new ServiceError("X 搜索返回格式不符合预期");
      return respond({
        message: `X 连接正常，测试搜索返回 ${data.tweets.length} 条推文（此操作会消耗 API 额度）`,
      });
    }
    if (method === "POST" && resource === "connections" && id === "ai") {
      const result = await aiCompletion(
        [{ role: "user", content: 'Return JSON {"ok":true} only.' }],
        {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
        100,
        fetch,
        { stage: "connection", jobId: "connection-test-" + Date.now() },
      );
      z.object({ ok: z.literal(true) }).parse(result.parsed);
      return respond({
        message: `PackyAPI 连接正常，${getSettings().outputMode} 模式返回 JSON 并通过本地校验`,
        ok: true,
      });
    }
    return respond({ error: "接口不存在" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return respond(
        { error: error.issues.map((x) => x.message).join("；") },
        400,
      );
    return respond(
      { error: safeError(error) },
      error instanceof ServiceError ? error.status : 500,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
