import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type {
  Source,
  MonitorInput,
  Metrics,
  Evidence,
  Credibility,
  SourceReport,
  QualityPolicy,
  ArticleDetails,
  Event,
} from "../shared/types";

export const monitors = sqliteTable("monitors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<MonitorInput["kind"]>().notNull(),
  keywords: text("keywords").notNull(),
  aliases: text("aliases").notNull(),
  excludes: text("excludes").notNull(),
  sources: text("sources", { mode: "json" }).$type<Source[]>().notNull(),
  rssUrls: text("rss_urls", { mode: "json" }).$type<string[]>().notNull(),
  intervalMinutes: integer("interval_minutes").notNull(),
  minRelevance: integer("min_relevance").notNull(),
  notifyUnverified: integer("notify_unverified", { mode: "boolean" }).notNull(),
  cooldownMinutes: integer("cooldown_minutes").notNull(),
  quality: text("quality", { mode: "json" })
    .$type<QualityPolicy>()
    .notNull()
    .default({
      excludeReplies: true,
      minLikes: 20,
      minReposts: 5,
      followedAccounts: [],
      blockedAccounts: [],
      webIntervalMinutes: 240,
      githubRepos: [],
    } as unknown as QualityPolicy), // Preserve the historical SQL default; policyFor normalizes old JSON on read.
  active: integer("active", { mode: "boolean" }).notNull(),
  scanRequested: integer("scan_requested", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at").notNull(),
  lastRunAt: integer("last_run_at"),
  nextRunAt: integer("next_run_at").notNull(),
  lastStatus: text("last_status").notNull().default("idle"),
  leaseUntil: integer("lease_until").notNull().default(0),
});
export const articles = sqliteTable("articles", {
  id: text("id").primaryKey(),
  source: text("source").$type<Source>().notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  text: text("body").notNull(),
  url: text("url").notNull(),
  author: text("author").notNull(),
  publishedAt: integer("published_at").notNull(),
  collectedAt: integer("collected_at").notNull(),
  metrics: text("metrics", { mode: "json" }).$type<Metrics>().notNull(),
  originKey: text("origin_key").notNull(),
  metadata: text("metadata", { mode: "json" })
    .$type<ArticleDetails>()
    .notNull()
    .default({}),
  isRepost: integer("is_repost", { mode: "boolean" }).notNull(),
});
export const articleMonitors = sqliteTable("article_monitors", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id")
    .notNull()
    .references(() => monitors.id),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id),
  analyzedAt: integer("analyzed_at"),
  filterReason: text("filter_reason"),
  policyVersion: text("policy_version"),
});
export const checkpoints = sqliteTable("source_checkpoints", {
  id: text("id").primaryKey(),
  state: text("state", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
});
export const metricSnapshots = sqliteTable("article_metric_snapshots", {
  id: text("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id),
  sampledAt: integer("sampled_at").notNull(),
  metrics: text("metrics", { mode: "json" }).$type<Metrics>().notNull(),
});
export const events = sqliteTable("events", {
  details: text("details", { mode: "json" })
    .$type<Event["details"]>()
    .notNull()
    .default({}),
  id: text("id").primaryKey(),
  monitorId: text("monitor_id")
    .notNull()
    .references(() => monitors.id),
  eventKey: text("event_key").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  relevance: integer("relevance").notNull(),
  credibility: text("credibility").$type<Credibility>().notNull(),
  reason: text("reason").notNull(),
  evidence: text("evidence", { mode: "json" }).$type<Evidence[]>().notNull(),
  score: integer("score").notNull(),
  scoreReason: text("score_reason").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  notifiedAt: integer("notified_at"),
  revision: integer("revision").notNull(),
});

export const candidates = sqliteTable(
  "analysis_candidates",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id),
    digest: text("digest").notNull(),
    state: text("state").notNull(),
    reason: text("reason").notNull().default("等待 AI 初筛"),
    relevance: integer("relevance"),
    value: integer("value"),
    groupKey: text("group_key"),
    assessment: text("assessment", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("candidate_monitor_state").on(t.monitorId, t.state),
    index("candidate_group").on(t.monitorId, t.groupKey),
  ],
);

export const analysisJobs = sqliteTable(
  "analysis_jobs",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    stage: text("stage").$type<"screen" | "deep">().notNull(),
    state: text("state").notNull().default("queued"),
    payload: text("payload", { mode: "json" })
      .$type<{ items?: { id: string; digest: string }[]; groupKey?: string }>()
      .notNull(),
    revision: integer("revision").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    batchLimit: integer("batch_limit").notNull().default(3),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    leaseUntil: integer("lease_until").notNull().default(0),
    leaseToken: text("lease_token"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("job_due").on(t.state, t.nextAttemptAt, t.leaseUntil)],
);

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    stage: text("stage").notNull(),
    day: text("day").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    tokens: integer("tokens"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("ai_call_day").on(t.day)],
);

export const eventFeedback = sqliteTable("event_feedback", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  verdict: text("verdict").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const runs = sqliteTable("scan_runs", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id")
    .notNull()
    .references(() => monitors.id),
  monitorName: text("monitor_name").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  reports: text("reports", { mode: "json" }).$type<SourceReport[]>().notNull(),
  analyzedCount: integer("analyzed_count").notNull().default(0),
  eventCount: integer("event_count").notNull().default(0),
  tokens: integer("tokens").notNull().default(0),
  error: text("error"),
});
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  monitorId: text("monitor_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
  emailStatus: text("email_status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  leaseUntil: integer("lease_until").notNull().default(0),
  lastError: text("last_error"),
});
export const deliveryAttempts = sqliteTable("delivery_attempts", {
  id: text("id").primaryKey(),
  notificationId: text("notification_id").notNull(),
  createdAt: integer("created_at").notNull(),
  status: text("status").notNull(),
  error: text("error"),
});
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
