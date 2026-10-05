// Synthetic status fixtures stay in isolated databases; never populate the preview.
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../src/server/db";
import { analysisJobs, monitors } from "../src/server/schema";
import { writeSetting, readSetting } from "../src/server/config";
import { dashboard, saveMonitor } from "../src/server/repository";
import { monitorInput } from "../src/shared/types";
import { updateStatus } from "../src/shared/update-status";
import { POST, GET } from "../src/app/api/[...path]/route";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "/tmp/signal-home-test-" + randomUUID() + ".db");
  for (const key of ["PACKY_API_KEY", "TWITTERAPI_API_KEY", "SERPAPI_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM", "EMAIL_TO"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.unstubAllEnvs(); });
const create = () => saveMonitor(monitorInput.parse({ name: "我的频道", kind: "topic", keywords: "coding agent", sources: ["x"], active: false }));
function job(monitorId: string, stage: "screen" | "deep", state = "queued", leaseUntil = 0, updatedAt = Date.now()) {
  const id = randomUUID();
  getDb().insert(analysisJobs).values({ id, monitorId, stage, state, leaseUntil, payload: {}, createdAt: updatedAt, updatedAt }).run();
  return id;
}

it("后台离线时不把排队或残留租约误报为正在分析", async () => {
  const m = await create();
  job(m.id, "deep", "running", Date.now() + 60000);
  expect(updateStatus(dashboard()).title).toBe("后台已停止");
});
it("首页进度包含真实有效租约，并不被最近20条已完成审计截断", async () => {
  const m = await create();
  const time = Date.now();
  writeSetting("workerAt", time);
  writeSetting("analysis-request:" + m.id, true);
  job(m.id, "deep", "running", time + 60000, time - 10000);
  for (let i = 0; i < 25; i++) job(m.id, "screen", "done", 0, time + i);
  const d = dashboard();
  expect(d.pipeline.recentJobs.every((j) => j.state === "done")).toBe(true);
  expect(d.pipeline.activity.deep).toBe(1);
  expect(updateStatus(d).title).toBe("AI 正在深度核验");
  expect(updateStatus(d).description).toContain(m.name);
});
it("过期租约显示待处理，不再显示AI正在执行", async () => {
  const m = await create();
  writeSetting("workerAt", Date.now());
  writeSetting("analysis-request:" + m.id, true);
  job(m.id, "screen", "running", Date.now() - 1);
  expect(dashboard().pipeline.activity).toMatchObject({ screen: 0, queued: 1 });
  expect(updateStatus(dashboard()).title).toBe("更新已排队");
});
it("暂停频道积压不伪装为更新队列，额度和重试有明确原因", async () => {
  const m = await create();
  writeSetting("workerAt", Date.now());
  const id = job(m.id, "deep", "budget");
  expect(updateStatus(dashboard()).title).toBe("后台在线 · 分析已暂停");
  writeSetting("analysis-request:" + m.id, true);
  expect(updateStatus(dashboard()).title).toBe("分析因预算暂停");
  getDb().update(analysisJobs).set({ state: "retry", nextAttemptAt: Date.now() + 60000 }).where(eq(analysisJobs.id, id)).run();
  expect(updateStatus(dashboard()).title).toBe("分析等待重试");
});
it("刷新列表只读取结果，更新情报一次请求同时排队采集与分析且不启用暂停频道", async () => {
  const m = await create();
  const request = new Request("http://127.0.0.1:3000/api/dashboard");
  const response = await GET(request, { params: Promise.resolve({ path: ["dashboard"] }) });
  expect(response.status).toBe(200);
  expect(getDb().select().from(monitors).where(eq(monitors.id, m.id)).get()?.scanRequested).toBe(false);
  expect(readSetting("analysis-request:" + m.id, false)).toBe(false);
  const posted = await POST(new Request(`http://127.0.0.1:3000/api/monitors/${m.id}/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["monitors", m.id, "scan"] }) });
  expect(posted.status).toBe(200);
  const stored = getDb().select().from(monitors).where(eq(monitors.id, m.id)).get()!;
  expect(stored).toMatchObject({ scanRequested: true, active: false, lastStatus: "queued" });
  expect(readSetting("analysis-request:" + m.id, false)).toBe(true);
  expect(dashboard().xUsage.day).toBe(0);
});
it("当前采集与AI初筛各自显示所处阶段", async () => {
  const m = await create();
  writeSetting("workerAt", Date.now());
  getDb().update(monitors).set({ lastStatus: "running", leaseUntil: Date.now() + 60000 }).where(eq(monitors.id, m.id)).run();
  expect(updateStatus(dashboard())).toMatchObject({ title: "正在采集新内容", stage: 0 });
  job(m.id, "screen", "running", Date.now() + 60000);
  expect(updateStatus(dashboard())).toMatchObject({ title: "AI 正在筛选内容", stage: 1 });
});
