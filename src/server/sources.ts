import {
  policyFor,
  qualityDecision,
  qualityTags,
  POLICY_VERSION,
} from "./quality";
import { getSettings } from "./config";
import { monitoredHandles } from "../shared/x-accounts";
import { reserveX, XBudgetError } from "./x-budget";
import { paceX } from "./x-pacing";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type {
  Article,
  Monitor,
  Source,
  Metrics,
  SourceReport,
} from "../shared/types";
import {
  requestJson,
  requestText,
  cleanText,
  validLink,
  type Fetcher,
  ServiceError,
  safeError,
} from "./http";

export const DEFAULT_FEEDS = [
  "https://huggingface.co/blog/feed.xml",
  "https://blog.google/innovation-and-ai/technology/ai/rss/",
  "https://github.blog/feed/",
  "https://deepmind.google/blog/rss.xml",
];
export function hash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
function timestamp(input: string | number) {
  const n = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(n)) throw new ServiceError("来源包含无效发布时间");
  return n;
}
function article(
  source: Source,
  externalId: string,
  data: Omit<Article, "id" | "source" | "externalId" | "collectedAt">,
): Article {
  return {
    ...data,
    id: hash(`${source}:${externalId}`),
    source,
    externalId,
    collectedAt: Date.now(),
    metadata: {
      contentStatus: source === "rss" ? "snippet" : "native",
      contentKind:
        source === "hn"
          ? "discussion"
          : source === "github"
            ? "repository"
            : source === "rss"
              ? "web"
              : "post",
      ...data.metadata,
    },
    text: data.text.slice(0, 10000),
    title: data.title.slice(0, 300),
  };
}
export function terms(m: Pick<Monitor, "keywords" | "aliases">) {
  return [m.keywords, ...m.aliases.split(/[,，\n]/)]
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
}
export function twitterQuery(
  m: Pick<Monitor, "keywords" | "aliases" | "excludes"> &
    Partial<Pick<Monitor, "quality">>,
  from: number,
  to: number,
  accounts?: string[],
) {
  const quote = (x: string) => `"${x.replace(/["\\\r\n]/g, " ").trim()}"`;
  return `${accounts?.length ? "(" + accounts.map((x) => "from:" + x).join(" OR ") + ")" : "(" + terms(m).map(quote).join(" OR ") + ")"} ${m.excludes
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((x) => "-" + quote(x))
    .join(
      " ",
    )} -filter:nativeretweets since_time:${Math.floor(from / 1000)} until_time:${Math.floor(to / 1000)}`;
}
export const tweetSchema = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    text: z.string(),
    createdAt: z.string(),
    author: z
      .object({
        userName: z.string(),
        isBlueVerified: z.boolean().nullish(),
        verifiedType: z.string().nullish(),
        followers: z.number().nullish(),
      })
      .passthrough(),
    likeCount: z.number().nullish(),
    replyCount: z.number().nullish(),
    retweetCount: z.number().nullish(),
    quoteCount: z.number().nullish(),
    viewCount: z.number().nullish(),
    isReply: z.boolean().nullish(),
    inReplyToId: z.string().nullish(),
    entities: z
      .object({
        urls: z
          .array(
            z
              .object({
                expanded_url: z.string().optional(),
                url: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .nullish(),
    retweeted_tweet: z.unknown().optional(),
    quoted_tweet: z.unknown().optional(),
  })
  .passthrough();
const twitterPage = z.object({
  tweets: z.array(tweetSchema),
  has_next_page: z.boolean(),
  next_cursor: z.string(),
});
export interface TwitterState {
  from: number;
  to: number;
  cursor: string;
  completedAt?: number;
  fingerprint?: string;
}
export interface Collection {
  nextOffset?: number;
  articles: Article[];
  report: SourceReport;
  state?: TwitterState;
}
export class CollectionError extends ServiceError {
  constructor(
    public report: SourceReport,
    public articles: Article[] = [],
  ) {
    super(report.message);
  }
}
export async function collectTwitter(
  m: Monitor,
  state: TwitterState,
  maxPages: number,
  fetcher: Fetcher = fetch,
  onPage?: (items: Article[], state: TwitterState) => void,
  lane: "accounts" | "keywords" = "keywords",
): Promise<Collection> {
  if (!process.env.TWITTERAPI_API_KEY)
    return {
      articles: [],
      report: {
        source: "x",
        status: "unconfigured",
        count: 0,
        requests: 0,
        message: "请配置 TWITTERAPI_API_KEY",
      },
    };
  let cursor = state.cursor;
  const seen = new Set<string>();
  const items = new Map<string, Article>();
  let requests = 0;
  const settings = getSettings(),
    publishers = settings.publishers;
  const handles = monitoredHandles(m, settings.xAccounts);
  if (lane === "accounts" && !handles.length)
    return {
      articles: [],
      report: {
        source: "x",
        status: "skipped",
        count: 0,
        requests: 0,
        message: "没有启用精选或自定义账号",
      },
    };
  const reportCounts = () => {
    const all = [...items.values()];
    const reasons: Record<string, number> = {};
    for (const a of all)
      if (a.metadata?.filterReason)
        reasons[a.metadata.filterReason] =
          (reasons[a.metadata.filterReason] || 0) + 1;
    return {
      count: all.filter((a) => !a.metadata?.filterReason).length,
      rawCount: all.length,
      filteredCount: all.filter((a) => a.metadata?.filterReason).length,
      filterReasons: reasons,
    };
  };
  try {
    for (let page = 0; page < maxPages; page++) {
      if (seen.has(cursor))
        throw new ServiceError("X 返回重复分页游标，采集已停止");
      seen.add(cursor);
      const url = new URL(
        "https://api.twitterapi.io/twitter/tweet/advanced_search",
      );
      url.search = new URLSearchParams({
        query: twitterQuery(
          m,
          state.from,
          state.to,
          lane === "accounts" ? handles : undefined,
        ),
        queryType: "Latest",
        cursor,
      }).toString();
      reserveX(lane);
      requests++;
      await paceX(fetcher);
      const payload = await requestJson(
        url.href,
        { headers: { "X-API-Key": process.env.TWITTERAPI_API_KEY } },
        fetcher,
      );
      const parsed = twitterPage.safeParse(payload);
      if (!parsed.success)
        throw new ServiceError("X 搜索响应不符合当前 API 格式");
      for (const t of parsed.data.tweets) {
        // Defense in depth: don't attribute unexpected authors to account monitoring.
        if (
          lane === "accounts" &&
          !handles.includes(t.author.userName.toLowerCase())
        )
          continue;
        const url = validLink(
          t.url || `https://x.com/${t.author.userName}/status/${t.id}`,
        );
        if (!url) continue;
        const publishedAt = timestamp(t.createdAt);
        if (publishedAt < state.from || publishedAt > state.to) continue;
        const metrics: Metrics = {};
        for (const [a, b] of Object.entries({
          likes: t.likeCount,
          replies: t.replyCount,
          reposts: t.retweetCount,
          quotes: t.quoteCount,
          views: t.viewCount,
        }))
          if (typeof b === "number" && b >= 0) metrics[a as keyof Metrics] = b;
        const repost =
          t.retweeted_tweet !== undefined && t.retweeted_tweet !== null;
        const metadata = {
          isReply: typeof t.isReply === "boolean" ? t.isReply : undefined,
          replyToId: t.inReplyToId || undefined,
          linkedUrls: [
            ...new Set(
              [
                ...(t.entities?.urls || []).map((u) =>
                  validLink(u.expanded_url || u.url || ""),
                ),
                ...(t.text.match(/https?:\/\/[^\s<>"']+/g) || []).map((u) =>
                  validLink(u.replace(/[),.!]+$/, "")),
                ),
              ].filter((u): u is string => Boolean(u)),
            ),
          ].slice(0, 8),
          policyVersion: POLICY_VERSION,
          publishedVerified: true,
          xDiscovery: [lane],
          isBlueVerified: t.author.isBlueVerified ?? undefined,
          verifiedType: t.author.verifiedType ?? undefined,
          followers: t.author.followers ?? undefined,
          engagementCheckedAt: Date.now(),
        };
        const a = article("x", t.id, {
          title: t.text.slice(0, 120),
          text: t.text,
          url,
          author: t.author.userName,
          publishedAt,
          metrics,
          originKey: `x:${t.author.userName.toLowerCase()}`,
          isRepost: repost,
          metadata,
        });
        a.metadata = {
          ...a.metadata,
          filterReason: qualityDecision(a, m, publishers, settings.xAccounts),
          qualityTags: qualityTags(a, m, settings.xAccounts),
        };
        items.set(t.id, a);
      }
      if (
        parsed.data.has_next_page &&
        (!parsed.data.next_cursor || seen.has(parsed.data.next_cursor))
      ) {
        // Retain this page but leave the checkpoint at the last valid cursor.
        onPage?.([...items.values()], { ...state, cursor });
        throw new ServiceError("X 分页游标为空或重复");
      }
      onPage?.(
        [...items.values()],
        parsed.data.has_next_page
          ? { ...state, cursor: parsed.data.next_cursor }
          : {
              from: state.to - 120000,
              to: state.to,
              cursor: "",
              completedAt: state.to,
              fingerprint: state.fingerprint,
            },
      );
      if (!parsed.data.has_next_page)
        return {
          articles: [...items.values()],
          report: {
            source: "x",
            status: "ok",
            ...reportCounts(),
            requests,
            message: "时间窗口采集完成；已执行本地类型和质量过滤",
          },
          state: {
            from: state.to - 120000,
            to: state.to,
            cursor: "",
            completedAt: state.to,
            fingerprint: state.fingerprint,
          },
        };
      cursor = parsed.data.next_cursor;
    }
  } catch (error) {
    if (error instanceof XBudgetError)
      return {
        articles: [...items.values()],
        report: {
          source: "x",
          status: "budget",
          ...reportCounts(),
          requests,
          message: error.message,
        },
        state: { ...state, cursor },
      };
    throw new CollectionError(
      {
        source: "x",
        status: "error",
        ...reportCounts(),
        requests,
        message: safeError(error),
      },
      [...items.values()],
    );
  }
  return {
    articles: [...items.values()],
    report: {
      source: "x",
      status: "partial",
      ...reportCounts(),
      requests,
      message: `达到本轮 ${maxPages} 页上限，下轮继续当前窗口`,
    },
    state: { ...state, cursor },
  };
}
const hnPage = z.object({
  hits: z.array(
    z.object({
      objectID: z.string(),
      title: z.string().nullish(),
      url: z.string().nullish(),
      story_text: z.string().nullish(),
      author: z.string(),
      created_at_i: z.number(),
      points: z.number().nullish(),
      num_comments: z.number().nullish(),
    }),
  ),
  nbPages: z.number(),
});
export async function collectHn(
  m: Monitor,
  from: number,
  to: number,
  maxPages: number,
  fetcher: Fetcher = fetch,
): Promise<Collection> {
  const items = new Map<string, Article>();
  let requests = 0;
  let truncated = false;
  try {
    for (const term of terms(m).slice(0, 3)) {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
        url.search = new URLSearchParams({
          query: term,
          tags: "story",
          numericFilters: `created_at_i>=${Math.floor(from / 1000)},created_at_i<=${Math.floor(to / 1000)}`,
          hitsPerPage: "30",
          page: String(page),
        }).toString();
        requests++;
        const p = hnPage.parse(await requestJson(url.href, {}, fetcher));
        for (const t of p.hits) {
          const url = `https://news.ycombinator.com/item?id=${t.objectID}`;
          items.set(
            t.objectID,
            article("hn", t.objectID, {
              title: t.title || "HN discussion",
              text: cleanText(
                `${t.title || ""} ${t.story_text || ""} ${validLink(t.url || "") || ""}`,
              ),
              url,
              author: t.author,
              publishedAt: t.created_at_i * 1000,
              metrics: {
                ...(t.points != null ? { points: t.points } : {}),
                ...(t.num_comments != null ? { replies: t.num_comments } : {}),
              },
              originKey: validLink(t.url || "")
                ? new URL(t.url!).hostname
                : `hn:${t.author}`,
              isRepost: true,
              metadata: {
                contentKind: "discussion",
                contentStatus: "native",
                linkedUrls: validLink(t.url || "") ? [t.url!] : [],
              },
            }),
          );
        }
        if (page + 1 >= p.nbPages) break;
        if (page + 1 === maxPages) truncated = true;
      }
    }
  } catch (error) {
    throw new CollectionError(
      {
        source: "hn",
        status: "error",
        count: items.size,
        requests,
        message: safeError(error),
      },
      [...items.values()],
    );
  }
  return {
    articles: [...items.values()],
    report: {
      source: "hn",
      status: truncated ? "partial" : "ok",
      count: items.size,
      requests,
      message: truncated
        ? "命中数量超过单轮预算，结果为有限样本"
        : "公开搜索采集完成",
    },
  };
}
const ghPage = z.object({
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      id: z.number(),
      full_name: z.string(),
      html_url: z.string(),
      description: z.string().nullish(),
      updated_at: z.string(),
      created_at: z.string(),
      stargazers_count: z.number(),
      owner: z.object({ login: z.string() }),
    }),
  ),
});
export async function collectGithub(
  m: Monitor,
  from: number,
  to: number,
  fetcher: Fetcher = fetch,
): Promise<Collection> {
  if (policyFor(m).githubRepos.length)
    return collectGithubReleases(m, from, to, fetcher);
  const items = new Map<string, Article>();
  let incomplete = false;
  let requests = 0;
  try {
    for (const term of terms(m).slice(0, 2)) {
      const url = new URL("https://api.github.com/search/repositories");
      url.search = new URLSearchParams({
        q: `${term.replace(/[\r\n]/g, " ")} in:name,description,readme pushed:>=${new Date(from).toISOString().slice(0, 10)}`,
        sort: "updated",
        order: "desc",
        per_page: "30",
      }).toString();
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Signal-Desk",
      };
      if (process.env.GITHUB_TOKEN)
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      requests++;
      const p = ghPage.parse(await requestJson(url.href, { headers }, fetcher));
      incomplete ||= p.incomplete_results;
      for (const t of p.items) {
        const url = validLink(t.html_url);
        if (!url) continue;
        const publishedAt = timestamp(t.updated_at);
        if (publishedAt > to) continue;
        items.set(
          String(t.id),
          article("github", String(t.id), {
            title: t.full_name,
            text: `${t.full_name}: ${t.description || "无仓库描述"}。仓库更新记录，不代表正式版本发布。`,
            url,
            author: t.owner.login,
            publishedAt,
            metrics: { stars: t.stargazers_count },
            originKey: `github:${t.owner.login.toLowerCase()}`,
            isRepost: false,
          }),
        );
      }
    }
  } catch (error) {
    throw new CollectionError(
      {
        source: "github",
        status: "error",
        count: items.size,
        requests,
        message: safeError(error),
      },
      [...items.values()],
    );
  }
  return {
    articles: [...items.values()],
    report: {
      source: "github",
      status: "partial",
      count: items.size,
      requests,
      message: incomplete
        ? "GitHub 报告不完整搜索结果"
        : "按近期更新检索仓库，最多 30 条/关键词；不代表发布榜或增长榜",
    },
  };
}
const asArray = (x: unknown): Record<string, unknown>[] =>
  Array.isArray(x)
    ? (x.filter((y) => typeof y === "object" && y !== null) as Record<
        string,
        unknown
      >[])
    : x && typeof x === "object"
      ? [x as Record<string, unknown>]
      : [];
