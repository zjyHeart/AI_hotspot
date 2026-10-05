import { enqueuePipeline } from "./pipeline";
import { and, eq, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { monitors, checkpoints, runs } from "./schema";
import { getSettings, readSetting } from "./config";
import {
  collectTwitter,
  collectHn,
  collectGithub,
  collectRss,
  hash,
  CollectionError,
  type Collection,
  type TwitterState,
} from "./sources";
import { collectWebDiscovery, webDue } from "./web-sources";
import { policyFor, POLICY_VERSION } from "./quality";
import { writeSetting } from "./config";
import { safeError, type Fetcher } from "./http";
import type { Monitor, SourceReport } from "../shared/types";
import { monitoredHandles } from "../shared/x-accounts";
import { refreshObservations } from "./x-observation";

export function claimMonitor(
  id: string,
  now = Date.now(),
): Monitor | undefined {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const claimed = tx
        .update(monitors)
        .set({
          leaseUntil: now + 900000,
          lastStatus: "running",
          scanRequested: false,
        })
        .where(and(eq(monitors.id, id), lte(monitors.leaseUntil, now)))
        .returning()
        .get();
      if (claimed)
        tx.update(runs)
          .set({
            status: "interrupted",
            finishedAt: now,
            error: "上次后台任务未完成，租约到期后重新领取",
          })
          .where(and(eq(runs.monitorId, id), eq(runs.status, "running")))
          .run();
      return claimed;
    },
    { behavior: "immediate" },
  );
}
export { persistArticles, canNotify } from "./article-store";
import { persistArticles } from "./article-store";
function saveCheckpoint(id: string, state: TwitterState) {
  getDb()
    .insert(checkpoints)
    .values({ id, state: state as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: checkpoints.id,
      set: { state: state as unknown as Record<string, unknown> },
    })
    .run();
}
export async function scanMonitor(id: string, fetcher: Fetcher = fetch) {
  const m = claimMonitor(id);
  if (!m) return false;
  const db = getDb();
  const settings = getSettings();
  const now = Date.now();
  const runId = randomUUID();
  db.insert(runs)
    .values({
      id: runId,
      monitorId: id,
      monitorName: m.name,
      status: "running",
      startedAt: now,
      finishedAt: null,
      reports: [],
      error: null,
    })
    .run();
  let reports: SourceReport[] = [];
  let analyzedCount = 0;
  let eventCount = 0;
  let tokens = 0;
  let error: string | null = null;
  let status = "success";
  try {
    const from = now - settings.eventWindowHours * 3600000 - 120000;
    const fingerprint = hash(
      JSON.stringify([
        m.keywords,
        m.aliases,
        m.excludes,
        m.rssUrls,
        m.quality,
        POLICY_VERSION,
        settings.xAccounts,
      ]),
    );
    const tasks = m.sources.map(async (source) => {
      try {
        let collection: Collection;
        if (source === "x") {
          const lanes: ("accounts" | "keywords")[] = monitoredHandles(
            m,
            settings.xAccounts,
          ).length
            ? ["accounts", "keywords"]
            : ["keywords"];
          const laneReports: SourceReport[] = [];
          let remaining = settings.xRequestsPerScan;
          const refreshed = process.env.TWITTERAPI_API_KEY
            ? await refreshObservations(m, fetcher, remaining)
            : { requests: 0, message: "", status: "ok" as const };
          remaining -= refreshed.requests;
          // One page for each lane first; rotate when a deliberately tiny budget cannot cover both.
          const offset =
            remaining < lanes.length
              ? readSetting<number>(`x-lane-offset:${m.id}`, 0) % lanes.length
              : 0;
          writeSetting(`x-lane-offset:${m.id}`, offset + 1);
          const order = [...lanes.slice(offset), ...lanes.slice(0, offset)];
          for (const lane of order) {
            if (remaining <= 0) {
              laneReports.push({
                source: "x",
                status: "partial",
                count: 0,
                requests: 0,
                message: `${lane === "accounts" ? "账号" : "关键词"}：本轮预算不足，进度保留`,
              });
              continue;
            }
            const checkpointId = `${m.id}:x:${lane}`;
            const old = db
              .select()
              .from(checkpoints)
              .where(eq(checkpoints.id, checkpointId))
              .get()?.state as unknown as TwitterState | undefined;
            const state: TwitterState =
              old?.fingerprint === fingerprint && old.cursor
                ? old
                : {
                    from:
                      old?.fingerprint === fingerprint && old.completedAt
                        ? old.completedAt - 120000
                        : from,
                    to: now,
                    cursor: "",
                    fingerprint,
                  };
            try {
              const result = await collectTwitter(
                m,
                state,
                Math.min(
                  settings.maxPages,
                  Math.max(
                    1,
                    remaining -
                      (laneReports.length === 0 && order.length > 1 ? 1 : 0),
                  ),
                ),
                fetcher,
                (page, pageState) => {
                  persistArticles(m, page);
                  saveCheckpoint(checkpointId, pageState);
                },
                lane,
              );
              persistArticles(m, result.articles);
              if (result.state) saveCheckpoint(checkpointId, result.state);
              laneReports.push({
                ...result.report,
                message: `${lane === "accounts" ? "账号" : "关键词"}：${result.report.message}`,
              });
              remaining -= result.report.requests;
            } catch (e) {
              if (!(e instanceof CollectionError)) throw e;
              persistArticles(m, e.articles);
              laneReports.push({
                ...e.report,
                message: `${lane}：${e.report.message}`,
              });
              remaining -= e.report.requests;
            }
          }
          return {
            source: "x",
            status:
              refreshed.status !== "ok"
                ? refreshed.status
                : laneReports.every((r) => ["ok", "skipped"].includes(r.status))
                  ? "ok"
                  : laneReports.every((r) => r.status === "unconfigured")
                    ? "unconfigured"
                    : laneReports.every((r) => r.status === "error")
                      ? "error"
                      : laneReports.some((r) => r.status === "budget")
                        ? "budget"
                        : "partial",
            count: laneReports.reduce((n, r) => n + r.count, 0),
            rawCount: laneReports.reduce(
              (n, r) => n + (r.rawCount ?? r.count),
              0,
            ),
            filteredCount: laneReports.reduce(
              (n, r) => n + (r.filteredCount ?? 0),
              0,
            ),
            requests:
              laneReports.reduce((n, r) => n + r.requests, 0) +
              refreshed.requests,
            message: [...laneReports.map((r) => r.message), refreshed.message]
              .filter(Boolean)
              .join("；"),
            filterReasons: laneReports.reduce<Record<string, number>>(
              (sum, r) => {
                for (const [key, value] of Object.entries(
                  r.filterReasons || {},
                ))
                  sum[key] = (sum[key] || 0) + value;
                return sum;
              },
              {},
            ),
          } satisfies SourceReport;
        } else if (source === "google" || source === "bing") {
          if (!webDue(m, source))
            return {
              source,
              status: "skipped" as const,
              count: 0,
              requests: 0,
              message: `网页扫描间隔 ${policyFor(m).webIntervalMinutes} 分钟，尚未到期`,
            };
          collection = await collectWebDiscovery(m, source, fetcher);
          persistArticles(m, collection.articles);
          if (collection.report.status === "ok")
            writeSetting(`web-at:${m.id}:${source}`, now);
        } else {
          const old = db
            .select()
            .from(checkpoints)
            .where(eq(checkpoints.id, `${m.id}:${source}`))
            .get()?.state;
          const sourceFrom =
            old?.fingerprint === fingerprint &&
            typeof old.completedAt === "number"
              ? old.completedAt - 120000
              : from;
          if (source === "hn")
            collection = await collectHn(
              m,
              sourceFrom,
              now,
              settings.maxPages,
              fetcher,
            );
          else if (source === "github")
            collection = await collectGithub(m, sourceFrom, now, fetcher);
          else collection = await collectRss(m, sourceFrom, now, fetcher);
          persistArticles(m, collection.articles);
          // Failed or limited samples must not advance a successful time boundary.
          if (collection.report.status === "ok")
            saveCheckpoint(`${m.id}:${source}`, {
              from: sourceFrom,
              to: now,
              cursor: "",
              completedAt: now,
              fingerprint,
            });
        }
        return collection.report;
      } catch (e) {
        if (e instanceof CollectionError) {
          persistArticles(m, e.articles);
          return e.report;
        }
        return {
          source,
          status: "error" as const,
          count: 0,
          requests: 0,
          message: safeError(e),
        };
      }
    });
    reports = await Promise.all(tasks);
    db.update(runs).set({ reports }).where(eq(runs.id, runId)).run();
    enqueuePipeline(m);
    if (
      reports.every((r) => r.status === "error" || r.status === "unconfigured")
    )
      status = "failed";
    else if (reports.some((r) => !["ok", "skipped"].includes(r.status)))
      status = "partial";
  } catch (e) {
    error = safeError(e);
    status = "analysis_failed";
  } finally {
    const finished = Date.now();
    db.update(runs)
      .set({
        status,
        reports,
        finishedAt: finished,
        analyzedCount,
        eventCount,
        tokens,
        error,
      })
      .where(eq(runs.id, runId))
      .run();
    db.update(monitors)
      .set({
        leaseUntil: 0,
        lastRunAt: now,
        nextRunAt: finished + m.intervalMinutes * 60000,
        lastStatus: status,
      })
      .where(eq(monitors.id, id))
      .run();
  }
  return true;
}
export function nextDueMonitor() {
  const now = Date.now();
  return getDb()
    .select()
    .from(monitors)
    .where(
      and(
        lte(monitors.leaseUntil, now),
        or(
          eq(monitors.scanRequested, true),
          and(eq(monitors.active, true), lte(monitors.nextRunAt, now)),
        ),
      ),
    )
    .orderBy(monitors.nextRunAt)
    .get();
}
