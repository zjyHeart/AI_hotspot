import { getDb } from "./db";
import { getSettings, readSetting, writeSetting } from "./config";
import { ServiceError } from "./http";

const dayKey = (now = Date.now()) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function xUsage(now = Date.now()) {
  return {
    day: readSetting<number>("x-requests-day:" + dayKey(now), 0),
    month: readSetting<number>(
      "x-requests-month:" + dayKey(now).slice(0, 7),
      0,
    ),
    categories: readSetting<Record<string, number>>(
      "x-request-categories:" + dayKey(now),
      {},
    ),
  };
}
export class XBudgetError extends ServiceError {
  constructor() {
    super("达到 X 每日或每月请求上限，采集进度保留，等待预算恢复", 429);
  }
}
// Reserve before networking, in an immediate transaction across worker processes.
// Failures count too. Every X API entry point reserves before its request.
export function reserveX(category: string) {
  getDb().transaction(
    () => {
      const s = getSettings(),
        u = xUsage(),
        day = dayKey();
      if (u.day >= s.xDailyRequestLimit || u.month >= s.xMonthlyRequestLimit)
        throw new XBudgetError();
      writeSetting("x-requests-day:" + day, u.day + 1);
      writeSetting("x-requests-month:" + day.slice(0, 7), u.month + 1);
      writeSetting("x-request-categories:" + day, {
        ...u.categories,
        [category]: (u.categories[category] || 0) + 1,
      });
    },
    { behavior: "immediate" },
  );
}
