"use client";
import { useState } from "react";
import type { Dashboard, Settings } from "@/shared/types";
import { BentoGrid, BentoGridItem } from "@/components/ui/bento-grid";

const names: Record<string, string> = {
  pending: "待入队",
  queued: "待初筛",
  selected: "初筛入选",
  irrelevant: "无关",
  low_value: "价值不足",
  insufficient: "信息不足",
  background: "背景材料",
  filtered: "基础过滤",
  observing: "新帖观察中",
  retry: "等待重试",
  failed: "需人工处理",
  budget: "预算暂停",
  running: "分析中",
  done: "已完成",
};
async function post(path: string) {
  const response = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "操作失败");
  return body;
}
export function PipelinePanel({
  data,
  reload,
}: {
  data: Dashboard;
  reload: () => Promise<void>;
}) {
  const [monitor, setMonitor] = useState(""),
    [state, setState] = useState("all"),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState("");
  const p = data.pipeline,
    c = p.candidates;
  async function act(id: string, path: string) {
    setBusy(id);
    try {
      const r = await post(path);
      setMessage(r.message);
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section
      className="source-diagnostics pipeline-panel"
      aria-labelledby="pipeline-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">ANALYSIS PIPELINE</span>
          <h2 id="pipeline-title">从线索到情报</h2>
        </div>
        <span className="small muted">
          {data.settings.analysisEnabled
            ? "自动分析已启用"
            : "自动分析已暂停，可手动分析已有材料"}
        </span>
      </div>
      <BentoGrid className="pipeline-counts">
        {[
          ["原始材料", p.raw, "去重后保存的材料数"],
          ["等待初筛", (c.pending || 0) + (c.queued || 0), "分析队列独立消费"],
          ["初筛入选", c.selected || 0, "相关且有具体新信息"],
          ["展示事件", p.displayed, "已完成事件深度核验"],
        ].map(([title, count, description]) => (
          <BentoGridItem
            key={String(title)}
            title={title}
            header={<strong className="pipeline-count">{count}</strong>}
            description={description}
          />
        ))}
      </BentoGrid>
      <p className="small muted">
        背景 {c.background || 0} · 无关 {c.irrelevant || 0} · 价值不足{" "}
        {c.low_value || 0} · 信息不足 {c.insufficient || 0} · 基础过滤{" "}
        {c.filtered || 0} · 新帖观察 {c.observing || 0}
        。原始材料按去重文章计数，初筛按频道任务计数，事件按聚合结果计数。
      </p>
      <div className="pipeline-actions">
        <label>
          分析频道
          <select value={monitor} onChange={(e) => setMonitor(e.target.value)}>
            <option value="">请选择频道</option>
            {data.monitors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn secondary"
          disabled={!monitor || !!busy || !data.health.worker}
          onClick={() =>
            void act("analyze", "monitors/" + monitor + "/analyze")
          }
        >
          {busy === "analyze" ? "排队中…" : "分析已有材料"}
        </button>
      </div>
      <p className="small muted">
        不会重新搜索。后台需在线；每次调用受预算约束。今日 X 父帖查询{" "}
        {p.contextRequests}/{data.settings.xContextDailyLimit} 次；AI{" "}
        {p.usage.calls}/{data.settings.aiDailyCallLimit} 次，已知{" "}
        {p.usage.tokens.toLocaleString()} tokens，未知用量 {p.usage.unknown}{" "}
        次，保守预留 {p.usage.reserved.toLocaleString()} tokens。
      </p>
      {message && (
        <p role="status" className="pipeline-message">
          {message}
        </p>
      )}
      <details>
        <summary>查看逐条分析结论与失败任务</summary>
        <label className="pipeline-filter">
          筛选结论
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">最近全部</option>
            {Object.entries(names)
              .filter(([k]) => k in c)
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </label>
        <div className="pipeline-audit">
          {p.assessments
            .filter((a) => state === "all" || a.state === state)
            .map((a) => (
              <article key={a.id}>
                <div className="row-between">
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.title}
                  </a>
                  <span className="source-pill">
                    {names[a.state] || a.state}
                  </span>
                </div>
                <p>{a.reason}</p>
                <span className="small muted">
                  相关性 {a.relevance ?? "未分析"} · 信息价值{" "}
                  {a.value ?? "未分析"} ·{" "}
                  {data.monitors.find((m) => m.id === a.monitorId)?.name}
                </span>
              </article>
            ))}
        </div>
        {!p.assessments.length && (
          <p className="small muted">采集后会在此显示每条候选的结论。</p>
        )}
        <h3>最近分析任务</h3>
        <div className="pipeline-audit">
          {p.recentJobs.map((j) => (
            <article key={j.id}>
              <div className="row-between">
                <strong>
                  {j.stage === "screen" ? "候选初筛" : "事件深度核验"} ·{" "}
                  {names[j.state] || j.state}
                </strong>
                {["retry", "failed", "budget"].includes(j.state) && (
                  <button
                    className="btn secondary"
                    disabled={!!busy || !data.health.worker}
                    onClick={() =>
                      void act(j.id, "analysis/" + j.id + "/retry")
                    }
                  >
                    {busy === j.id ? "排队中…" : "重试"}
                  </button>
                )}
              </div>
              <p className="small muted">
                {data.monitors.find((m) => m.id === j.monitorId)?.name} ·
                当前尝试 {j.attempts} 次 · AI 累计耗时{" "}
                {Math.round(j.aiDurationMs / 1000)} 秒
                {j.nextAttemptAt > Date.now()
                  ? ` · 下次尝试 ${new Date(j.nextAttemptAt).toLocaleString("zh-CN")}`
                  : ""}
              </p>
              {j.error && <p>{j.error}</p>}
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

export function AnalysisSettings({
  value,
  onChange,
}: {
  value: Settings;
  onChange: (next: Settings) => void;
}) {
  return (
    <div className="search-budget">
      <h3>分阶段分析与预算</h3>
      {value.model === "deepseek-v4-pro" && (
        <label>
          分析输出模式
          <select
            value={value.thinkingMode}
            onChange={(e) =>
              onChange({
                ...value,
                thinkingMode: e.target.value as Settings["thinkingMode"],
              })
            }
          >
            <option value="disabled">稳定输出（推荐）</option>
            <option value="auto">使用模型默认思考模式</option>
          </select>
          <small>
            稳定模式通过分阶段任务核验；默认思考模式可能增加耗时和截断。
          </small>
        </label>
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={value.analysisEnabled}
          onChange={(e) =>
            onChange({ ...value, analysisEnabled: e.target.checked })
          }
        />
        启用自动分析（只处理运行中频道）
      </label>
      <p className="small muted">
        初筛最多使用日预算的
        80%，为深度分析留出空间。失败请求也计入次数；用量未知时保留 token
        预留量。
      </p>
      <div className="settings-fields">
        {[
          {
            key: "xContextDailyLimit",
            label: "每日 X 父帖查询上限",
            min: 0,
            max: 1000,
          },
          {
            key: "aiDailyCallLimit",
            label: "每日 AI 调用上限",
            min: 0,
            max: 10000,
          },
          {
            key: "aiDailyTokenLimit",
            label: "每日 AI token 上限",
            min: 0,
            max: 10000000,
          },
          {
            key: "candidateLimit",
            label: "每轮候选入队上限",
            min: 10,
            max: 1000,
          },
          {
            key: "eventWindowHours",
            label: "活跃事件窗口（小时）",
            min: 1,
            max: 720,
          },
          { key: "minValue", label: "展示信息价值阈值", min: 0, max: 100 },
          { key: "webPages", label: "每轮每引擎检索次数", min: 1, max: 5 },
        ].map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={value[f.key as "aiDailyCallLimit"]}
              onChange={(e) =>
                onChange({ ...value, [f.key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <p className="small muted">
        网页多查询和分页共享搜索额度；原文上限按每个深度任务计数。普通 X
        账号按频道互动策略筛选，精选和官方账号不限最低互动量。蓝
        V、热度与可信度分别展示。
      </p>
    </div>
  );
}

export function EventFeedback({ id }: { id: string }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function send(verdict: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/events/${id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || "保存失败");
      setMessage(b.message);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="event-feedback">
      <strong>这条情报对你有帮助吗？</strong>
      <div className="pipeline-actions">
        {[
          ["valuable", "有价值"],
          ["irrelevant", "不相关"],
          ["duplicate", "重复"],
          ["insufficient", "证据不足"],
        ].map(([key, label]) => (
          <button
            className="btn secondary"
            key={key}
            disabled={busy}
            onClick={() => void send(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
