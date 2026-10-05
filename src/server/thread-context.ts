import { z } from "zod";
import { getDb } from "./db";
import { getSettings, readSetting, writeSetting } from "./config";
import { requestJson, safeError, type Fetcher } from "./http";
import { tweetSchema, hash } from "./sources";
import type { Article } from "../shared/types";
import { reserveX } from "./x-budget";
import { paceX } from "./x-pacing";

const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export const contextUsage = () =>
  readSetting<number>("x-context-day:" + day(), 0);
type Cache = { at: number; articles: Article[]; error?: string };
export async function threadContext(input: Article[], fetcher: Fetcher) {
  const collected: Article[] = [],
    gaps: string[] = [];
  let layer = input;
  for (let depth = 0; depth < 2; depth++) {
    const ids = [
      ...new Set(
        layer
          .filter((a) => a.source === "x")
          .map((a) => a.metadata?.replyToId)
          .filter((x): x is string => !!x && /^\d{1,30}$/.test(x)),
      ),
    ].slice(0, 3);
    if (!ids.length) break;
    const key = "x-context-cache:" + hash(ids.sort().join(","));
    const cache = readSetting<Cache | null>(key, null);
    if (cache && Date.now() - cache.at < (cache.error ? 15 : 240) * 60000) {
      collected.push(...cache.articles);
      if (cache.error) gaps.push(cache.error);
      layer = cache.articles;
      continue;
    }
    const allowed = getDb().transaction(
      () => {
        if (
          !process.env.TWITTERAPI_API_KEY ||
          contextUsage() >= getSettings().xContextDailyLimit
        )
          return false;
        try {
          reserveX("context");
        } catch {
          return false;
        }
        writeSetting("x-context-day:" + day(), contextUsage() + 1);
        return true;
      },
      { behavior: "immediate" },
    );
    if (!allowed) {
      gaps.push("回复根帖未获取：X 上下文查询未配置或达到每日上限");
      break;
    }
    try {
      await paceX(fetcher);
      const url = new URL("https://api.twitterapi.io/twitter/tweets");
      url.searchParams.set("tweet_ids", ids.join(","));
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
        throw new Error("X 根帖查询未成功");
      const items: Article[] = raw.tweets
        .filter((t) => ids.includes(t.id))
        .map((t) => ({
          id: hash("x:" + t.id),
          source: "x",
          externalId: t.id,
          title: t.text.slice(0, 120),
          text: t.text.slice(0, 30000),
          url: `https://x.com/${t.author.userName}/status/${t.id}`,
          author: t.author.userName,
          publishedAt: Number.isFinite(Date.parse(t.createdAt))
            ? Date.parse(t.createdAt)
            : 0,
          collectedAt: Date.now(),
          metrics: {
            likes: t.likeCount ?? undefined,
            reposts: t.retweetCount ?? undefined,
          },
          originKey: "x:" + t.author.userName.toLowerCase(),
          isRepost: !!t.retweeted_tweet,
          metadata: {
            contentKind: "post",
            contentStatus: "native",
            isReply: t.isReply ?? undefined,
            replyToId: t.inReplyToId || undefined,
          },
        }));
      const error =
        items.length < ids.length ? "部分回复根帖缺失或不可访问" : undefined;
      writeSetting(key, { at: Date.now(), articles: items, error });
      collected.push(...items);
      if (error) gaps.push(error);
      layer = items;
    } catch (error) {
      const message = "回复根帖读取失败：" + safeError(error);
      writeSetting(key, { at: Date.now(), articles: [], error: message });
      gaps.push(message);
      break;
    }
  }
  if (layer.some((a) => a.metadata?.replyToId))
    gaps.push("只追溯了有限层父帖，未保证读取完整线程");
  return { articles: collected, gaps: [...new Set(gaps)] };
}
