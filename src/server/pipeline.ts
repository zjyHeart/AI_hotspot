import { randomUUID } from "node:crypto";
import { and, eq, lte, sql, desc, inArray } from "drizzle-orm";
import { getDb } from "./db";
import {
  candidates,
  analysisJobs,
  articles,
  articleMonitors,
  events,
  monitors,
  notifications,
  eventFeedback,
  aiCalls,
} from "./schema";
import {
  getSettings,
  readSetting,
  writeSetting,
  emailConfigured,
} from "./config";
import {
  qualityDecision,
  qualityTags,
  fairCandidates,
  fingerprint,
  observationUntil,
} from "./quality";
import { persistArticles, canNotify } from "./article-store";
import { collectWeb, enrichArticles } from "./web-sources";
import {
  screenArticles,
  analyzeEvent,
  SCREEN_VERSION,
  DEEP_VERSION,
  type ScreenItem,
} from "./analysis-stages";
import { hotspotScore, evidenceBoundary } from "./ai";
import { aiUsage, AIBudgetError } from "./ai-budget";
import { threadContext, contextUsage } from "./thread-context";
import { ServiceError, safeError, type Fetcher } from "./http";
import type { Article, Monitor, Event, Dashboard } from "../shared/types";

type Job = typeof analysisJobs.$inferSelect;
const normalize = (s: string) =>
  s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
function digest(a: Article, m: Monitor) {
  const s = getSettings();
  return fingerprint(
    JSON.stringify([
      a.text,
      a.publishedAt,
      a.metadata?.contentStatus,
      m.keywords,
      m.aliases,
      m.excludes,
      m.minRelevance,
      m.quality,
      s.minValue,
      s.eventWindowHours,
      s.thinkingMode,
      s.model,
      s.outputMode,
      s.publishers,
      s.xAccounts,
      SCREEN_VERSION,
      DEEP_VERSION,
    ]),
  );
}
function findArticle(id: string) {
  return getDb().select().from(articles).where(eq(articles.id, id)).get();
}
function eventGroup(m: Monitor, item: ScreenItem) {
  // A model-suggested match is never enough to merge differing subjects/versions/dates.
  return fingerprint(
    JSON.stringify([
      m.id,
      normalize(item.subject || ""),
      item.action,
      normalize(item.version || "unknown"),
      item.eventDate,
      normalize(item.eventKey || ""),
    ]),
  );
}

