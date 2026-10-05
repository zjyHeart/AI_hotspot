import { createHash } from "node:crypto";
import {
  qualityInput,
  type Article,
  type Monitor,
  type Publisher,
  type Source,
  type XAccount,
} from "../shared/types";
import { curatedAccount } from "../shared/x-accounts";

export const POLICY_VERSION = "source-quality-v3";
export const fingerprint = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);
export const policyFor = (m: Pick<Monitor, "quality">) =>
  qualityInput.parse({
    ...m.quality,
    engagementMode: m.quality?.engagementMode ?? "loose",
  });
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid", "msclkid"].includes(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, "");
const matches = (host: string, domains: string[]) =>
  domains.some(
    (d) =>
      hostKey(host) === hostKey(d) || hostKey(host).endsWith("." + hostKey(d)),
  );
export function publisherFor(
  a: Article,
  publishers: Publisher[],
): Publisher | undefined {
  if (a.source === "x" && a.metadata?.contentKind !== "web")
    return publishers.find((p) =>
      p.xAccounts.some((x) => x.toLowerCase() === a.author.toLowerCase()),
    );
  if (a.source === "github" && a.metadata?.contentKind !== "web")
    return publishers.find((p) =>
      p.githubOwners.some((x) => x.toLowerCase() === a.author.toLowerCase()),
    );
  let host: string;
  try {
    host = new URL(a.url).hostname;
  } catch {
    return;
  }
  // A feed cannot impersonate a publisher by inserting another publisher's URL.
  if (a.source === "rss" && hostKey(a.originKey) !== hostKey(host)) return;
  return publishers.find((p) => matches(host, p.domains));
}
// Only deterministic exclusions happen before AI; soft signals remain visible.
export function engagementThresholds(m: Pick<Monitor, "quality">) {
  const q = policyFor(m);
  return q.engagementMode === "strict"
    ? { likes: 50, reposts: 10, replies: 15 }
    : q.engagementMode === "standard"
      ? { likes: 10, reposts: 3, replies: 5 }
      : { likes: q.minLikes, reposts: q.minReposts, replies: q.minReplies };
}
export function passesEngagement(a: Article, m: Monitor) {
  if (policyFor(m).engagementMode === "loose") return true;
  const t = engagementThresholds(m);
  return (
    (a.metrics.likes ?? 0) >= t.likes ||
    (a.metrics.reposts ?? 0) >= t.reposts ||
    (a.metrics.replies ?? 0) >= t.replies
  );
}
export function substantiveReply(a: Article) {
  const text = a.text.replace(/https?:\/\/\S+|@\w+/g, "").trim();
  return (
    text.length >= 80 ||
    /```|\b(error|exception|stack trace|repro|bug|fix|commit|benchmark|version|workflow update)\b|复现|报错|错误日志|代码|修复|版本|测试结果/i.test(
      text,
    ) ||
    (text.length >= 25 && !!a.metadata?.linkedUrls?.length)
  );
}
export function engagementExempt(
  a: Article,
  m: Monitor,
  publishers: Publisher[],
  accounts: XAccount[],
) {
  return !!publisherFor(a, publishers) || curatedAccount(a.author, m, accounts);
}
export function observationUntil(
  a: Article,
  m: Monitor,
  publishers: Publisher[],
  accounts: XAccount[] = [],
  now = Date.now(),
) {
  if (
    a.source !== "x" ||
    passesEngagement(a, m) ||
    engagementExempt(a, m, publishers, accounts)
  )
    return null;
  const minutes = policyFor(m).observationMinutes;
  if (!minutes || !a.publishedAt) return null;
  const deadline = a.publishedAt + minutes * 60000;
  // A post collected before the deadline must be refreshed before final filtering.
  if (
    deadline > now ||
    (a.collectedAt < deadline &&
      (a.metadata?.engagementCheckedAt ?? 0) < deadline)
  )
    return deadline;
  return null;
}
export function qualityDecision(
  a: Article,
  m: Monitor,
  publishers: Publisher[],
  accounts: XAccount[] = [],
  now = Date.now(),
): string | undefined {
  if (!a.text.trim()) return "空内容";
  if (
    a.source === "x" &&
    policyFor(m).blockedAccounts.some(
      (x) => x.toLowerCase() === a.author.toLowerCase(),
    )
  )
    return "屏蔽账号";
  if (a.isRepost) return "纯转发";
  if (a.source === "x") {
    if (
      policyFor(m).excludeReplies &&
      a.metadata?.isReply &&
      !substantiveReply(a)
    )
      return "无实质内容的回复";
    if (
      !passesEngagement(a, m) &&
      !engagementExempt(a, m, publishers, accounts) &&
      observationUntil(a, m, publishers, accounts, now) === null
    )
      return "普通账号互动不足";
  }
}
export function qualityTags(
  a: Article,
  m: Monitor,
  accounts: XAccount[] = [],
): string[] {
  const tags: string[] = [];
  const q = policyFor(m);
  if (a.metadata?.isReply || a.metadata?.replyToId)
    tags.push("回复，需结合根帖");
  if (a.source === "x" && a.metadata?.isReply === undefined)
    tags.push("帖子类型未知");
  if (
    /\b(airdrop|giveaway|whitelist|presale)\b|空投|加群领|抽奖送/i.test(a.text)
  )
    tags.push("疑似推广");
  if (a.text.replace(/https?:\/\/\S+|@\w+/g, "").trim().length < 25)
    tags.push("短文本");
  if (a.source === "x" && !passesEngagement(a, m)) tags.push("低互动");
  if (a.source === "x" && curatedAccount(a.author, m, accounts))
    tags.push("精选账号（仍需核验）");
  if (a.metadata?.isBlueVerified) tags.push("蓝 V（不代表专业或真实）");
  if (!a.publishedAt) tags.push("日期未知");
  return tags;
}
export function qualityRank(
  a: Article,
  publishers: Publisher[],
  selection?: { monitor: Monitor; accounts: XAccount[] },
) {
  return (
    (publisherFor(a, publishers) ? 60 : 0) +
    (selection &&
    a.source === "x" &&
    curatedAccount(a.author, selection.monitor, selection.accounts)
      ? 35
      : 0) +
    (a.metadata?.isReply ? -8 : 0) +
    (a.metadata?.contentStatus === "full" ? 20 : 0) +
    Math.min(
      15,
      Math.log2(1 + (a.metrics.likes || 0) + (a.metrics.reposts || 0) * 3),
    ) +
    (a.metadata?.contentKind === "release" ? 10 : 0)
  );
}
// Round-robin is persisted by the scanner; waiting age prevents priority starvation.
export function fairCandidates(
  items: Article[],
  limit: number,
  offset: number,
  publishers: Publisher[],
  now = Date.now(),
  selection?: { monitor: Monitor; accounts: XAccount[] },
): Article[] {
  const groups = new Map<Source, Article[]>();
  for (const a of items) {
    const list = groups.get(a.source) || [];
    list.push(a);
    groups.set(a.source, list);
  }
  for (const list of groups.values())
    list.sort(
      (a, b) =>
        qualityRank(b, publishers, selection) +
          (now - b.collectedAt) / 3600000 -
          (qualityRank(a, publishers, selection) +
            (now - a.collectedAt) / 3600000) || a.id.localeCompare(b.id),
    );
  const sources = [...groups.keys()].sort();
  if (!sources.length) return [];
  const order = sources
    .slice(offset % sources.length)
    .concat(sources.slice(0, offset % sources.length));
  const out: Article[] = [];
  const xCap =
    groups.size > 1 && limit >= 3
      ? Math.max(1, Math.floor(limit * 0.4))
      : limit;
  let xCount = 0;
  while (out.length < limit) {
    let found = false;
    for (const source of order) {
      if (out.length >= limit) break;
      if (
        source === "x" &&
        xCount >= xCap &&
        [...groups.entries()].some(([s, l]) => s !== "x" && l.length)
      )
        continue;
      const a = groups.get(source)?.shift();
      if (a) {
        out.push(a);
        if (source === "x") xCount++;
        found = true;
      }
    }
    if (!found) break;
  }
  return out;
}
export function evidenceGroup(a: Article, publishers: Publisher[]): string {
  const p = publisherFor(a, publishers);
  return p
    ? "publisher:" + p.id
    : a.metadata?.originalUrl
      ? "original:" + normalizeUrl(a.metadata.originalUrl)
      : a.metadata?.contentHash
        ? "content:" + a.metadata.contentHash
        : a.originKey;
}

// Conservatively group almost verbatim syndicated text; this is not semantic fact checking.
export function sameContent(a: Article, b: Article): boolean {
  if (
    a.metadata?.contentHash &&
    a.metadata.contentHash === b.metadata?.contentHash
  )
    return true;
  if (
    a.metadata?.contentStatus !== "full" ||
    b.metadata?.contentStatus !== "full"
  )
    return false;
  const normalized = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const x = normalized(a.text),
    y = normalized(b.text);
  if (
    Math.min(x.length, y.length) < 500 ||
    Math.min(x.length, y.length) / Math.max(x.length, y.length) < 0.7
  )
    return false;
  const shingles = (s: string) =>
    new Set(
      Array.from({ length: Math.max(0, s.length - 31) }, (_, i) =>
        s.slice(i, i + 32),
      ),
    );
  const xs = shingles(x),
    ys = shingles(y);
  let shared = 0;
  for (const part of xs) if (ys.has(part)) shared++;
  return shared / Math.min(xs.size, ys.size) >= 0.9;
}
