// Explicit, bounded live verification. Never invoked by the application worker.
import nextEnv from "@next/env";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

if (!process.argv.includes("--live")) {
  console.log(
    "真实联调会调用付费 API。显式运行：npm exec -- tsx scripts/verify-analysis-v2.ts --live",
  );
} else {
  nextEnv.loadEnvConfig(process.cwd());
  const settingsFlag = process.argv.find((x) => x.startsWith("--settings-db="));
  const settingsPath =
    settingsFlag?.slice("--settings-db=".length) ||
    (process.env.DATABASE_URL || "./data/hotspot.db").replace(/^file:/, "");
  let saved: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const source = new Database(settingsPath, { readonly: true });
    const row = source
      .prepare("select value from settings where key='app'")
      .get() as { value: string } | undefined;
    saved = row ? JSON.parse(row.value) : {};
    source.close();
  }
  const resumeFlag = process.argv.find((x) => x.startsWith("--resume="));
  const previous = resumeFlag
    ? JSON.parse(readFileSync(resumeFlag.slice("--resume=".length), "utf-8"))
    : null;
  const directory = mkdtempSync(join(tmpdir(), "signal-pipeline-v2-live-"));
  process.env.DATABASE_URL = previous?.database || join(directory, "live.db");
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "EMAIL_FROM",
    "EMAIL_TO",
  ])
    process.env[key] = "";
  const { monitorInput } = await import("../src/shared/types");
  const { getDb } = await import("../src/server/db");
  const { articles, articleMonitors, candidates, analysisJobs } = await import(
    "../src/server/schema"
  );
  const { writeSetting } = await import("../src/server/config");
  const { saveMonitor, dashboard } = await import("../src/server/repository");
  const { scanMonitor, persistArticles } = await import(
    "../src/server/scanner"
  );
  const { processNextAnalysis, enqueuePipeline } = await import(
    "../src/server/pipeline"
  );
  const { fairCandidates } = await import("../src/server/quality");
  const { getSettings } = await import("../src/server/config");
  const { enrichArticles } = await import("../src/server/web-sources");
  const { analyze } = await import("../src/server/ai");
  const { safeError } = await import("../src/server/http");
  const callLimit = Math.max(
    1,
    Math.min(
      20,
      Number(
        process.argv.find((x) => x.startsWith("--call-limit="))?.split("=")[1],
      ) || 12,
    ),
  );
  // One X page and one request per search engine. No event follow-up searches.
  writeSetting("app", {
    ...saved,
    maxPages: 1,
    batchSize: 3,
    webPages: 1,
    analysisEnabled: false,
    aiDailyCallLimit: callLimit,
    aiDailyTokenLimit: 200000,
    verificationDailyLimit: 0,
    xContextDailyLimit: 1,
  });
  const { findMonitor } = await import("../src/server/repository");
  const discovery = previous
    ? findMonitor(previous.discoveryId)!
    : await saveMonitor(
        monitorInput.parse({
          name: "V2 真实采集 · AI Coding Agent",
          kind: "topic",
          keywords: "AI coding agent",
          aliases: "coding agent, 编程代理",
          sources: ["x", "google", "bing"],
          active: false,
        }),
      );
  console.log(
    JSON.stringify({
      stage: "collect",
      database: process.env.DATABASE_URL,
      monitorId: discovery.id,
    }),
  );
  if (!previous) await scanMonitor(discovery.id);
  const raw = getDb()
    .select({ a: articles })
    .from(articleMonitors)
    .innerJoin(articles, eq(articles.id, articleMonitors.articleId))
    .where(eq(articleMonitors.monitorId, discovery.id))
    .all()
    .map((x) => x.a);
  const chosen = fairCandidates(raw, 6, 0, getSettings().publishers);
  const enriched =
    previous?.sample ||
    (await enrichArticles(chosen, discovery, fetch, { remaining: 6 }));
  const sample = previous
    ? findMonitor(previous.sampleId)!
    : await saveMonitor(
        monitorInput.parse({
          name: "V2 真实对照 · 六条候选",
          kind: "topic",
          keywords: discovery.keywords,
          aliases: discovery.aliases,
          sources: discovery.sources,
          active: false,
        }),
      );
  persistArticles(sample, enriched);
  enqueuePipeline(sample);
  const baseline: unknown[] = previous?.baseline || [];
  mkdirSync("output/pipeline-v2", { recursive: true });
  const report = () => {
    const d = dashboard();
    writeFileSync(
      "output/pipeline-v2/live-2026-10-05.json",
      JSON.stringify(
        {
          date: new Date().toISOString(),
          database: process.env.DATABASE_URL,
          discoveryId: discovery.id,
          sampleId: sample.id,
          collection: d.runs.filter((r) => r.monitorId === discovery.id),
          sample: enriched,
          baseline,
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
          events: d.events.filter((e) => e.monitorId === sample.id),
          usage: d.pipeline.usage,
          searchUsage: d.searchUsage,
          contextRequests: d.pipeline.contextRequests,
          notifications: d.notifications.length,
        },
        null,
        2,
      ),
      "utf-8",
    );
  };
  report();
  // Compare exactly the same materials with the previous single-stage analyzer.
  for (
    let start = 0;
    !process.argv.includes("--pipeline-only") && start < enriched.length;
    start += 3
  ) {
    try {
      baseline.push(
        await analyze(sample, enriched.slice(start, start + 3), [], fetch, {
          stage: "baseline",
          jobId: "baseline-" + start,
        }),
      );
    } catch (error) {
      baseline.push({ error: safeError(error) });
    }
    console.log(JSON.stringify({ stage: "baseline", batch: start / 3 + 1 }));
    report();
  }
  for (let step = 0; step < 12; step++) {
    const processed = await processNextAnalysis(fetch, sample.id);
    report();
    const d = dashboard();
    console.log(
      JSON.stringify({
        stage: "pipeline",
        step: step + 1,
        processed,
        calls: d.pipeline.usage.calls,
        events: d.events.filter((e) => e.monitorId === sample.id).length,
        jobs: d.pipeline.recentJobs
          .filter((j) => j.monitorId === sample.id)
          .map((j) => ({ stage: j.stage, state: j.state, error: j.error })),
      }),
    );
    if (!processed || d.pipeline.usage.calls >= callLimit) break;
  }
  report();
  console.log(
    JSON.stringify({
      stage: "complete",
      database: process.env.DATABASE_URL,
      report: "output/pipeline-v2/live-2026-10-05.json",
    }),
  );
}
