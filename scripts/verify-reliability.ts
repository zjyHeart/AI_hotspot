import nextEnv from "@next/env";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { monitorInput } from "../src/shared/types";

nextEnv.loadEnvConfig(process.cwd(), true);
const directory = mkdtempSync(join(tmpdir(), "signal-reliability-live-"));
const target = join(directory, "live.db");
const seed = process.env.RELIABILITY_SEED_DB;
if (seed && existsSync(seed)) {
  const db = new Database(seed, { readonly: true });
  await db.backup(target);
  db.close();
}
process.env.DATABASE_URL = target;
for (const key of [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_FROM",
  "EMAIL_TO",
])
  process.env[key] = "";
const { getDb } = await import("../src/server/db");
const { monitors } = await import("../src/server/schema");
const { getSettings, writeSetting } = await import("../src/server/config");
const { saveMonitor, dashboard, findMonitor } =
  await import("../src/server/repository");
const { scanMonitor } = await import("../src/server/scanner");
const { DEFAULT_FEEDS, collectRss, collectGithubReleases } =
  await import("../src/server/sources");
const { safeError } = await import("../src/server/http");
getDb()
  .update(monitors)
  .set({ active: false, scanRequested: false, leaseUntil: 0 })
  .run();
writeSetting("app", {
  ...getSettings(),
  maxPages: 1,
  batchSize: 6,
  bodyFetchLimit: 4,
});
const resumeId = process.env.RELIABILITY_RESUME_MONITOR_ID;
const existing = resumeId ? findMonitor(resumeId) : undefined;
if (resumeId && !existing) throw new Error("恢复频道不存在");
const previousX = existing
  ? dashboard()
      .runs.find((r) => r.monitorId === existing.id)
      ?.reports.find((r) => r.source === "x")
  : undefined;
const m =
  existing ||
  (await saveMonitor(
    monitorInput.parse({
      kind: "topic",
      name: "可靠性真实联调 · AI Agent",
      keywords: "AI Agent",
      aliases: "AI coding,人工智能代理",
      sources: ["x", "hn", "rss", "github"],
      active: false,
      quality: { githubRepos: ["vercel/next.js"] },
    }),
  ));
if (existing)
  getDb()
    .update(monitors)
    .set({ sources: m.sources.filter((s) => s !== "x") })
    .where(eq(monitors.id, m.id))
    .run();
console.log(
  JSON.stringify({
    phase: "prepared",
    database: target,
    serpConfigured: !!process.env.SERPAPI_API_KEY,
  }),
);
await scanMonitor(m.id);
if (existing)
  getDb()
    .update(monitors)
    .set({ sources: m.sources })
    .where(eq(monitors.id, m.id))
    .run();
const d = dashboard();
const run = d.runs.find((r) => r.monitorId === m.id)!;
console.log(
  JSON.stringify({
    phase: "scan",
    status: run.status,
    reports: run.reports,
    analyzedCount: run.analyzedCount,
    eventCount: run.eventCount,
    tokens: run.tokens,
    error: run.error,
  }),
);
const end = Date.now();
const feeds = await Promise.all(
  DEFAULT_FEEDS.map(async (url) => {
    const r = await collectRss(
      { ...m, rssUrls: [url] },
      end - 7 * 86400000,
      end,
    );
    return { url, ...r.report };
  }),
);
const release = await collectGithubReleases(m, end - 7 * 86400000, end).catch(
  (error) => ({
    articles: [],
    report: { status: "error", message: safeError(error) },
  }),
);
const result = {
  date: new Date().toISOString(),
  database: target,
  monitorId: m.id,
  serpConfigured: !!process.env.SERPAPI_API_KEY,
  run,
  reusedX: previousX || null,
  feeds,
  release: {
    ...release.report,
    examples: release.articles
      .slice(0, 2)
      .map((a) => ({ url: a.url, title: a.title, publishedAt: a.publishedAt })),
  },
  events: d.events
    .filter((e) => e.monitorId === m.id)
    .map((e) => ({
      title: e.title,
      credibility: e.credibility,
      sources: e.articles?.map((a) => ({
        source: a.source,
        url: a.url,
        status: a.metadata?.contentStatus,
        publishedAt: a.publishedAt,
        fetchError: a.metadata?.fetchError,
      })),
    })),
  notifications: d.notifications.filter((n) => n.monitorId === m.id).length,
};
mkdirSync("output/reliability", { recursive: true });
writeFileSync(
  "output/reliability/live-result.json",
  JSON.stringify(result, null, 2),
  "utf-8",
);
console.log(
  JSON.stringify({
    phase: "complete",
    feeds,
    release: result.release,
    events: result.events,
    notifications: result.notifications,
  }),
);
