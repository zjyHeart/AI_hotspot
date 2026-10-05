import { z } from "zod";
import { curatedAccount } from "./x-accounts";
import type { Event, Monitor, Settings, Source } from "./types";

export const feedFilterInput = z.object({
  query: z.string().max(200).default(""),
  sources: z
    .array(z.enum(["x", "hn", "github", "rss", "google", "bing"]))
    .max(6)
    .default([]),
  monitorIds: z.array(z.string().max(100)).max(100).default([]),
  credibility: z
    .enum(["all", "supported", "corroborated", "unverified", "disputed"])
    .default("all"),
  importance: z
    .enum(["all", "urgent", "high", "medium", "low", "unassessed"])
    .default("all"),
  accountScope: z.enum(["all", "curated", "official"]).default("all"),
  engagement: z.enum(["all", "standard", "strict", "custom"]).default("all"),
  minLikes: z.number().int().min(0).max(100000).default(10),
  minReposts: z.number().int().min(0).max(100000).default(3),
  minReplies: z.number().int().min(0).max(100000).default(5),
  minRelevance: z.number().int().min(0).max(100).default(0),
  hours: z.enum(["1", "6", "24", "168", "all"]).default("24"),
  timeField: z.enum(["discovery", "publication"]).default("discovery"),
  sort: z
    .enum([
      "recommended",
      "importance",
      "relevance",
      "heat",
      "publication",
      "discovery",
    ])
    .default("recommended"),
});
export type FeedFilters = z.infer<typeof feedFilterInput>;
export interface FeedPage {
  items: Event[];
  total: number;
  page: number;
  pageSize: number;
}
export const importanceRank = (e: Event) =>
  ({ urgent: 4, high: 3, medium: 2, low: 1, unassessed: 0 })[
    e.details?.importance ?? "unassessed"
  ];
export const firstDiscovered = (e: Event) =>
  e.details?.firstDiscoveredAt ?? e.createdAt;
export const publicationTime = (e: Event) => e.details?.publishedAt ?? null;
export const socialHeat = (e: Event) =>
  (e.articles || [])
    .filter((a) => a.source === "x")
    .reduce(
      (n, a) =>
        n +
        (a.metrics.likes ?? 0) +
        3 * (a.metrics.reposts ?? 0) +
        2 * (a.metrics.replies ?? 0),
      0,
    );
export const eventSources = (e: Event) =>
  [
    ...new Set(
      (e.articles || []).flatMap(
        (a) => a.metadata?.discoverySources || [a.source],
      ),
    ),
  ] as Source[];
export function filterFeed(
  events: Event[],
  f: FeedFilters,
  monitors: Monitor[],
  settings: Settings,
  now = Date.now(),
) {
  const list = events.filter((e) => {
    const time =
      f.timeField === "publication" ? publicationTime(e) : firstDiscovered(e);
    const m = monitors.find((m) => m.id === e.monitorId);
    if (
      !m ||
      e.relevance < m.minRelevance ||
      (e.details?.value ?? 100) < settings.minValue
    )
      return false;
    if (f.hours !== "all" && (!time || time < now - Number(f.hours) * 3600000))
      return false;
    if (f.monitorIds.length && !f.monitorIds.includes(e.monitorId))
      return false;
    if (f.sources.length && !eventSources(e).some((s) => f.sources.includes(s)))
      return false;
    if (f.credibility !== "all" && e.credibility !== f.credibility)
      return false;
    if (
      f.importance !== "all" &&
      (e.details?.importance ?? "unassessed") !== f.importance
    )
      return false;
    if (
      e.relevance < f.minRelevance ||
      !`${e.title} ${e.summary}`
        .toLowerCase()
        .includes(f.query.trim().toLowerCase())
    )
      return false;
    const x = (e.articles || []).filter(
      (a) => a.source === "x" && a.metadata?.contentKind !== "web",
    );
    if (
      f.accountScope === "curated" &&
      !x.some((a) => curatedAccount(a.author, m, settings.xAccounts))
    )
      return false;
    if (
      f.accountScope === "official" &&
      !x.some((a) =>
        settings.publishers.some((p) =>
          p.xAccounts.some((h) => h.toLowerCase() === a.author.toLowerCase()),
        ),
      )
    )
      return false;
    if (f.engagement !== "all") {
      const t =
        f.engagement === "strict"
          ? [50, 10, 15]
          : f.engagement === "standard"
            ? [10, 3, 5]
            : [f.minLikes, f.minReposts, f.minReplies];
      if (
        !x.some(
          (a) =>
            (a.metrics.likes ?? 0) >= t[0] ||
            (a.metrics.reposts ?? 0) >= t[1] ||
            (a.metrics.replies ?? 0) >= t[2],
        )
      )
        return false;
    }
    return true;
  });
  const descendingDate = (a: number | null, b: number | null) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
  return list.sort((a, b) => {
    const importance = importanceRank(b) - importanceRank(a),
      relevance = b.relevance - a.relevance;
    return (
      (f.sort === "heat"
        ? socialHeat(b) - socialHeat(a)
        : f.sort === "relevance"
          ? relevance
          : f.sort === "publication"
            ? descendingDate(publicationTime(a), publicationTime(b))
            : f.sort === "discovery"
              ? firstDiscovered(b) - firstDiscovered(a)
              : f.sort === "importance"
                ? importance
                : importance || relevance) ||
      firstDiscovered(b) - firstDiscovered(a) ||
      a.id.localeCompare(b.id)
    );
  });
}
