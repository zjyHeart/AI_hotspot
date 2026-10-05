import { lookup } from "node:dns/promises";
import { Agent, ProxyAgent, request as undiciRequest } from "undici";
import { isIP } from "node:net";

export class ServiceError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryable = false,
  ) {
    super(message);
  }
}
export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  let sanitized = message.slice(0, 400);
  for (const key of [
    "SERPAPI_API_KEY",
    "OPENROUTER_API_KEY",
    "TWITTERAPI_API_KEY",
    "GITHUB_TOKEN",
    "SMTP_PASSWORD",
    "SMTP_USER",
    "EMAIL_TO",
    "EMAIL_FROM",
  ]) {
    const value = process.env[key];
    if (value) sanitized = sanitized.split(value).join("[已隐藏]");
  }
  sanitized = sanitized.replace(/([?&]api_key=)[^&\s]+/gi, "$1[已隐藏]");
  return sanitized.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]");
}
export function isPublicAddress(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    (isIP(value) === 6 && value.startsWith("2")) ||
    (isIP(value) === 6 && value.startsWith("3"))
  );
}
export async function validatePublicUrl(input: string) {
  const url = new URL(input);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ServiceError("仅支持不含凭证的公开 HTTP(S) 来源", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw new ServiceError("来源不能使用本机或内网地址", 400);
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
    throw new ServiceError("来源解析到了内网地址", 400);
  return url;
}
// The connection resolves again and rejects private addresses, preventing a DNS rebinding gap.
const publicDispatcher = new Agent({
  connect: {
    lookup(host, options, callback) {
      lookup(host, { all: true })
        .then((addresses) => {
          if (
            !addresses.length ||
            addresses.some((a) => !isPublicAddress(a.address))
          )
            return callback(new Error("来源解析到了内网地址"), [], 0);
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        })
        .catch((error) => callback(error, [], 0));
    },
  },
});
// Respect the user's trusted proxy while pinning the publicly validated target IP.
// CONNECT uses that IP; Host and TLS SNI retain the original publisher domain.
export function proxyFor(url: URL): string | undefined {
  const rules = (process.env.no_proxy || process.env.NO_PROXY || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rule of rules) {
    if (rule === "*") return;
    const [host, rulePort] = rule.toLowerCase().split(":");
    const suffix = host.replace(/^\*?\./, "");
    if (
      (!rulePort || rulePort === port) &&
      (url.hostname === suffix ||
        ((host.startsWith(".") || host.startsWith("*.")) &&
          url.hostname.endsWith("." + suffix)))
    )
      return;
  }
  return url.protocol === "https:"
    ? process.env.https_proxy ||
        process.env.HTTPS_PROXY ||
        process.env.http_proxy ||
        process.env.HTTP_PROXY
    : process.env.http_proxy || process.env.HTTP_PROXY;
}
async function publicResponse(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const url = new URL(input);
  const proxy = proxyFor(url);
  const headers = new Headers(init.headers);
  for (const name of ["authorization", "cookie", "proxy-authorization"])
    headers.delete(name);
  let dispatcher: Agent | ProxyAgent = publicDispatcher;
  let owned: ProxyAgent | undefined;
  if (proxy) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      throw new ServiceError("来源解析到了内网地址", 400);
    const ip =
      addresses.find((a) => isIP(a.address) === 4)?.address ||
      addresses[0].address;
    headers.set("host", url.host);
    owned = new ProxyAgent({
      uri: proxy,
      proxyTunnel: true,
      requestTls: { servername: hostname },
    });
    dispatcher = owned;
    url.hostname = isIP(ip) === 6 ? "[" + ip + "]" : ip;
  }
  try {
    const result = await undiciRequest(url, {
      dispatcher,
      method: "GET",
      headers: Object.fromEntries(headers),
      signal: init.signal || AbortSignal.timeout(15000),
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    // Explicitly discarded redirect/error bodies may emit UND_ERR_ABORTED.
    // The request status is handled below; stream errors remain observable by for-await.
    result.body.on("error", () => {});
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers))
      if (value !== undefined)
        responseHeaders.set(
          key,
          Array.isArray(value) ? value.join(", ") : value,
        );
    if (result.statusCode >= 300) {
      result.body.destroy();
      return new Response(null, {
        status: result.statusCode,
        headers: responseHeaders,
      });
    }
    if (Number(responseHeaders.get("content-length") || 0) > 2_000_000) {
      result.body.destroy();
      throw new ServiceError("来源响应超过 2MB 上限");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > 2_000_000) {
        result.body.destroy();
        throw new ServiceError("来源响应超过 2MB 上限");
      }
      chunks.push(Buffer.from(chunk));
    }
    return new Response(Buffer.concat(chunks), {
      status: result.statusCode,
      headers: responseHeaders,
    });
  } finally {
    if (owned) await owned.close();
  }
}
export type Fetcher = typeof fetch;
export async function requestText(
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
  allowCustom = false,
  onResponse?: (url: string, contentType: string) => void,
): Promise<string> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (allowCustom) await validatePublicUrl(current);
    let res: Response;
    try {
      // The installed dispatcher and fetch must use the same Undici version.
      const run = allowCustom && fetcher === fetch ? publicResponse : fetcher;
      res = await run(current, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(init.method === "POST" ? 90000 : 15000),
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const cause = error instanceof Error ? error.cause : undefined;
      const detail = cause || error;
      const code =
        typeof detail === "object" && detail !== null && "code" in detail
          ? String(detail.code)
          : "";
      const suffix = /^[A-Z0-9_]{1,50}$/.test(code) ? `（${code}）` : "";
      throw new ServiceError(`服务连接失败或请求超时${suffix}`, 502, true);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!allowCustom) throw new ServiceError("API 返回了意外的重定向");
      const location = res.headers.get("location");
      if (!location) throw new ServiceError("来源重定向缺少地址");
      await res.body?.cancel();
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok)
      throw new ServiceError(
        `上游服务 HTTP ${res.status}${res.status === 401 ? "：认证失败，请检查 API Key" : res.status === 429 ? "：请求限流，请稍后重试" : res.status === 402 ? "：额度不足" : ""}`,
        502,
        res.status === 429 || res.status >= 500,
      );
    if (Number(res.headers.get("content-length") || 0) > 2_000_000)
      throw new ServiceError("来源响应超过 2MB 上限");
    onResponse?.(current, res.headers.get("content-type") || "");
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new ServiceError("来源响应超过 2MB 上限");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  throw new ServiceError("来源重定向过多");
}
export async function requestJson(
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const text = await requestText(url, init, fetcher);
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError("上游服务返回了无效 JSON");
  }
}
export function cleanText(input: string) {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
export function validLink(input: string): string | null {
  try {
    const u = new URL(input);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
