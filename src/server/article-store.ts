import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { articles, articleMonitors, metricSnapshots } from "./schema";
import { getSettings } from "./config";
import {
  policyFor,
  qualityDecision,
  qualityTags,
  normalizeUrl,
  POLICY_VERSION,
  fingerprint as qualityFingerprint,
} from "./quality";
import { hash } from "./sources";
import type { Article, Monitor, Event } from "../shared/types";
export function persistArticles(m: Monitor, list: Article[]) {
  const db = getDb();
  const settings = getSettings(),
    publishers = settings.publishers;
  const policyVersion =
    POLICY_VERSION +
    ":" +
    qualityFingerprint(
      JSON.stringify([policyFor(m), publishers, settings.xAccounts]),
    );
  db.transaction(
    (tx) => {
      for (const input of list) {
        const a = { ...input, metadata: { ...input.metadata } };
        const canonical = a.metadata?.originalUrl || a.url;
        if (
          a.text.trim().length >= 80 &&
          a.metadata.contentStatus !== "snippet" &&
          a.metadata.contentStatus !== "failed"
        )
          a.metadata.contentHash = qualityFingerprint(
            a.text.replace(/\s+/g, " ").trim(),
          );
        const duplicate = !a.isRepost
          ? tx
              .select()
              .from(articles)
              .where(
                or(
                  eq(articles.url, normalizeUrl(canonical)),
                  a.metadata.contentHash
                    ? sql`json_extract(${articles.metadata}, '$.contentHash') = ${a.metadata.contentHash}`
                    : sql`0`,
                ),
              )
              .get()
          : undefined;
        const old =
          duplicate ||
          tx.select().from(articles).where(eq(articles.id, a.id)).get();
        if (old) {
          a.id = old.id;
          if (duplicate && (old.url !== a.url || old.author !== a.author)) {
            a.url = old.url;
            a.originKey = old.originKey;
            a.author = old.author;
            a.metadata.originalUrl = old.metadata.originalUrl;
          }
          a.source = old.source;
          a.isRepost = old.isRepost;
          a.collectedAt = old.collectedAt;
          // Syndication or metric refresh cannot make an old event newly published.
          if (old.publishedAt) a.publishedAt = old.publishedAt;
          a.metadata = {
            ...old.metadata,
            ...a.metadata,
            xDiscovery: [
              ...new Set([
                ...(old.metadata.xDiscovery || []),
                ...(a.metadata.xDiscovery || []),
              ]),
            ],
            discoverySources: [
              ...new Set([
                ...(old.metadata.discoverySources || [old.source]),
                ...(a.metadata?.discoverySources || [input.source]),
              ]),
            ],
            discoveryUrls: [
              ...new Set([
                ...(old.metadata.discoveryUrls || [old.url]),
                input.url,
              ]),
            ],
            discoveryAuthors: [
              ...new Set([
                ...(old.metadata.discoveryAuthors || [old.author]),
                input.author,
              ]),
            ],
          };
          if (
            old.metadata.contentStatus === "full" &&
            a.metadata.contentStatus !== "full"
          ) {
            a.url = old.url;
            a.originKey = old.originKey;
            a.author = old.author;
            a.text = old.text;
            a.title = old.title;
            a.publishedAt = old.publishedAt;
            a.metadata = {
              ...a.metadata,
              ...old.metadata,
              discoverySources: a.metadata?.discoverySources,
              discoveryUrls: a.metadata?.discoveryUrls,
              discoveryAuthors: a.metadata?.discoveryAuthors,
            };
          }
        }
        const reason = qualityDecision(a, m, publishers, settings.xAccounts);
        a.metadata.qualityTags = qualityTags(a, m, settings.xAccounts);
        a.metadata.filterReason = undefined;
        tx.insert(articles)
          .values(a)
          .onConflictDoUpdate({
            target: articles.id,
            set: {
              metrics: a.metrics,
              url: a.url,
              originKey: a.originKey,
              title: a.title,
              text: a.text,
              publishedAt: a.publishedAt,
              metadata: a.metadata,
            },
          })
          .run();
        const id = hash(`${m.id}:${a.id}`);
        tx.insert(articleMonitors)
          .values({
            id,
            monitorId: m.id,
            articleId: a.id,
            analyzedAt: reason ? Date.now() : null,
            filterReason: reason || null,
            policyVersion,
          })
          .onConflictDoUpdate({
            target: articleMonitors.id,
            set: {
              filterReason: reason || null,
              policyVersion,
              analyzedAt: reason
                ? Date.now()
                : sql`case when ${articleMonitors.filterReason} is not null then null when ${old && old.text !== a.text ? 1 : 0} = 1 then null else ${articleMonitors.analyzedAt} end`,
            },
          })
          .run();
        tx.insert(metricSnapshots)
          .values({
            id: hash(`${a.id}:${Date.now()}`),
            articleId: a.id,
            sampledAt: Date.now(),
            metrics: a.metrics,
          })
          .onConflictDoNothing()
          .run();
      }
    },
    { behavior: "immediate" },
  );
}
export function canNotify(
  m: Monitor,
  event: Pick<Event, "relevance" | "credibility" | "notifiedAt">,
  list: Article[],
  now = Date.now(),
) {
  return (
    event.relevance >= m.minRelevance &&
    event.credibility !== "disputed" &&
    (event.credibility !== "unverified" || m.notifyUnverified) &&
    list.some(
      (a) =>
        a.publishedAt >= m.createdAt &&
        (event.notifiedAt === null || a.publishedAt > event.notifiedAt),
    ) &&
    (event.notifiedAt === null ||
      now - event.notifiedAt >= m.cooldownMinutes * 60000)
  );
}
