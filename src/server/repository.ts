import { and, eq, desc, isNull, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import {
  monitors,
  articles,
  articleMonitors,
  events,
  notifications,
  runs,
} from "./schema";
import { getHealth, getSettings, writeSetting } from "./config";
import type { Dashboard, MonitorInput, Event } from "../shared/types";
import { searchUsage } from "./web-sources";
import { sourceNames } from "../shared/types";
import { qualityDecision, policyFor, observationUntil } from "./quality";
import { ServiceError, validatePublicUrl } from "./http";
import { enqueuePipeline, pipelineDashboard } from "./pipeline";
import { xUsage } from "./x-budget";
import { filterFeed, type FeedFilters, type FeedPage } from "../shared/feed";

export function findMonitor(id: string) {
  return getDb().select().from(monitors).where(eq(monitors.id, id)).get();
}
export async function saveMonitor(input: MonitorInput, id?: string) {
  for (const url of input.rssUrls) await validatePublicUrl(url);
  const db = getDb();
  const now = Date.now();
  if (id) {
    const old = findMonitor(id);
    if (!old) throw new ServiceError("监控不存在", 404);
    if (old.leaseUntil > now)
      throw new ServiceError("监控正在扫描，请待扫描结束后编辑", 409);
    db.update(monitors)
      .set({ ...input, nextRunAt: now + input.intervalMinutes * 60000 })
      .where(eq(monitors.id, id))
      .run();
    const changed = findMonitor(id)!;
    enqueuePipeline(changed);
    return changed;
  }
  const monitor = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    nextRunAt: now,
    lastRunAt: null,
    lastStatus: "idle",
    leaseUntil: 0,
    scanRequested: false,
  };
  db.insert(monitors).values(monitor).run();
  return monitor;
}
export function requestScan(id: string) {
  const m = findMonitor(id);
  if (!m) throw new ServiceError("监控不存在", 404);
  if (m.leaseUntil > Date.now())
    throw new ServiceError("这个监控正在扫描", 409);
  getDb()
    .update(monitors)
    .set({ scanRequested: true, nextRunAt: Date.now(), lastStatus: "queued" })
    .where(eq(monitors.id, id))
    .run();
  // Explicit scans can also analyze paused channels without enabling automatic tasks.
  writeSetting("analysis-request:" + id, true);
}
export function getEvent(id: string): Event | undefined {
  const db = getDb();
  const event = db.select().from(events).where(eq(events.id, id)).get();
  if (!event) return undefined;
  const ids = event.evidence.map((e) => e.articleId);
  return {
    ...event,
    articles: ids.length
      ? db.select().from(articles).where(inArray(articles.id, ids)).all()
      : [],
  };
}
export function dashboard(): Dashboard {
  const db = getDb();
  const es = db
    .select()
    .from(events)
    .orderBy(desc(events.updatedAt))
    .limit(200)
    .all();
  const hydrated = es
    .filter((e) => {
      const m = findMonitor(e.monitorId);
      return (
        m &&
        e.relevance >= m.minRelevance &&
        (e.details?.value ?? 100) >= getSettings().minValue
      );
    })
    .map((e) => getEvent(e.id)!);
  const pending =
    db
      .select({ count: sql<number>`count(*)` })
      .from(articleMonitors)
      .where(
        and(
          isNull(articleMonitors.analyzedAt),
          isNull(articleMonitors.filterReason),
        ),
      )
      .get()?.count || 0;
  const ms = db.select().from(monitors).all();
  const links = db.select().from(articleMonitors).all();
  const publishers = getSettings().publishers;
  const visible = (a: typeof articles.$inferSelect) =>
    links.some(
      (l) =>
        l.articleId === a.id &&
        !l.filterReason &&
        ms.some(
          (m) =>
            m.id === l.monitorId &&
            !qualityDecision(a, m, publishers, getSettings().xAccounts),
        ),
    );
  const discovered = (source: string) =>
    sql`(exists (select 1 from json_each(json_extract(${articles.metadata}, '$.discoverySources')) where value=${source}) or (json_extract(${articles.metadata}, '$.discoverySources') is null and ${articles.source}=${source}))`;
  return {
    xUsage: xUsage(),
    pipeline: pipelineDashboard(),
    monitors: ms
      .map((m) => ({ ...m, quality: policyFor(m) }))
      .sort((a, b) => b.createdAt - a.createdAt),
    events: hydrated,
    notifications: db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(200)
      .all(),
    runs: db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all(),
    settings: getSettings(),
    health: getHealth(),
    pendingCount: pending,
    rawArticles: db
      .select()
      .from(articles)
      .where(
        sql`exists (select 1 from article_monitors am where am.article_id=${articles.id} and am.filter_reason is null)`,
      )
      .orderBy(desc(articles.collectedAt))
      .limit(200)
      .all()
      .filter(visible)
      .slice(0, 20),
    sourceStats: Object.keys(sourceNames).map((source) => ({
      source: source as keyof typeof sourceNames,
      collected: db
        .select({ n: sql<number>`count(*)` })
        .from(articles)
        .where(discovered(source))
        .get()!.n,
      pending: db
        .select({ n: sql<number>`count(*)` })
        .from(articleMonitors)
        .innerJoin(articles, eq(articles.id, articleMonitors.articleId))
        .where(
          and(
            discovered(source),
            isNull(articleMonitors.analyzedAt),
            isNull(articleMonitors.filterReason),
          ),
        )
        .get()!.n,
      filtered: db
        .select({ n: sql<number>`count(*)` })
        .from(articleMonitors)
        .innerJoin(articles, eq(articles.id, articleMonitors.articleId))
        .where(
          and(
            discovered(source),
            sql`${articleMonitors.filterReason} is not null`,
          ),
        )
        .get()!.n,
    })),
    searchUsage: searchUsage(),
  };
}
// Filter the whole event archive before paging, so "all" is not the dashboard's 200-row sample.
export function queryEvents(filters: FeedFilters, page = 1): FeedPage {
  const db = getDb(),
    s = getSettings();
  const ms = db.select().from(monitors).all();
  const rows = db.select().from(events).all();
  const ids = [
    ...new Set(rows.flatMap((e) => e.evidence.map((ref) => ref.articleId))),
  ];
  const byId = new Map<string, typeof articles.$inferSelect>();
  // Stay under SQLite's bound-variable limit on larger archives.
  for (let i = 0; i < ids.length; i += 500)
    for (const a of db
      .select()
      .from(articles)
      .where(inArray(articles.id, ids.slice(i, i + 500)))
      .all())
      byId.set(a.id, a);
  const hydrated = rows.map((e) => ({
    ...e,
    articles: e.evidence
      .map((ref) => byId.get(ref.articleId))
      .filter((a) => a !== undefined),
  }));
  const eligible = hydrated.filter((e) => {
    const m = ms.find((m) => m.id === e.monitorId);
    return (
      m &&
      e.articles.some(
        (a) =>
          a.source !== "x" ||
          (!qualityDecision(a, m, s.publishers, s.xAccounts) &&
            observationUntil(a, m, s.publishers, s.xAccounts) === null),
      )
    );
  });
  const selected = filterFeed(eligible, filters, ms, s);
  const pageSize = 30,
    safePage = Math.max(
      1,
      Math.min(page, Math.ceil(selected.length / pageSize) || 1),
    );
  return {
    items: selected.slice((safePage - 1) * pageSize, safePage * pageSize),
    total: selected.length,
    page: safePage,
    pageSize,
  };
}
export function markRead(id: string) {
  if (id === "all")
    getDb()
      .update(notifications)
      .set({ readAt: Date.now() })
      .where(isNull(notifications.readAt))
      .run();
  else
    getDb()
      .update(notifications)
      .set({ readAt: Date.now() })
      .where(eq(notifications.id, id))
      .run();
}
export function retryEmail(id: string) {
  const db = getDb();
  const n = db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .get();
  if (!n) throw new ServiceError("通知不存在", 404);
  if (n.emailStatus === "accepted" || n.leaseUntil > Date.now())
    throw new ServiceError("邮件已接受或正在投递，不能重复发送", 409);
  db.update(notifications)
    .set({
      emailStatus: "queued",
      attempts: 0,
      leaseUntil: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
    })
    .where(eq(notifications.id, id))
    .run();
}
