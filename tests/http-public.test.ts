import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  request: vi.fn(),
}));
import { request as upstream } from "undici";
import { requestText, proxyFor } from "../src/server/http";
const request = vi.mocked(upstream);
const response = (
  statusCode: number,
  headers: Record<string, string> = {},
  content = "text",
) => ({ statusCode, headers, body: Readable.from([Buffer.from(content)]) });
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
  ])
    vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());
it("真实传输分支使用 Undici request，读取 UTF-8 并固定最终来源地址", async () => {
  request.mockResolvedValue(
    response(200, { "content-type": "text/html" }, "原文 UTF-8") as never,
  );
  const seen = vi.fn();
  expect(
    await requestText("https://example.com/article", {}, fetch, true, seen),
  ).toBe("原文 UTF-8");
  expect(request).toHaveBeenCalledOnce();
  expect(seen).toHaveBeenCalledWith("https://example.com/article", "text/html");
});
it("丢弃重定向响应触发中止事件时不崩溃，仍跟随合法公开链接", async () => {
  const discarded = new Readable({
    read() {},
    destroy(_error, callback) {
      callback(new Error("Request aborted"));
    },
  });
  request
    .mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: "/actual" },
      body: discarded,
    } as never)
    .mockResolvedValueOnce(response(200, {}, "original") as never);
  expect(
    await requestText("https://example.com/redirect", {}, fetch, true),
  ).toBe("original");
  await new Promise((resolve) => setImmediate(resolve));
  expect(request).toHaveBeenCalledTimes(2);
});
it("错误响应和超过大小限制的响应体被关闭并明确报错", async () => {
  request.mockResolvedValueOnce(response(403) as never);
  await expect(
    requestText("https://example.com/blocked", {}, fetch, true),
  ).rejects.toThrow("403");
  request.mockResolvedValueOnce(
    response(200, { "content-length": "2000001" }) as never,
  );
  await expect(
    requestText("https://example.com/large", {}, fetch, true),
  ).rejects.toThrow("2MB");
});
it("代理 CONNECT 固定公开 IP，同时保留原域名 Host 与证书校验", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1234");
  request.mockResolvedValue(response(200, {}, "body") as never);
  await requestText(
    "https://example.com/original",
    { headers: { Authorization: "secret", Cookie: "private" } },
    fetch,
    true,
  );
  const [url, options] = request.mock.calls[0];
  expect(new URL(String(url)).hostname).not.toBe("example.com");
  expect(options?.headers).toMatchObject({ host: "example.com" });
  expect(options?.headers).not.toHaveProperty("authorization");
  expect(options?.headers).not.toHaveProperty("cookie");
  vi.stubEnv("NO_PROXY", ".example.com");
  expect(proxyFor(new URL("https://sub.example.com/"))).toBeUndefined();
});
