import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { articles, candidates } from "./schema";
import { getSettings } from "./config";
import { observationUntil } from "./quality";
import { reserveX, XBudgetError } from "./x-budget";
import { paceX } from "./x-pacing";
import { requestJson, safeError, type Fetcher } from "./http";
import { tweetSchema } from "./sources";
import { persistArticles } from "./article-store";
import type { Monitor } from "../shared/types";

export async function refreshObservations(
  m: Monitor,
  fetcher: Fetcher,
  allowance: number,
) {
  const now = Date.now(),
    s = getSettings();
  const due = getDb()
    .select({ a: articles })
    .from(candidates)
    .innerJoin(articles, eq(articles.id, candidates.articleId))
    .where(
      and(eq(candidates.monitorId, m.id), eq(candidates.state, "observing")),
    )
    .all()
    .map((r) => r.a)
    .filter((a) => {
      const deadline = observationUntil(a, m, s.publishers, s.xAccounts, now);
      return (
        deadline !== null &&
        deadline <= now &&
        now - (a.metadata?.engagementRefreshAttemptAt ?? 0) >= 30 * 60000
      );
    })
    .slice(0, 20);
  if (!due.length) return { requests: 0, message: "", status: "ok" as const };
  if (!allowance)
    return {
      requests: 0,
      message: `${due.length} 条新帖待复查，本轮请求额度已用完`,
      status: "partial" as const,
    };
  let requests = 0;
  try {
    reserveX("observation");
    requests++;
    await paceX(fetcher);
    const url = new URL("https://api.twitterapi.io/twitter/tweets");
    url.searchParams.set("tweet_ids", due.map((a) => a.externalId).join(","));
    const raw = z
      .object({ tweets: z.array(tweetSchema), status: z.string().optional() })
      .parse(
        await requestJson(
          url.href,
          { headers: { "X-API-Key": process.env.TWITTERAPI_API_KEY! } },
          fetcher,
        ),
      );
    if (raw.status && raw.status !== "success")
      throw new Error("互动复查返回失败状态");
    persistArticles(
      m,
      due.map((a) => {
        const t = raw.tweets.find(
          (t) =>
            t.id === a.externalId &&
            t.author.userName.toLowerCase() === a.author.toLowerCase(),
        );
        return {
          ...a,
          metrics: t
            ? {
                ...a.metrics,
                likes: t.likeCount ?? a.metrics.likes,
                replies: t.replyCount ?? a.metrics.replies,
                reposts: t.retweetCount ?? a.metrics.reposts,
              }
            : a.metrics,
          metadata: {
            ...a.metadata,
            engagementRefreshAttemptAt: now,
            engagementCheckedAt: t ? now : a.metadata?.engagementCheckedAt,
            engagementRefreshError: t
              ? undefined
              : "帖子不可访问或返回缺失，保留等待复查",
          },
        };
      }),
    );
    return {
      requests,
      message: `互动复查 ${due.length} 条；未返回的帖子保留等待复查`,
      status:
        raw.tweets.length < due.length ? ("partial" as const) : ("ok" as const),
    };
  } catch (error) {
    if (!(error instanceof XBudgetError))
      persistArticles(
        m,
        due.map((a) => ({
          ...a,
          metadata: {
            ...a.metadata,
            engagementRefreshAttemptAt: now,
            engagementRefreshError: safeError(error),
          },
        })),
      );
    return {
      requests,
      message: "互动复查暂缓：" + safeError(error),
      status:
        error instanceof XBudgetError
          ? ("budget" as const)
          : ("partial" as const),
    };
  }
}
