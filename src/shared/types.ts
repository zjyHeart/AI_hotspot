import { z } from "zod";

export const sourceNames = {
  x: "X / Twitter",
  hn: "Hacker News",
  github: "GitHub",
  rss: "RSS / Atom",
  google: "Google 网页",
  bing: "Bing 网页",
} as const;
export type Source = keyof typeof sourceNames;
export type Credibility =
  "supported" | "corroborated" | "unverified" | "disputed";
export const credibilityNames: Record<Credibility, string> = {
  supported: "有来源支持",
  corroborated: "多源支持",
  unverified: "待核实",
  disputed: "存在争议",
};
export const qualityInput = z.object({
  excludeReplies: z.boolean().default(true),
  engagementMode: z
    .enum(["loose", "standard", "strict", "custom"])
    .default("standard"),
  useCuratedAccounts: z.boolean().default(false),
  minLikes: z.number().int().min(0).max(100000).default(10),
  minReposts: z.number().int().min(0).max(100000).default(3),
  minReplies: z.number().int().min(0).max(100000).default(5),
  observationMinutes: z.number().int().min(0).max(1440).default(120),
  followedAccounts: z
    .array(z.string().regex(/^[a-zA-Z0-9_]{1,30}$/))
    .max(50)
    .default([]),
  blockedAccounts: z
    .array(z.string().regex(/^[a-zA-Z0-9_]{1,30}$/))
    .max(50)
    .default([]),
  webIntervalMinutes: z.number().int().min(30).max(1440).default(240),
  githubRepos: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .max(10)
    .default([]),
});
export type QualityPolicy = z.infer<typeof qualityInput>;
export const publisherInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().min(1).max(80),
  domains: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/)).max(10),
  xAccounts: z.array(z.string().regex(/^[a-zA-Z0-9_]{1,30}$/)).max(20),
  githubOwners: z.array(z.string().regex(/^[a-zA-Z0-9-]{1,39}$/)).max(10),
  proofUrl: z.url().max(1000),
});
export type Publisher = z.infer<typeof publisherInput>;
export const xAccountInput = z.object({
  handle: z.string().regex(/^[a-zA-Z0-9_]{1,15}$/),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["official", "expert"]),
  focus: z.string().trim().min(1).max(200),
  proofUrl: z.url().max(1000),
  active: z.boolean().default(true),
});
export const xAccountsInput = z
  .array(xAccountInput)
  .max(50)
  .superRefine((list, ctx) => {
    if (new Set(list.map((a) => a.handle.toLowerCase())).size !== list.length)
      ctx.addIssue({
        code: "custom",
        message: "X 账号不能重复（不区分大小写）",
      });
  });
