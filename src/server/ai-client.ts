import { z } from "zod";
import { getSettings } from "./config";
import { ServiceError, requestJson, type Fetcher } from "./http";
import { reserveAI, finishAI } from "./ai-budget";
import { safeError } from "./http";

export function packyEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const allowed = ["cf.api.fan", "www.packyapi.ai", "www.packyapi.com"];
  if (
    url.protocol !== "https:" ||
    !allowed.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new ServiceError("请使用官方 PackyAPI HTTPS 地址", 400);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/v1")
    throw new ServiceError("PackyAPI 地址应填写域名或域名/v1", 400);
  return `${url.origin}/v1/chat/completions`;
}
export async function aiCompletion(
  messages: { role: string; content: string }[],
  schema: unknown,
  maxTokens: number,
  fetcher: Fetcher = fetch,
  context?: { stage: string; jobId: string },
) {
  if (!process.env.PACKY_API_KEY)
    throw new ServiceError(
      "PackyAPI 未配置；已采集内容保留，请填写 PACKY_API_KEY",
      503,
    );
  const settings = getSettings();
  if (!settings.model)
    throw new ServiceError(
      "请在连接设置中填写 PackyAPI 令牌分组可用的模型 ID",
      400,
    );
  const system = [
    ...messages.filter((m) => m.role === "system").map((m) => m.content),
    `输出必须是有效 JSON，遵循以下结构：${JSON.stringify(schema)}`,
  ].join("\n");
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [
      { role: "system", content: system },
      ...messages.filter((m) => m.role !== "system"),
    ],
    max_tokens: maxTokens,
    stream: false,
  };
  // This parameter is verified with Packy's deepseek-v4-pro only. Other models
  // and connection/baseline checks retain their configured protocol.
  if (
    settings.model === "deepseek-v4-pro" &&
    settings.thinkingMode === "disabled" &&
    context &&
    ["screen", "deep"].includes(context.stage)
  )
    body.thinking = { type: "disabled" };
  if (settings.outputMode === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "signal_output", strict: true, schema },
    };
  else if (settings.outputMode === "json_object")
    body.response_format = { type: "json_object" };
  const endpoint = packyEndpoint(settings.baseUrl);
  const reservation = context
    ? reserveAI(
        context.stage,
        context.jobId,
        Buffer.byteLength(JSON.stringify(body), "utf-8") + maxTokens,
      )
    : null;
  let usage: number | null = null;
  try {
    const raw = await requestJson(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PACKY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      fetcher,
    );
    const response = z
      .object({
        choices: z
          .array(
            z.object({
              message: z.object({ content: z.string() }),
              finish_reason: z.string().nullish(),
            }),
          )
          .min(1),
        usage: z.object({ total_tokens: z.number() }).optional(),
      })
      .safeParse(raw);
    if (!response.success)
      throw new ServiceError("PackyAPI 返回无效的 Chat Completions 响应");
    usage = response.data.usage?.total_tokens ?? null;
    if (response.data.choices[0].finish_reason === "length")
      throw new ServiceError("AI 输出被截断，请减小分析批次后重试");
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.data.choices[0].message.content);
    } catch {
      throw new ServiceError(
        "AI 返回无效 JSON，未生成智能事件；可核对模型与输出模式",
      );
    }
    if (reservation) finishAI(reservation, usage);
    return { parsed, tokens: usage || 0 };
  } catch (error) {
    if (reservation) finishAI(reservation, usage, safeError(error));
    throw error;
  }
}
