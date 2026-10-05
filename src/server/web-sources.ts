import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { z } from "zod";
import { getDb } from "./db";
import { readSetting, writeSetting, getSettings } from "./config";
import {
  requestJson,
  requestText,
  validLink,
  safeError,
  ServiceError,
  type Fetcher,
} from "./http";
import { normalizeUrl, fingerprint, qualityRank, policyFor } from "./quality";
import type { Article, Monitor, Source } from "../shared/types";
import type { Collection } from "./sources";

const dayKey = (now: number) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const monthKey = (now: number) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 7);
export function searchUsage(now = Date.now()) {
  return {
    day: readSetting<number>("search-day:" + dayKey(now), 0),
    month: readSetting<number>("search-month:" + monthKey(now), 0),
    verification: readSetting<number>("verify-day:" + dayKey(now), 0),
  };
}
export function reserveSearch(verification = false, now = Date.now()): boolean {
  return getDb().transaction(
    () => {
      const s = getSettings(),
        u = searchUsage(now);
      if (
        u.day >= s.searchDailyLimit ||
        u.month >= s.searchMonthlyLimit ||
        (verification && u.verification >= s.verificationDailyLimit)
      )
        return false;
      writeSetting("search-day:" + dayKey(now), u.day + 1);
      writeSetting("search-month:" + monthKey(now), u.month + 1);
      if (verification)
        writeSetting("verify-day:" + dayKey(now), u.verification + 1);
      return true;
    },
    { behavior: "immediate" },
  );
}
const resultSchema = z
  .object({
    title: z.string(),
    link: z.string(),
    snippet: z.string().optional(),
    date: z.string().optional(),
  })
  .passthrough();
const searchSchema = z
  .object({
    organic_results: z.array(resultSchema).optional(),
    error: z.string().optional(),
    search_metadata: z.object({ status: z.string() }).passthrough(),
  })
  .passthrough();
