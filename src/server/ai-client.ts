import { z } from "zod";
import { getSettings } from "./config";
import { ServiceError, requestJson, type Fetcher } from "./http";
import { reserveAI, finishAI } from "./ai-budget";
import { safeError } from "./http";

export function openRouterEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const allowed = ["openrouter.ai"];
  if (
    url.protocol !== "https:" ||
    !allowed.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new ServiceError("请使用官方 OpenRouter HTTPS 地址", 400);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/api/v1")
    throw new ServiceError("OpenRouter 地址应填写 https://openrouter.ai/api/v1", 400);
  return `${url.origin}/api/v1/chat/completions`;
}
export async function aiCompletion(
  messages: { role: string; content: string }[],
  schema: unknown,
  maxTokens: number,
  fetcher: Fetcher = fetch,
  context?: { stage: string; jobId: string },
) {
  if (!process.env.OPENROUTER_API_KEY)
    throw new ServiceError(
      "OpenRouter 未配置；已采集内容保留，请填写 OPENROUTER_API_KEY",
      503,
    );
  const settings = getSettings();
  if (!settings.model)
    throw new ServiceError(
      "请在连接设置中填写 OpenRouter 模型页面中的完整模型 ID（vendor/model）",
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
  // OpenRouter's unified reasoning field; model-default mode omits it.
  // Concrete models that mandate reasoning can reject enabled=false.
  if (
    settings.thinkingMode === "disabled" &&
    context &&
    ["screen", "deep"].includes(context.stage)
  )
    body.reasoning = { enabled: false };
  if (settings.outputMode === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "signal_output", strict: true, schema },
    };
  else if (settings.outputMode === "json_object")
    body.response_format = { type: "json_object" };
  const endpoint = openRouterEndpoint(settings.baseUrl);
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
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
      throw new ServiceError("OpenRouter 返回无效的 Chat Completions 响应");
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