const string = (x: unknown): string =>
  typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
export async function collectRss(
  m: Monitor,
  from: number,
  to: number,
  fetcher: Fetcher = fetch,
): Promise<Collection> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  });
  const items = new Map<string, Article>();
  let requests = 0;
  const failures: string[] = [];
  const urls = m.rssUrls.length ? m.rssUrls : DEFAULT_FEEDS;
  for (const feed of urls) {
    try {
      requests++;
      const xml = await requestText(feed, {}, fetcher, true);
      const doc = parser.parse(xml);
      const entries = asArray(doc?.rss?.channel?.item || doc?.feed?.entry);
      if (!doc?.rss && !doc?.feed) throw new ServiceError("不是有效 RSS/Atom");
      for (const e of entries) {
        const link =
          typeof e.link === "string"
            ? e.link
            : asArray(e.link).find(
                (x) => x["@_rel"] === "alternate" || !x["@_rel"],
              )?.["@_href"];
        const url = validLink(string(link));
        if (!url) continue;
        const date = string(e.pubDate || e.published || e.updated);
        if (!date) continue;
        const publishedAt = timestamp(date);
        if (publishedAt < from || publishedAt > to) continue;
        const title = cleanText(string(e.title));
        const body = cleanText(
          string(
            e.description || e.summary || e["content:encoded"] || e.content,
          ),
        );
        // RSS is collected within the time window, then AI determines semantic relevance.
        items.set(
          url,
          article("rss", url, {
            title,
            text: `${title}\n${body}`,
            url,
            author:
              string(e["dc:creator"] || e.author) || new URL(feed).hostname,
            publishedAt,
            metrics: {},
            originKey: new URL(feed).hostname,
            isRepost: false,
            metadata: { publishedVerified: true },
          }),
        );
      }
    } catch (error) {
      failures.push(`${new URL(feed).hostname}: ${safeError(error)}`);
    }
  }
  return {
    articles: [...items.values()],
    report: {
      source: "rss",
      status:
        failures.length === urls.length
          ? "error"
          : failures.length
            ? "partial"
            : "ok",
      count: items.size,
      requests,
      message: failures.length
        ? `${failures.length}/${urls.length} 个订阅源读取失败；${failures.join("；")}`
        : "订阅源采集完成",
    },
  };
}