export type XAccount = z.infer<typeof xAccountInput>;
export const importanceNames = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
  unassessed: "未评估",
} as const;
export type Importance = keyof typeof importanceNames;
export interface ArticleDetails {
  discoveryUrls?: string[];
  discoveryAuthors?: string[];
  qualityTags?: string[];
  query?: string;
  truncated?: boolean;
  originalLength?: number;
  contentKind?: "post" | "discussion" | "repository" | "release" | "web";
  contentStatus?: "native" | "snippet" | "full" | "failed";
  isReply?: boolean;
  replyToId?: string;
  linkedUrls?: string[];
  discoverySources?: Source[];
  originalUrl?: string;
  publisherId?: string;
  qualityScore?: number;
  filterReason?: string;
  policyVersion?: string;
  fetchedAt?: number;
  fetchError?: string;
  contentHash?: string;
  publishedVerified?: boolean;
  xDiscovery?: ("accounts" | "keywords" | "observation")[];
  isBlueVerified?: boolean;
  verifiedType?: string;
  followers?: number;
  engagementCheckedAt?: number;
  engagementRefreshAttemptAt?: number;
  engagementRefreshError?: string;
}
export const monitorInput = z.object({
  name: z.string().trim().min(1, "请填写监控名称").max(80),
  kind: z.enum(["keyword", "topic"]),
  keywords: z.string().trim().min(1, "请填写关键词或领域").max(200),
  aliases: z.string().trim().max(500).default(""),
  excludes: z.string().trim().max(500).default(""),
  sources: z
    .array(z.enum(["x", "hn", "github", "rss", "google", "bing"]))
    .min(1, "至少选择一个来源"),
  rssUrls: z.array(z.url().max(1000)).max(8).default([]),
  intervalMinutes: z.number().int().min(5).max(1440).default(30),
  minRelevance: z.number().int().min(0).max(100).default(65),
  notifyUnverified: z.boolean().default(false),
  cooldownMinutes: z.number().int().min(0).max(1440).default(60),
  active: z.boolean().default(true),
  quality: qualityInput.default(() => qualityInput.parse({})),
});
export type MonitorInput = z.infer<typeof monitorInput>;
export type Monitor = MonitorInput & {
  id: string;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number;
  lastStatus: string;
  leaseUntil: number;
  scanRequested: boolean;
};
export interface Metrics {
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  views?: number;
  points?: number;
  stars?: number;
}
export interface Article {
  id: string;
  source: Source;
  externalId: string;
  title: string;
  text: string;
  url: string;
  author: string;
  publishedAt: number;
  collectedAt: number;
  metrics: Metrics;
  originKey: string;
  isRepost: boolean;
  metadata?: ArticleDetails;
}
export interface Evidence {
  articleId: string;
  role: "first_party" | "independent" | "repost" | "unknown";
  excerpt: string;
}
export interface Event {
  details?: {
    importance?: Importance;
    importanceReason?: string;
    firstDiscoveredAt?: number;
    publishedAt?: number | null;
    value?: number;
    impact?: string;
    gaps?: string[];
    claims?: {
      claim: string;
      verdict: "supported" | "insufficient" | "contradicted";
      reason: string;
      articleIds: string[];
      citations?: { articleId: string; excerpt: string }[];
    }[];
  };
  id: string;
  monitorId: string;
  eventKey: string;
  title: string;
  summary: string;
  relevance: number;
  credibility: Credibility;
  reason: string;
  evidence: Evidence[];
  score: number;
  scoreReason: string;
  createdAt: number;
  updatedAt: number;
  notifiedAt: number | null;
  revision: number;
  articles?: Article[];
}
export interface SourceReport {
  source: Source;
  status: "ok" | "partial" | "error" | "unconfigured" | "skipped" | "budget";
  rawCount?: number;
  filteredCount?: number;
  filterReasons?: Record<string, number>;
  fullCount?: number;
  analyzedCount?: number;
  count: number;
  requests: number;
  message: string;
}
export interface ScanRun {
  id: string;
  monitorId: string;
  monitorName: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  reports: SourceReport[];
  analyzedCount: number;
  eventCount: number;
  tokens: number;
  error: string | null;
}
export interface Notification {
  id: string;
  eventId: string;
  monitorId: string;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  emailStatus: string;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number;
  lastError: string | null;
}
export interface Settings {
  xAccounts: XAccount[];
  xDailyRequestLimit: number;
  xMonthlyRequestLimit: number;
  xRequestsPerScan: number;
  thinkingMode: "auto" | "disabled";
  analysisEnabled: boolean;
  xContextDailyLimit: number;
  aiDailyCallLimit: number;
  aiDailyTokenLimit: number;
  candidateLimit: number;
  eventWindowHours: number;
  minValue: number;
  webPages: number;
  defaultInterval: number;
  model: string;
  baseUrl: string;
  outputMode: "json_schema" | "json_object" | "text";
  maxPages: number;
  batchSize: number;
  searchDailyLimit: number;
  searchMonthlyLimit: number;
  verificationDailyLimit: number;
  bodyFetchLimit: number;
  publishers: Publisher[];
}
export interface Health {
  x: boolean;
  ai: boolean;
  email: boolean;
  github: boolean;
  search: boolean;
  worker: boolean;
  workerAt: number | null;
}
export interface Dashboard {
  xUsage: { day: number; month: number; categories: Record<string, number> };
  pipeline: {
    activity: {
      screen: number;
      deep: number;
      queued: number;
      retry: number;
      budget: number;
      failed: number;
      paused: number;
      monitorNames: string[];
    };
    candidates: Record<string, number>;
    jobs: Record<string, number>;
    raw: number;
    displayed: number;
    assessments: {
      id: string;
      monitorId: string;
      title: string;
      url: string;
      state: string;
      reason: string;
      relevance: number | null;
      value: number | null;
      updatedAt: number;
    }[];
    recentJobs: {
      id: string;
      monitorId: string;
      stage: string;
      state: string;
      attempts: number;
      error: string | null;
      updatedAt: number;
      nextAttemptAt: number;
      aiDurationMs: number;
    }[];
    usage: { calls: number; tokens: number; unknown: number; reserved: number };
    contextRequests: number;
  };
  monitors: Monitor[];
  events: Event[];
  notifications: Notification[];
  runs: ScanRun[];
  settings: Settings;
  health: Health;
  pendingCount: number;
  rawArticles: Article[];
  sourceStats: {
    source: Source;
    collected: number;
    pending: number;
    filtered: number;
  }[];
  searchUsage: { day: number; month: number; verification: number };
}

export const settingsInput = z.object({
  xAccounts: xAccountsInput.optional(),
  xDailyRequestLimit: z.number().int().min(0).max(10000).default(144),
  xMonthlyRequestLimit: z.number().int().min(0).max(100000).default(4320),
  xRequestsPerScan: z.number().int().min(1).max(20).default(3),
  thinkingMode: z.enum(["auto", "disabled"]).default("auto"),
  analysisEnabled: z.boolean().default(false),
  xContextDailyLimit: z.number().int().min(0).max(1000).default(10),
  aiDailyCallLimit: z.number().int().min(0).max(10000).default(60),
  aiDailyTokenLimit: z.number().int().min(0).max(10000000).default(200000),
  candidateLimit: z.number().int().min(10).max(1000).default(200),
  eventWindowHours: z.number().int().min(1).max(720).default(72),
  minValue: z.number().int().min(0).max(100).default(60),
  webPages: z.number().int().min(1).max(5).default(1),
  defaultInterval: z.number().int().min(5).max(1440),
  model: z
    .string()
    .regex(/^[a-zA-Z0-9_./:~-]*$/)
    .max(150),
  baseUrl: z.url(),
  outputMode: z.enum(["json_schema", "json_object", "text"]),
  maxPages: z.number().int().min(1).max(10),
  batchSize: z.number().int().min(1).max(30),
  searchDailyLimit: z.number().int().min(0).max(10000).default(30),
  searchMonthlyLimit: z.number().int().min(0).max(100000).default(900),
  verificationDailyLimit: z.number().int().min(0).max(1000).default(6),
  bodyFetchLimit: z.number().int().min(0).max(20).default(6),
  publishers: z.array(publisherInput).max(100).optional(),
});
