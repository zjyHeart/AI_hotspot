import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { aiCalls } from "./schema";
import { getSettings } from "./config";
import { ServiceError } from "./http";

const dayKey = (now = Date.now()) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function aiUsage(now = Date.now()) {
  const rows = getDb()
    .select()
    .from(aiCalls)
    .where(eq(aiCalls.day, dayKey(now)))
    .all();
  return {
    calls: rows.length,
    tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0),
    unknown: rows.filter((r) => r.tokens === null && r.state !== "reserved")
      .length,
    reserved: rows.reduce(
      (n, r) => n + (r.tokens === null ? r.reservedTokens : 0),
      0,
    ),
  };
}
export class AIBudgetError extends ServiceError {
  constructor() {
    super("达到今日 AI 调用或 token 预算，材料保留，等待预算恢复", 429);
  }
}
export function reserveAI(
  stage: string,
  jobId: string,
  reservedTokens: number,
) {
  return getDb().transaction(
    () => {
      const s = getSettings(),
        u = aiUsage();
      // Reserve 20% for deep analysis; even failed attempts consume the call quota.
      const fraction = stage === "screen" ? 0.8 : 1;
      if (
        u.calls >= Math.floor(s.aiDailyCallLimit * fraction) ||
        u.tokens + u.reserved + reservedTokens >
          Math.floor(s.aiDailyTokenLimit * fraction)
      )
        throw new AIBudgetError();
      const id = randomUUID();
      getDb()
        .insert(aiCalls)
        .values({
          id,
          jobId,
          stage,
          day: dayKey(),
          model: s.model,
          state: "reserved",
          reservedTokens,
          tokens: null,
          createdAt: Date.now(),
        })
        .run();
      return id;
    },
    { behavior: "immediate" },
  );
}
export function finishAI(id: string, tokens: number | null, error?: string) {
  getDb()
    .update(aiCalls)
    .set({
      tokens,
      state: error ? "failed" : "success",
      error: error || null,
      finishedAt: Date.now(),
    })
    .where(eq(aiCalls.id, id))
    .run();
}
