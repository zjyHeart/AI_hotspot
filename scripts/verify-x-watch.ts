// Bounded live API verification, isolated from the application database and worker.
import nextEnv from "@next/env";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { z } from "zod";

if (!process.argv.includes("--live")) {
  console.log(
    "显式运行：npm exec -- tsx scripts/verify-x-watch.ts --live；最多 6 次 X 和 6 次 AI 调用，使用独立临时数据库，不发邮件。",
  );
} else {
  nextEnv.loadEnvConfig(process.cwd());
  const sourcePath = (process.env.DATABASE_URL || "./data/hotspot.db").replace(
    /^file:/,
    "",
  );
  let saved: Record<string, unknown> = {};
  if (existsSync(sourcePath)) {
    const db = new Database(sourcePath, { readonly: true });
    const row = db
      .prepare("select value from settings where key='app'")
      .get() as { value: string } | undefined;
    saved = row ? JSON.parse(row.value) : {};
    db.close();
  }
  const directory = mkdtempSync(join(tmpdir(), "signal-x-watch-live-"));
  process.env.DATABASE_URL = join(directory, "live.db");
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "EMAIL_FROM",
    "EMAIL_TO",
  ])
    process.env[key] = "";
  const { getSettings, writeSetting } = await import("../src/server/config");
  const { monitorInput } = await import("../src/shared/types");
  const { saveMonitor, dashboard, queryEvents } =
    await import("../src/server/repository");
  const { scanMonitor, persistArticles } =
    await import("../src/server/scanner");
  const { getDb } = await import("../src/server/db");
  const { articles, articleMonitors, candidates, analysisJobs } =
    await import("../src/server/schema");
  const { enqueuePipeline, processNextAnalysis } =
    await import("../src/server/pipeline");
  const { tweetSchema } = await import("../src/server/sources");
  const { reserveX } = await import("../src/server/x-budget");
  const { paceX } = await import("../src/server/x-pacing");
  const { requestJson, safeError } = await import("../src/server/http");
  const { feedFilterInput } = await import("../src/shared/feed");
  writeSetting("app", {
    ...saved,
    maxPages: 1,
    xRequestsPerScan: 2,
    xDailyRequestLimit: 6,
    xMonthlyRequestLimit: 6,
    aiDailyCallLimit: 6,
    aiDailyTokenLimit: 150000,
    batchSize: 2,
    bodyFetchLimit: 1,
    verificationDailyLimit: 0,
    xContextDailyLimit: 1,
    analysisEnabled: false,
    eventWindowHours: 72,
  });
  const discovery = await saveMonitor(
    monitorInput.parse({
      name: "AI 编程与 Agent · 真实采集验收",
      keywords: "AI coding agent",
      aliases:
        "Claude Code, Codex, Cursor, Cline, OpenCode, LangGraph, coding agent",
      kind: "topic",
      sources: ["x"],
      intervalMinutes: 30,
      active: false,
      quality: { useCuratedAccounts: true, engagementMode: "standard" },
    }),
  );
  console.log(
    JSON.stringify({
      stage: "collect",
      database: process.env.DATABASE_URL,
      monitorId: discovery.id,
    }),
  );
  await scanMonitor(discovery.id);
  const raw = getDb()
    .select({ a: articles })
    .from(articleMonitors)
    .innerJoin(articles, eq(articles.id, articleMonitors.articleId))
    .where(eq(articleMonitors.monitorId, discovery.id))
    .all()
    .map((r) => r.a);
  const metrics: Record<string, unknown> = {};
  const ids = raw.slice(0, 3).map((a) => a.externalId);
  if (ids.length) {
    try {
      reserveX("observation-verification");
      await paceX();
      const u = new URL("https://api.twitterapi.io/twitter/tweets");
      u.searchParams.set("tweet_ids", ids.join(","));
      const r = z
        .object({ tweets: z.array(tweetSchema), status: z.string().optional() })
        .parse(
          await requestJson(u.href, {
            headers: { "X-API-Key": process.env.TWITTERAPI_API_KEY! },
          }),
        );
      if (r.status && r.status !== "success")
        throw new Error("互动查询状态不成功");
      metrics.requested = ids.length;
      metrics.returned = r.tweets.length;
      metrics.fieldsPresent = r.tweets.every(
        (t) =>
          typeof t.likeCount === "number" &&
          typeof t.retweetCount === "number" &&
          typeof t.replyCount === "number",
      );
      // No artificial aging of posts: observation transition is covered by regression tests.
    } catch (error) {
      metrics.error = safeError(error);
    }
  }
  const selected: typeof raw = [];
  const seen = new Set<string>();
  // A small spread of actual authors, rather than multiple samples from one active account.
  for (const a of raw.filter((a) => !a.isRepost)) {
    if (seen.has(a.author.toLowerCase())) continue;
    selected.push(a);
    seen.add(a.author.toLowerCase());
    if (selected.length >= 4) break;
  }
  const sample = await saveMonitor(
    monitorInput.parse({
      ...discovery,
      name: "AI 编程与 Agent · 小批真实分析样本",
      active: false,
    }),
  );
  persistArticles(sample, selected);
  enqueuePipeline(sample);
  mkdirSync("output/x-watch", { recursive: true });
  const reportPath = "output/x-watch/live-2026-10-05.json";
  function report() {
    const d = dashboard();
    const payload = {
      date: new Date().toISOString(),
      database: process.env.DATABASE_URL,
      discoveryId: discovery.id,
      sampleId: sample.id,
      configuredAccounts: getSettings()
        .xAccounts.filter((a) => a.active)
        .map((a) => a.handle),
      collection: d.runs,
      authorCounts: Object.fromEntries(
        [...new Set(raw.map((a) => a.author))].map((author) => [
          author,
          raw.filter((a) => a.author === author).length,
        ]),
      ),
      metrics,
      sample: selected,
      candidates: getDb()
        .select()
        .from(candidates)
        .where(eq(candidates.monitorId, sample.id))
        .all(),
      jobs: getDb()
        .select()
        .from(analysisJobs)
        .where(eq(analysisJobs.monitorId, sample.id))
        .all(),
      events: queryEvents(
        feedFilterInput.parse({ hours: "all", monitorIds: [sample.id] }),
      ),
      xUsage: d.xUsage,
      aiUsage: d.pipeline.usage,
      notifications: d.notifications.length,
    };
    writeFileSync(reportPath, JSON.stringify(payload, null, 2), "utf-8");
    return payload;
  }
  report();
  for (let step = 0; step < 8; step++) {
    const processed = await processNextAnalysis(fetch, sample.id),
      r = report();
    console.log(
      JSON.stringify({
        stage: "analysis",
        step: step + 1,
        processed,
        usage: r.aiUsage,
        jobs: r.jobs.map((j) => ({
          stage: j.stage,
          state: j.state,
          error: j.error,
        })),
        events: r.events.total,
      }),
    );
    if (!processed || r.aiUsage.calls >= 6) break;
  }
  const r = report();
  console.log(
    JSON.stringify({
      stage: "complete",
      database: process.env.DATABASE_URL,
      report: reportPath,
      raw: raw.length,
      authors: r.authorCounts,
      metrics,
      xUsage: r.xUsage,
      aiUsage: r.aiUsage,
      events: r.events.total,
      notifications: r.notifications,
    }),
  );
}