export function enqueuePipeline(m: Monitor) {
  const db = getDb(),
    s = getSettings(),
    now = Date.now();
  const linked = db
    .select({ a: articles, l: articleMonitors })
    .from(articleMonitors)
    .innerJoin(articles, eq(articles.id, articleMonitors.articleId))
    .where(eq(articleMonitors.monitorId, m.id))
    .all();
  db.transaction(
    () => {
      for (const { a, l } of linked) {
        const reason = qualityDecision(a, m, s.publishers, s.xAccounts);
        const observing =
          !reason &&
          observationUntil(a, m, s.publishers, s.xAccounts, now) !== null;
        const state = reason
          ? "filtered"
          : observing
            ? "observing"
            : a.publishedAt &&
                a.publishedAt < now - s.eventWindowHours * 3600000
              ? "background"
              : "pending";
        const hash = digest(a, m);
        const old = db
          .select()
          .from(candidates)
          .where(eq(candidates.id, l.id))
          .get();
        if (
          old?.digest === hash &&
          (old.state !== "filtered" || reason) &&
          !(old.state === "observing" && state !== "observing") &&
          !(state === "observing" && old.state !== "observing") &&
          !(state === "background" && old.state !== "background")
        )
          continue;
        const { history: previousHistory, ...previousAssessment } =
          old?.assessment || {};
        const history = Array.isArray(previousHistory) ? previousHistory : [];
        const audit =
          old && !["pending", "queued"].includes(old.state)
            ? [
                ...history,
                {
                  digest: old.digest,
                  state: old.state,
                  reason: old.reason,
                  assessment: previousAssessment,
                  updatedAt: old.updatedAt,
                },
              ].slice(-5)
            : history;
        db.insert(candidates)
          .values({
            id: l.id,
            monitorId: m.id,
            articleId: a.id,
            digest: hash,
            state,
            reason:
              reason ||
              (observing ? "低互动新帖观察中，期满后按预算复查互动" : "") ||
              (state === "background"
                ? "超过活跃窗口，保留作背景"
                : "等待 AI 初筛"),
            assessment: { tags: qualityTags(a, m, s.xAccounts) },
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: candidates.id,
            set: {
              digest: hash,
              state,
              reason:
                reason ||
                (observing ? "低互动新帖观察中，期满后按预算复查互动" : "") ||
                (state === "background"
                  ? "超过活跃窗口，保留作背景"
                  : "内容或分析配置变化，重新初筛"),
              relevance: null,
              value: null,
              groupKey: null,
              assessment: {
                tags: qualityTags(a, m, s.xAccounts),
                history: audit,
              },
              updatedAt: now,
            },
          })
          .run();
        // Historical link fields remain available; semantic filtering no longer blocks AI.
        db.update(articleMonitors)
          .set({
            filterReason: reason || null,
            analyzedAt: ["pending", "observing"].includes(state) ? null : now,
          })
          .where(eq(articleMonitors.id, l.id))
          .run();
        if (old?.groupKey) queueDeep(m.id, old.groupKey);
      }
      const waiting = db
        .select()
        .from(candidates)
        .where(
          and(eq(candidates.monitorId, m.id), eq(candidates.state, "pending")),
        )
        .all();
      const offset = readSetting<number>("pipeline-offset:" + m.id, 0);
      const picked = fairCandidates(
        waiting.map((c) => findArticle(c.articleId)!).filter(Boolean),
        s.candidateLimit,
        offset,
        s.publishers,
        now,
        { monitor: m, accounts: s.xAccounts },
      );
      writeSetting("pipeline-offset:" + m.id, offset + 1);
      const batch = Math.max(1, Math.min(5, s.batchSize));
      for (let i = 0; i < picked.length; i += batch) {
        const list = picked
          .slice(i, i + batch)
          .map((a) => waiting.find((c) => c.articleId === a.id)!);
        const items = list.map((c) => ({ id: c.id, digest: c.digest }));
        const id = fingerprint(JSON.stringify(["screen", m.id, items]));
        const previous = db
          .select()
          .from(analysisJobs)
          .where(eq(analysisJobs.id, id))
          .get();
        db.insert(analysisJobs)
          .values({
            id,
            monitorId: m.id,
            stage: "screen",
            state: "queued",
            payload: { items },
            batchLimit: batch,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: analysisJobs.id,
            set: {
              state:
                previous?.leaseUntil && previous.leaseUntil > now
                  ? "running"
                  : "queued",
              revision: sql`${analysisJobs.revision}+1`,
              attempts: 0,
              nextAttemptAt: 0,
              error: null,
              updatedAt: now,
            },
          })
          .run();
        for (const c of list)
          db.update(candidates)
            .set({ state: "queued" })
            .where(eq(candidates.id, c.id))
            .run();
      }
    },
    { behavior: "immediate" },
  );
}
function queueDeep(monitorId: string, groupKey: string) {
  const db = getDb(),
    now = Date.now(),
    id = fingerprint("deep:" + monitorId + ":" + groupKey + ":" + DEEP_VERSION);
  const old = db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.id, id))
    .get();
  db.insert(analysisJobs)
    .values({
      id,
      monitorId,
      stage: "deep",
      state: "queued",
      payload: { groupKey },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: analysisJobs.id,
      set: {
        revision: sql`${analysisJobs.revision}+1`,
        state: old?.leaseUntil && old.leaseUntil > now ? "running" : "queued",
        attempts: 0,
        nextAttemptAt: now,
        error: null,
        updatedAt: now,
      },
    })
    .run();
}
export function requestAnalysis(monitorId: string) {
  const m = getDb()
    .select()
    .from(monitors)
    .where(eq(monitors.id, monitorId))
    .get();
  if (!m) throw new ServiceError("频道不存在", 404);
  writeSetting("analysis-request:" + monitorId, true);
  enqueuePipeline(m);
}
export function claimAnalysis(monitorId?: string): Job | undefined {
  const db = getDb(),
    now = Date.now(),
    s = getSettings();
  return db.transaction(
    () => {
      const allowed = db
        .select()
        .from(monitors)
        .where(lte(monitors.leaseUntil, now))
        .all()
        .filter((m) =>
          monitorId
            ? m.id === monitorId
            : readSetting<boolean>("analysis-request:" + m.id, false) ||
              (m.active && s.analysisEnabled),
        )
        .map((m) => m.id);
      if (!allowed.length) return;
      // Filter paused channels before LIMIT; otherwise a paused backlog could starve active work.
      const job = db
        .select()
        .from(analysisJobs)
        .where(
          and(
            inArray(analysisJobs.monitorId, allowed),
            lte(analysisJobs.leaseUntil, now),
            lte(analysisJobs.nextAttemptAt, now),
            sql`${analysisJobs.state} in ('queued','retry','budget','running')`,
          ),
        )
        .orderBy(
          sql`case when ${analysisJobs.stage}='deep' then 0 else 1 end`,
          analysisJobs.createdAt,
        )
        .get();
      if (!job) return;
      db.update(monitors)
        .set({ leaseUntil: now + 15 * 60000 })
        .where(eq(monitors.id, job.monitorId))
        .run();
      return db
        .update(analysisJobs)
        .set({
          state: "running",
          leaseUntil: now + 15 * 60000,
          leaseToken: randomUUID(),
          attempts: job.attempts + 1,
          updatedAt: now,
        })
        .where(eq(analysisJobs.id, job.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}
function owns(job: Job) {
  const current = getDb()
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.id, job.id))
    .get();
  return (
    current?.leaseToken === job.leaseToken && current.leaseUntil > Date.now()
  );
}
function complete(job: Job) {
  const db = getDb();
  db.update(analysisJobs)
    .set({
      state: sql`case when revision=${job.revision} then 'done' else 'queued' end`,
      attempts: 0,
      leaseUntil: 0,
      leaseToken: null,
      error: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(analysisJobs.id, job.id),
        eq(analysisJobs.leaseToken, job.leaseToken!),
      ),
    )
    .run();
}
export async function processNextAnalysis(
  fetcher: Fetcher = fetch,
  monitorId?: string,
) {
  const job = claimAnalysis(monitorId);
  if (!job) return false;
  const db = getDb(),
    m = db.select().from(monitors).where(eq(monitors.id, job.monitorId)).get()!;
  try {
    if (job.stage === "screen") await processScreen(job, m, fetcher);
    else await processDeep(job, m, fetcher);
    if (owns(job)) complete(job);
  } catch (error) {
    if (owns(job)) {
      const budget = error instanceof AIBudgetError;
      const message = safeError(error),
        truncated = message.includes("截断");
      // Retry only unprocessed material; reduce the batch after truncation.
      db.update(analysisJobs)
        .set({
          state: budget ? "budget" : job.attempts >= 3 ? "failed" : "retry",
          attempts: budget ? Math.max(0, job.attempts - 1) : job.attempts,
          batchLimit: truncated
            ? Math.max(1, Math.floor(job.batchLimit / 2))
            : job.batchLimit,
          error: message,
          leaseUntil: 0,
          leaseToken: null,
          nextAttemptAt:
            Date.now() + (budget ? 3600000 : 60000 * 2 ** job.attempts),
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(analysisJobs.id, job.id),
            eq(analysisJobs.leaseToken, job.leaseToken!),
          ),
        )
        .run();
    }
  }
  db.update(monitors)
    .set({ leaseUntil: 0 })
    .where(and(eq(monitors.id, m.id), eq(monitors.leaseUntil, job.leaseUntil)))
    .run();
  enqueuePipeline(
    db.select().from(monitors).where(eq(monitors.id, m.id)).get()!,
  );
  const unfinished = db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.monitorId, m.id))
    .all()
    .some((j) => ["queued", "running", "retry", "budget"].includes(j.state));
  if (!unfinished) writeSetting("analysis-request:" + m.id, false);
  return true;
}
async function processScreen(job: Job, m: Monitor, fetcher: Fetcher) {
  const db = getDb(),
    s = getSettings();
  const todo = (job.payload.items || [])
    .map((x) =>
      db.select().from(candidates).where(eq(candidates.id, x.id)).get(),
    )
    .filter(
      (c) =>
        c &&
        c.state === "queued" &&
        job.payload.items?.some((x) => x.id === c.id && x.digest === c.digest),
    ) as (typeof candidates.$inferSelect)[];
  if (!todo.length) return;
  const chunk: typeof todo = [];
  let size = 0;
  for (const c of todo.slice(0, job.batchLimit)) {
    const a = findArticle(c.articleId)!;
    if (chunk.length && size + Math.min(a.text.length, 3000) > 7000) break;
    chunk.push(c);
    size += Math.min(a.text.length, 3000);
  }
  const list = chunk.map((c) => findArticle(c.articleId)!);
  const linksOnly = list.filter(
    (a) =>
      a.source === "x" &&
      a.text.replace(/https?:\/\/\S+|@\w+/g, "").trim().length < 25 &&
      a.metadata?.linkedUrls?.length,
  );
  if (linksOnly.length) {
    const usage = aiUsage();
    if (usage.calls >= Math.floor(s.aiDailyCallLimit * 0.8))
      throw new AIBudgetError();
    const originals = await enrichArticles(linksOnly, m, fetcher, {
      remaining: Math.min(2, s.bodyFetchLimit),
    });
    persistArticles(m, originals);
    enqueuePipeline(m);
  }
  const known = db
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.monitorId, m.id), eq(candidates.state, "selected")),
    )
    .all()
    .map((c) => {
      const { deep, deepAt, history, ...screen } = c.assessment;
      return screen as unknown as ScreenItem;
    });
  const screened = await screenArticles(m, list, known, job.id, fetcher);
  if (!owns(job)) return;
  db.transaction(
    () => {
      for (const item of screened.items) {
        const c = chunk.find((c) => c.articleId === item.articleId)!;
        const current = db
          .select()
          .from(candidates)
          .where(eq(candidates.id, c.id))
          .get();
        const latestMonitor = db
          .select()
          .from(monitors)
          .where(eq(monitors.id, m.id))
          .get()!;
        if (
          current?.digest !== c.digest ||
          digest(findArticle(c.articleId)!, latestMonitor) !== c.digest
        )
          continue;
        let state: string =
          item.decision === "relevant" ? "selected" : item.decision;
        if (
          state === "selected" &&
          (item.relevance < m.minRelevance || item.value < s.minValue)
        )
          state = "low_value";
        const groupKey = state === "selected" ? eventGroup(m, item) : null;
        const reason =
          state === "low_value" && item.decision === "relevant"
            ? item.reason + "；未达到相关性或信息价值阈值"
            : item.reason;
        db.update(candidates)
          .set({
            state,
            reason,
            relevance: item.relevance,
            value: item.value,
            groupKey,
            assessment: { ...item, history: c.assessment.history || [] },
            updatedAt: Date.now(),
          })
          .where(eq(candidates.id, c.id))
          .run();
        db.update(articleMonitors)
          .set({ analyzedAt: Date.now() })
          .where(eq(articleMonitors.id, c.id))
          .run();
        if (groupKey) queueDeep(m.id, groupKey);
      }
      if (todo.length > chunk.length)
        db.update(analysisJobs)
          .set({ revision: sql`${analysisJobs.revision}+1` })
          .where(eq(analysisJobs.id, job.id))
          .run();
    },
    { behavior: "immediate" },
  );
}
async function processDeep(job: Job, m: Monitor, fetcher: Fetcher) {
  const db = getDb(),
    s = getSettings(),
    now = Date.now();
  const group = db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.monitorId, m.id),
        eq(candidates.groupKey, job.payload.groupKey!),
        eq(candidates.state, "selected"),
      ),
    )
    .all();
  const eventId = fingerprint("event:" + m.id + ":" + job.payload.groupKey);
  if (!group.length) {
    getDb()
      .update(events)
      .set({ relevance: 0, updatedAt: now })
      .where(eq(events.id, eventId))
      .run();
    return;
  }
  const u = aiUsage();
  if (
    u.calls >= s.aiDailyCallLimit ||
    u.tokens + u.reserved + 10000 > s.aiDailyTokenLimit
  )
    throw new AIBudgetError();
  const assessments = group.map((c) => {
    const { deep, deepAt, history, ...screen } = c.assessment;
    return screen as unknown as ScreenItem;
  });
  const base = group.map((c) => findArticle(c.articleId)!).filter(Boolean);
  const old = db.select().from(events).where(eq(events.id, eventId)).get();
  const historical = (old?.evidence || [])
    .map((e) => findArticle(e.articleId))
    .filter(Boolean) as Article[];
  const inputs = [
    ...new Map([...base, ...historical].map((a) => [a.id, a])).values(),
  ];
  // Mix new and previously analyzed evidence from the whole cluster; note limited coverage.
  const unreviewed = group
    .filter((c) => !c.assessment.deepAt)
    .map((c) => findArticle(c.articleId)!)
    .filter(Boolean);
  const offset = readSetting<number>("deep-offset:" + eventId, 0);
  const rotated = inputs
    .slice(offset % inputs.length)
    .concat(inputs.slice(0, offset % inputs.length));
  // New counter-evidence gets a slot even when older popular/official material dominates.
  const selected = [
    ...new Map(
      [...unreviewed.slice(0, 5), ...historical.slice(0, 3), ...rotated].map(
        (a) => [a.id, a],
      ),
    ).values(),
  ].slice(0, 10);
  writeSetting(
    "deep-offset:" + eventId,
    readSetting<number>("deep-offset:" + eventId, 0) + 1,
  );
  const bodyBudget = { remaining: s.bodyFetchLimit };
  const context = await threadContext(selected, fetcher);
  let enriched = await enrichArticles(
    [...selected, ...context.articles],
    m,
    fetcher,
    bodyBudget,
  );
  persistArticles(m, enriched);
  const engines = m.sources.filter(
    (x): x is "google" | "bing" => x === "google" || x === "bing",
  );
  const verifyAt = readSetting<number>("deep-verify:" + eventId, 0);
  if (
    engines.length &&
    process.env.SERPAPI_API_KEY &&
    (old?.credibility === "unverified" ||
      enriched.every(
        (a) =>
          a.metadata?.contentStatus === "snippet" ||
          a.metadata?.contentStatus === "failed",
      )) &&
    now - verifyAt >= 4 * 3600000
  ) {
    const primary = assessments[0];
    const query = [
      primary.subject,
      primary.version,
      primary.action,
      ...primary.claims.slice(0, 1),
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 250);
    const engine =
      engines[
        readSetting<number>("deep-offset:" + eventId, 0) % engines.length
      ];
    const extra = await collectWeb(m, engine, fetcher, query);
    if (extra.report.status === "ok" || extra.report.status === "error")
      writeSetting("deep-verify:" + eventId, now);
    const bodies = await enrichArticles(
      extra.articles.slice(0, 3),
      m,
      fetcher,
      bodyBudget,
    );
    persistArticles(m, bodies);
    enriched.push(...bodies);
  }
  // Body persistence may canonicalize IDs; hydrate the canonical records for valid references.
  enriched = [
    ...new Map(
      enriched.map((a) => {
        const canonical =
          db.select().from(articles).where(eq(articles.url, a.url)).get() ||
          findArticle(a.id) ||
          a;
        return [canonical.id, canonical] as const;
      }),
    ).values(),
  ].slice(0, 12);
  const analyzed = await analyzeEvent(
    m,
    enriched,
    assessments,
    job.id,
    fetcher,
    job.error,
  );
  if (!owns(job)) return;
  const current = db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.id, job.id))
    .get()!;
  if (current.revision !== job.revision) return; // New evidence arrived: replay the whole cluster.
  const result = analyzed.result;
  result.gaps.push(...context.gaps);
  const knownDates = enriched.map((a) => a.publishedAt).filter(Boolean);
  const oldOnly =
    knownDates.length === enriched.length &&
    knownDates.every((at) => at < now - s.eventWindowHours * 3600000);
  const publish =
    result.disposition === "publish" &&
    result.relevance >= m.minRelevance &&
    result.value >= s.minValue &&
    !oldOnly;
  if (inputs.length > selected.length)
    result.gaps.push(
      `事件共有 ${inputs.length} 篇材料，本轮核验 ${selected.length} 篇；未读部分不视为已验证`,
    );
  db.transaction(
    () => {
      if (publish) {
        const score = hotspotScore(result.relevance, enriched, now);
        const details = {
          importance: result.importance,
          importanceReason: result.importanceReason,
          firstDiscoveredAt: Math.min(
            old?.details?.firstDiscoveredAt ?? old?.createdAt ?? Infinity,
            ...inputs.map((a) => a.collectedAt),
          ),
          // Only evidence-linked native publication dates or extracted verified article dates.
          publishedAt:
            old?.details?.publishedAt ??
            (() => {
              const dates = enriched
                .filter(
                  (a) =>
                    result.evidence.some((e) => e.articleId === a.id) &&
                    !a.isRepost &&
                    a.publishedAt > 0 &&
                    (a.metadata?.publishedVerified ||
                      (a.source === "x" && a.metadata?.contentKind !== "web") ||
                      a.metadata?.contentKind === "release"),
                )
                .map((a) => a.publishedAt);
              return dates.length ? Math.min(...dates) : null;
            })(),
          value: result.value,
          impact: result.impact,
          gaps: result.gaps,
          claims: result.claims,
        };
        const changed =
          !old ||
          JSON.stringify([
            old.title,
            old.summary,
            old.credibility,
            old.evidence,
            old.details,
          ]) !==
            JSON.stringify([
              result.title,
              result.summary,
              result.credibility,
              result.evidence,
              details,
            ]);
        const value: Event = {
          id: eventId,
          monitorId: m.id,
          eventKey: job.payload.groupKey!,
          title: result.title,
          summary: result.summary,
          relevance: result.relevance,
          credibility: result.credibility,
          reason:
            result.reason +
            "\n本地证据校验：" +
            evidenceBoundary(result.credibility, result.evidence, enriched),
          evidence: result.evidence,
          details,
          ...score,
          createdAt: old?.createdAt ?? now,
          updatedAt: changed ? now : old!.updatedAt,
          notifiedAt: old?.notifiedAt ?? null,
          revision: old ? old.revision + Number(changed) : 1,
        };
        db.insert(events)
          .values(value)
          .onConflictDoUpdate({ target: events.id, set: value })
          .run();
        if (changed && canNotify(m, value, enriched, now)) {
          const id = fingerprint(eventId + ":" + value.revision);
          db.insert(notifications)
            .values({
              id,
              eventId,
              monitorId: m.id,
              title: value.title,
              body: value.summary,
              createdAt: now,
              readAt: null,
              emailStatus: emailConfigured() ? "queued" : "unconfigured",
              nextAttemptAt: now,
            })
            .onConflictDoNothing()
            .run();
          db.update(events)
            .set({ notifiedAt: now })
            .where(eq(events.id, eventId))
            .run();
        }
      } else if (old) {
        // Preserve history, but hide a reassessed low-value/background event from the default feed.
        db.update(events)
          .set({
            details: {
              ...old.details,
              value: result.value,
              gaps: [...result.gaps, "重新核验后不再满足展示条件"],
            },
            relevance: 0,
            updatedAt: now,
          })
          .where(eq(events.id, eventId))
          .run();
      }
      for (const c of group.filter((c) =>
        selected.some((a) => a.id === c.articleId),
      ))
        db.update(candidates)
          .set({
            assessment: { ...c.assessment, deep: result, deepAt: now },
            reason: c.reason + "\n深度分析：" + result.reason,
            updatedAt: now,
          })
          .where(eq(candidates.id, c.id))
          .run();
      if (unreviewed.some((a) => !selected.some((p) => p.id === a.id)))
        db.update(analysisJobs)
          .set({ revision: sql`${analysisJobs.revision}+1` })
          .where(eq(analysisJobs.id, job.id))
          .run();
    },
    { behavior: "immediate" },
  );
}

