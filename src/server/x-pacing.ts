import { setTimeout as delay } from "node:timers/promises";
import { getDb } from "./db";
import { readSetting, writeSetting } from "./config";
import { ServiceError, type Fetcher } from "./http";

// Conservative request spacing, configurable for the user's provider plan.
// This is a local policy, not a claim about the account's provider quota.
export function claimXSlot(now = Date.now()) {
  return getDb().transaction(
    () => {
      const interval = Math.max(
        1200,
        Math.min(15000, Number(process.env.X_REQUEST_INTERVAL_MS) || 6000),
      );
      const next = Math.max(now, readSetting<number>("x-next-request-at", 0));
      if (next - now > 15000)
        throw new ServiceError("X 请求排队较多，请稍后重试", 429);
      writeSetting("x-next-request-at", next + interval);
      return next - now;
    },
    { behavior: "immediate" },
  );
}
export async function paceX(fetcher: Fetcher = fetch) {
  // Mock fetchers belong to isolated regression tests; live requests share the DB gate.
  if (fetcher !== fetch) return;
  const wait = claimXSlot();
  if (wait) await delay(wait);
}
