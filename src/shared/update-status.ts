import type { Dashboard } from "./types";

export function updateStatus(data: Dashboard, now = Date.now()) {
  const a = data.pipeline.activity;
  const scans = data.monitors.filter((m) => m.lastStatus === "running" && m.leaseUntil > now);
  const waitingScans = data.monitors.filter((m) => m.scanRequested).length;
  const working = scans.length + a.screen + a.deep;
  const channels = a.monitorNames.join("、");
  const result = (title: string, description: string, tone: "active" | "warning" | "idle", stage: number | null) =>
    ({ title, description, tone, stage, working });
  if (!data.health.worker)
    return result("后台已停止", "已有情报可以阅读；新内容采集和 AI 分析需启动后台。", "warning", null);
  if (a.deep)
    return result("AI 正在深度核验", `${channels} · 正在核验来源、判断重要性，完成后自动出现在下方。`, "active", 1);
  if (a.screen)
    return result("AI 正在筛选内容", `${channels} · 正在排除无关与重复内容，再核验值得关注的事件。`, "active", 1);
  if (scans.length)
    return result("正在采集新内容", `${scans.map((m) => m.name).join("、")} · 采集完成后进入 AI 分析。`, "active", 0);
  if (waitingScans || a.queued)
    return result("更新已排队", "后台将依次采集和分析，结果自动显示，无需反复刷新。", "active", null);
  if (a.budget)
    return result("分析因预算暂停", `${a.budget} 个任务等待额度恢复；已完成的情报仍可阅读。`, "warning", null);
  if (a.retry)
    return result("分析等待重试", "部分请求暂时失败，后台会按计划重试，已有结果保留。", "warning", null);
  if (a.failed)
    return result("部分分析需要处理", "查看更新记录中的失败原因，再决定是否重试。", "warning", null);
  if (a.paused || (!data.settings.analysisEnabled && data.pendingCount))
    return result("后台在线 · 分析已暂停", "已有材料保留。可在更新记录中分析已有材料，或点击更新情报采集并分析。", "warning", null);
  const active = data.monitors.filter((m) => m.active);
  if (!active.length)
    return result("后台在线 · 频道已暂停", "可阅读已有情报；启用频道可定时更新，也可选择频道手动更新。", "idle", null);
  return result("后台在线 · 等待下次更新", `${active.length} 个频道定时监控，完成的情报自动显示在这里。`, "idle", null);
}