export function retryAnalysis(id: string) {
  const db = getDb(),
    job = db.select().from(analysisJobs).where(eq(analysisJobs.id, id)).get();
  if (!job) throw new ServiceError("分析任务不存在", 404);
  if (job.leaseUntil > Date.now()) throw new ServiceError("分析正在运行", 409);
  db.update(analysisJobs)
    .set({
      state: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      error: job.error,
      leaseUntil: 0,
      leaseToken: null,
      updatedAt: Date.now(),
    })
    .where(eq(analysisJobs.id, id))
    .run();
  writeSetting("analysis-request:" + job.monitorId, true);
}
export function addFeedback(eventId: string, verdict: string) {
  if (!getDb().select().from(events).where(eq(events.id, eventId)).get())
    throw new ServiceError("事件不存在", 404);
  getDb()
    .insert(eventFeedback)
    .values({ id: randomUUID(), eventId, verdict, createdAt: Date.now() })
    .run();
}
export function pipelineDashboard(): Dashboard["pipeline"] {
  const db = getDb();
  const now = Date.now(), settings = getSettings();
  const monitorList = db.select().from(monitors).all();
  const allowed = new Set(monitorList.filter((m) =>
    readSetting<boolean>("analysis-request:" + m.id, false) ||
    (m.active && settings.analysisEnabled),
  ).map((m) => m.id));
  // Report current work independently of the limited audit list and historical counts.
  const outstanding = db.select({
    monitorId: analysisJobs.monitorId,
    stage: analysisJobs.stage,
    state: analysisJobs.state,
    leaseUntil: analysisJobs.leaseUntil,
    nextAttemptAt: analysisJobs.nextAttemptAt,
  }).from(analysisJobs)
    .where(sql`${analysisJobs.state} in ('queued','running','retry','budget','failed')`).all();
  const activity: Dashboard["pipeline"]["activity"] = {
    screen: 0, deep: 0, queued: 0, retry: 0, budget: 0, failed: 0, paused: 0,
    monitorNames: [],
  };
  for (const j of outstanding) {
    const live = j.state === "running" && j.leaseUntil > now;
    if (live) {
      activity[j.stage === "deep" ? "deep" : "screen"]++;
      const name = monitorList.find((m) => m.id === j.monitorId)?.name;
      if (name && !activity.monitorNames.includes(name)) activity.monitorNames.push(name);
    } else if (!allowed.has(j.monitorId)) activity.paused++;
    else if (j.state === "failed") activity.failed++;
    else if (j.state === "budget") activity.budget++;
    else if (j.state === "retry" && j.nextAttemptAt > now) activity.retry++;
    else activity.queued++;
  }
  const cs = db
    .select()
    .from(candidates)
    .orderBy(desc(candidates.updatedAt))
    .limit(30)
    .all();
  const jobs = db
    .select()
    .from(analysisJobs)
    .orderBy(desc(analysisJobs.updatedAt))
    .limit(20)
    .all();
  const candidateCounts = db
    .select({ state: candidates.state, n: sql<number>`count(*)` })
    .from(candidates)
    .groupBy(candidates.state)
    .all();
  const jobCounts = db
    .select({ state: analysisJobs.state, n: sql<number>`count(*)` })
    .from(analysisJobs)
    .groupBy(analysisJobs.state)
    .all();
  const displayed = db
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .innerJoin(monitors, eq(monitors.id, events.monitorId))
    .where(
      and(
        sql`${events.relevance}>=${monitors.minRelevance}`,
        sql`coalesce(json_extract(${events.details}, '$.value'),100)>=${getSettings().minValue}`,
      ),
    )
    .get()!.n;
  return {
    activity,
    candidates: Object.fromEntries(candidateCounts.map((r) => [r.state, r.n])),
    jobs: Object.fromEntries(jobCounts.map((r) => [r.state, r.n])),
    raw: db
      .select({ n: sql<number>`count(*)` })
      .from(articles)
      .get()!.n,
    displayed,
    usage: aiUsage(),
    contextRequests: contextUsage(),
    assessments: cs.map((c) => {
      const a = findArticle(c.articleId)!;
      return {
        id: c.id,
        monitorId: c.monitorId,
        title: a.title,
        url: a.url,
        state: c.state,
        reason: c.reason,
        relevance: c.relevance,
        value: c.value,
        updatedAt: c.updatedAt,
      };
    }),
    recentJobs: jobs.map((j) => ({
      id: j.id,
      monitorId: j.monitorId,
      stage: j.stage,
      state: j.state,
      attempts: j.attempts,
      error: j.error,
      updatedAt: j.updatedAt,
      nextAttemptAt: j.nextAttemptAt,
      aiDurationMs: db
        .select({
          n: sql<number>`coalesce(sum(${aiCalls.finishedAt}-${aiCalls.createdAt}),0)`,
        })
        .from(aiCalls)
        .where(eq(aiCalls.jobId, j.id))
        .get()!.n,
    })),
  };
}