type SearchCache = { at: number; articles: Article[]; error?: string; nextOffset?: number };
export function searchQuery(m: Monitor) {
  return [
    m.keywords,
    ...m.aliases
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 2),
  ]
    .map((x) => '"' + x.replace(/["\\\r\n]/g, " ").trim() + '"')
    .join(" OR ");
}
export async function collectWeb(
  m: Monitor,
  source: "google" | "bing",
  fetcher: Fetcher = fetch,
  verificationQuery?: string,
  page?: { query: string; offset: number },
): Promise<Collection> {
  const report = { source, count: 0, requests: 0 };
  if (!process.env.SERPAPI_API_KEY)
    return {
      articles: [],
      report: {
        ...report,
        status: "unconfigured",
        message: "请配置 SERPAPI_API_KEY，Google/Bing 使用同一个 Key",
      },
    };
  const now = Date.now();
  const query = verificationQuery || page?.query || searchQuery(m);
  const key = "search-cache:" + fingerprint(source + ":" + query + (page?.offset ? ":" + page.offset : ""));
  const cache = readSetting<SearchCache | null>(key, null);
  if (cache && now - cache.at < (cache.error ? 15 : 60) * 60000)
    return {
      articles: cache.articles,
      nextOffset: cache.nextOffset,
      report: {
        ...report,
        count: cache.articles.length,
        status: cache.error ? "error" : "ok",
        message: cache.error
          ? "失败退避：" + cache.error
          : "复用一小时检索缓存",
      },
    };
  if (!reserveSearch(Boolean(verificationQuery), now))
    return {
      articles: [],
      report: {
        ...report,
        status: "budget",
        message: "达到每日/月度搜索或事件核验预算，其他来源继续运行",
      },
    };
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({
      engine: source,
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      ...(source === "google" ? { tbs: "qdr:w" } : {}),
      ...(page?.offset ? source === "google" ? { start: String(page.offset) } : { first: String(page.offset) } : {}),
    }).toString();
    const response = searchSchema.parse(await requestJson(u.href, {}, fetcher));
    if (response.error || response.search_metadata.status !== "Success")
      throw new ServiceError(
        "搜索引擎未返回成功结果：" +
          (response.error || response.search_metadata.status),
      );
    // Missing organic_results without explicit no-results state is not silently accepted.
    if (
      !response.organic_results &&
      !(() => {
        const info = (response as Record<string, unknown>)
          .search_information as Record<string, unknown> | undefined;
        return (
          info?.organic_results_state === "Fully empty" ||
          info?.total_results === 0
        );
      })()
    )
      throw new ServiceError("搜索响应缺少自然搜索结果");
    const items = new Map<string, Article>();
    for (const r of (response.organic_results || []).slice(0, 50)) {
      const link = validLink(r.link);
      if (!link) continue;
      const url = normalizeUrl(link);
      // Search snippets often have ambiguous dates: full-page metadata must confirm them.
      items.set(url, {
        id: fingerprint("web:" + url),
        source,
        externalId: url,
        title: r.title,
        text: r.title + "\n" + (r.snippet || ""),
        url,
        author: new URL(url).hostname,
        publishedAt: 0,
        collectedAt: now,
        metrics: {},
        originKey: new URL(url).hostname,
        isRepost: false,
        metadata: {
          contentKind: "web",
          contentStatus: "snippet",
          discoverySources: [source],
          publishedVerified: false,
          query,
        },
      });
    }
    const list = [...items.values()];
    let nextOffset: number | undefined;
    const pagination = (response as Record<string, unknown>).serpapi_pagination as { next?: string } | undefined;
    if (pagination?.next) {
      try {
        const next = new URL(pagination.next);
        const offset = Number(next.searchParams.get(source === "google" ? "start" : "first"));
        if (next.hostname === "serpapi.com" && Number.isSafeInteger(offset) && offset > (page?.offset || 0) && offset < 1000) nextOffset = offset;
      } catch { /* Invalid pagination is not followed. */ }
    }
    writeSetting(key, { at: now, articles: list, nextOffset });
    return {
      articles: list,
      nextOffset,
      report: {
        ...report,
        requests: 1,
        count: list.length,
        status: "ok",
        message:
          "网页候选已采集；摘要不等于正文，搜索时间筛选不作为发布日期证明",
      },
    };
  } catch (error) {
    const message = safeError(error);
    writeSetting(key, { at: now, articles: [], error: message });
    return {
      articles: [],
      report: { ...report, requests: 1, status: "error", message },
    };
  }
}
export function discoveryQueries(m: Monitor) {
  const base = [m.keywords, ...m.aliases.split(/[,，\n]/).map(x => x.trim()).filter(Boolean)].slice(0,6);
  return [...new Set([...base, ...base.slice(0,2).flatMap(term => [term + " release announcement", term + " research benchmark"])])];
}
export async function collectWebDiscovery(m: Monitor, source: "google" | "bing", fetcher: Fetcher = fetch): Promise<Collection> {
  const queries = discoveryQueries(m), key = "discovery-progress:"+m.id+":"+source;
  const signature = fingerprint(JSON.stringify(queries));
  const stored = readSetting<{ signature: string; index: number; offset: number } | null>(key,null);
  let index = stored?.signature === signature ? stored.index % queries.length : 0;
  let offset = stored?.signature === signature ? stored.offset : 0;
  const list: Article[] = [], messages: string[] = [];
  let requests=0, status: Collection["report"]["status"]="ok";
  for(let page=0;page<getSettings().webPages;page++) {
    const out=await collectWeb(m,source,fetcher,undefined,{query:queries[index],offset});
    list.push(...out.articles); requests+=out.report.requests;
    messages.push(`查询「${queries[index]}」偏移 ${offset}：${out.report.message}`);
    if(out.report.status!=="ok") { status=list.length?"partial":out.report.status;break; }
    if(out.nextOffset !== undefined) offset=out.nextOffset;
    else { index=(index+1)%queries.length;offset=0; }
    writeSetting(key,{signature,index,offset});
  }
  return {articles:[...new Map(list.map(a=>[a.id,a])).values()],report:{source,status,requests,count:new Set(list.map(a=>a.id)).size,rawCount:list.length,message:messages.join("；")}};
}
type BodyCache = { at: number; result: Partial<Article>; error?: string };
export function extractBody(
  html: string,
  url: string,
  now = Date.now(),
): Partial<Article> {
  // JSDOM's default disables scripts and resource fetching. Keep those defaults.
  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;
    if (doc.querySelectorAll("*").length > 30000)
      throw new ServiceError("正文 DOM 超过解析规模限制");
    const canonical = doc
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href");
    const a = new Readability(doc, {
      maxElemsToParse: 30000,
      charThreshold: 150,
    }).parse();
    if (!a?.textContent || a.textContent.trim().length < 150)
      throw new ServiceError("没有可用正文（可能需要登录或动态加载）");
    const original = a.textContent.replace(/\s+/g, " ").trim();
    const text = original.slice(0, 30000);
    const date = a.publishedTime ? Date.parse(a.publishedTime) : NaN;
    const validDate = Number.isFinite(date) && date > 0 && date <= now + 60000;
    let originalUrl = normalizeUrl(url);
    if (canonical) {
      const candidate = validLink(new URL(canonical, url).href);
      if (candidate) {
        const target = new URL(normalizeUrl(candidate)),
          current = new URL(normalizeUrl(url));
        // A canonical with a different path/version has not been fetched: do not merge it blindly.
        if (
          target.hostname === current.hostname &&
          target.pathname.replace(/\/$/, "") ===
            current.pathname.replace(/\/$/, "") &&
          target.search === current.search
        )
          originalUrl = target.href;
      }
    }
    return {
      title: a.title || "",
      text,
      author: a.byline || new URL(url).hostname,
      publishedAt: validDate ? date : 0,
      metadata: {
        contentKind: "web",
        contentStatus: "full",
        originalUrl,
        contentHash: fingerprint(text.toLowerCase()),
        fetchedAt: now,
        publishedVerified: validDate,
        originalLength: original.length,
        truncated: original.length > text.length,
      },
    };
  } finally {
    dom.window.close();
  }
}
export async function fetchBody(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<BodyCache> {
  const normalized = normalizeUrl(url),
    key = "body-cache:" + fingerprint(normalized),
    now = Date.now();
  const old = readSetting<BodyCache | null>(key, null);
  if (old && now - old.at < (old.error ? 30 : 240) * 60000) return old;
  try {
    let finalUrl = normalized;
    const html = await requestText(
      normalized,
      { headers: { Accept: "text/html", "User-Agent": "Signal-Desk/0.1" } },
      fetcher,
      true,
      (url, contentType) => {
        finalUrl = url;
        if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType))
          throw new ServiceError("来源不是可解析的 HTML 正文");
      },
    );
    const result = extractBody(html, finalUrl, now);
    result.url = result.metadata!.originalUrl;
    result.originKey = new URL(result.url!).hostname;
    const value = { at: now, result };
    writeSetting(key, value);
    return value;
  } catch (error) {
    const value = { at: now, result: {}, error: safeError(error) };
    writeSetting(key, value);
    return value;
  }
}
// Enrichment returns linked originals separately so a discussion is never mistaken for its source.
export async function enrichArticles(
  items: Article[],
  m: Monitor,
  fetcher: Fetcher = fetch,
  budget = { remaining: getSettings().bodyFetchLimit },
): Promise<Article[]> {
  const out = new Map(items.map((a) => [a.id, a]));
  const settings = getSettings();
  const candidates = items
    .flatMap((a) => {
      if (
        ["google", "bing", "rss"].includes(a.source) &&
        a.metadata?.contentStatus !== "full"
      )
        return [{ parent: a, url: a.url, direct: true }];
      if (["x", "hn"].includes(a.source))
        return (a.metadata?.linkedUrls || [])
          .slice(0, 1)
          .filter((u) => {
            try {
              return !/(^|\.)(x\.com|twitter\.com|news\.ycombinator\.com)$/.test(
                new URL(u).hostname,
              );
            } catch {
              return false;
            }
          })
          .map((url) => ({ parent: a, url, direct: false }));
      return [];
    })
    .sort(
      (a, b) =>
        qualityRank(b.parent, settings.publishers) -
        qualityRank(a.parent, settings.publishers),
    );
  const unique = [
    ...new Map(candidates.map((x) => [normalizeUrl(x.url), x])).values(),
  ].slice(0, budget.remaining);
  budget.remaining -= unique.length;
  for (let i = 0; i < unique.length; i += 2)
    await Promise.all(
      unique.slice(i, i + 2).map(async (c) => {
        const body = await fetchBody(c.url, fetcher);
        const url = body.result.url || normalizeUrl(c.url);
        if (c.direct) {
          const metadata = {
            ...c.parent.metadata,
            ...body.result.metadata,
            ...(body.error
              ? { contentStatus: "failed" as const, fetchError: body.error }
              : {}),
          };
          out.set(c.parent.id, {
            ...c.parent,
            ...body.result,
            publishedAt:
              body.result.publishedAt ||
              (new URL(body.result.url || c.parent.url).hostname ===
              new URL(c.parent.url).hostname
                ? c.parent.publishedAt
                : 0),
            metadata: {
              ...metadata,
              publishedVerified:
                metadata.publishedVerified ||
                c.parent.metadata?.publishedVerified,
            },
          });
        } else if (!body.error) {
          const original: Article = {
            ...c.parent,
            ...body.result,
            id: fingerprint("web:" + url),
            source: c.parent.source,
            externalId: url,
            url,
            originKey: new URL(url).hostname,
            isRepost: false,
            metrics: {},
            metadata: {
              ...body.result.metadata,
              discoverySources: [c.parent.source],
            },
          };
          out.set(original.id, original);
          out.set(c.parent.id, {
            ...c.parent,
            metadata: { ...c.parent.metadata, originalUrl: url },
          });
        } else
          out.set(c.parent.id, {
            ...c.parent,
            metadata: { ...c.parent.metadata, fetchError: body.error },
          });
      }),
    );
  return [...out.values()];
}
export const webDue = (m: Monitor, source: Source, now = Date.now()) =>
  now - readSetting<number>(`web-at:${m.id}:${source}`, 0) >=
  policyFor(m).webIntervalMinutes * 60000;