const releasesSchema = z.array(
  z.object({
    id: z.number(),
    html_url: z.string(),
    name: z.string().nullish(),
    tag_name: z.string(),
    body: z.string().nullish(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullish(),
  }),
);
export async function collectGithubReleases(
  m: Monitor,
  from: number,
  to: number,
  fetcher: Fetcher = fetch,
): Promise<Collection> {
  const items: Article[] = [];
  let requests = 0;
  const errors: string[] = [];
  for (const repo of policyFor(m).githubRepos) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Signal-Desk",
      };
      if (process.env.GITHUB_TOKEN)
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      requests++;
      const releases = releasesSchema.parse(
        await requestJson(
          `https://api.github.com/repos/${repo}/releases?per_page=10`,
          { headers },
          fetcher,
        ),
      );
      for (const r of releases) {
        if (r.draft || !r.published_at) continue;
        const at = timestamp(r.published_at);
        const url = validLink(r.html_url);
        if (!url || at < from || at > to) continue;
        items.push(
          article("github", "release:" + r.id, {
            title: `${repo} ${r.name || r.tag_name}${r.prerelease ? "（预发布）" : ""}`,
            text: `${repo} 发布 ${r.tag_name}${r.prerelease ? "（预发布）" : ""}。\n${r.body || "发布记录没有正文"}`,
            url,
            author: repo.split("/")[0],
            publishedAt: at,
            metrics: {},
            originKey: "github:" + repo.split("/")[0].toLowerCase(),
            isRepost: false,
            metadata: {
              contentKind: "release",
              contentStatus: "native",
              publishedVerified: true,
            },
          }),
        );
      }
    } catch (e) {
      errors.push(repo + ": " + safeError(e));
    }
  }
  return {
    articles: items,
    report: {
      source: "github",
      status:
        errors.length === policyFor(m).githubRepos.length
          ? "error"
          : errors.length
            ? "partial"
            : "ok",
      count: items.length,
      requests,
      message: errors.length
        ? errors.join("；")
        : "已读取关注仓库正式 Release（每仓库最多 10 条，包含明确标注的预发布）",
    },
  };
}
