"use client";
import {
  sourceNames,
  credibilityNames,
  importanceNames,
  type Monitor,
} from "@/shared/types";
import { feedFilterInput, type FeedFilters } from "@/shared/feed";

export function FeedControls({
  value: f,
  onChange,
  monitors,
  total,
  loading,
}: {
  value: FeedFilters;
  onChange: (f: FeedFilters) => void;
  monitors: Monitor[];
  total: number;
  loading: boolean;
}) {
  const change = <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) =>
    onChange({ ...f, [key]: value });
  const chips: { label: string; clear: () => void }[] = [];
  for (const source of f.sources)
    chips.push({
      label: sourceNames[source],
      clear: () =>
        change(
          "sources",
          f.sources.filter((s) => s !== source),
        ),
    });
  for (const id of f.monitorIds)
    chips.push({
      label: monitors.find((m) => m.id === id)?.name || "已失效频道",
      clear: () =>
        change(
          "monitorIds",
          f.monitorIds.filter((m) => m !== id),
        ),
    });
  if (f.query)
    chips.push({ label: `搜索：${f.query}`, clear: () => change("query", "") });
  if (f.importance !== "all")
    chips.push({
      label: `重要性：${importanceNames[f.importance]}`,
      clear: () => change("importance", "all"),
    });
  if (f.accountScope !== "all")
    chips.push({
      label: f.accountScope === "curated" ? "精选账号" : "官方 X 来源",
      clear: () => change("accountScope", "all"),
    });
  if (f.engagement !== "all")
    chips.push({ label: "互动门槛", clear: () => change("engagement", "all") });
  if (f.minRelevance)
    chips.push({
      label: `相关性 ≥${f.minRelevance}`,
      clear: () => change("minRelevance", 0),
    });
  if (f.credibility !== "all") chips.push({label: credibilityNames[f.credibility], clear: () => change("credibility", "all")});
  if (f.timeField === "publication") chips.push({label: "按可靠发布时间", clear: () => change("timeField", "discovery")});
  const timeName = { "1": "近 1 小时", "6": "近 6 小时", "24": "近 24 小时", "168": "近 7 天", all: "全部时间" }[f.hours];
  if (f.hours !== "24") chips.push({ label: timeName, clear: () => change("hours", "24") });
  const modified = JSON.stringify(f) !== JSON.stringify(feedFilterInput.parse({}));
  return (
    <div className="feed-filter-panel">
      <div className="feed-controls">
        <label className="filter-search">
          搜索
          <input
            placeholder="标题或摘要"
            value={f.query}
            maxLength={200}
            onChange={(e) => change("query", e.target.value)}
          />
        </label>
        <label>
          排列方式
          <select
            value={f.sort}
            onChange={(e) =>
              change("sort", e.target.value as FeedFilters["sort"])
            }
          >
            {[
              ["recommended", "推荐：重要性 → 相关性"],
              ["importance", "重要性"],
              ["relevance", "相关性"],
              ["heat", "X 社交热度"],
              ["publication", "最新发布"],
              ["discovery", "最新发现"],
            ].map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="advanced-filters">
        <summary>
          更多筛选{chips.length ? ` · ${chips.length} 项` : ""}
        </summary>
        <fieldset>
          <legend>发现渠道 · 可多选</legend>
          <div className="filter-chip-list">
            {Object.entries(sourceNames).map(([k, v]) => (
              <button
                type="button"
                key={k}
                aria-pressed={f.sources.includes(k as keyof typeof sourceNames)}
                className={
                  f.sources.includes(k as keyof typeof sourceNames)
                    ? "selected"
                    : ""
                }
                onClick={() =>
                  change(
                    "sources",
                    f.sources.includes(k as keyof typeof sourceNames)
                      ? f.sources.filter((s) => s !== k)
                      : [...f.sources, k as keyof typeof sourceNames],
                  )
                }
              >
                {v}
              </button>
            ))}
          </div>
          <p className="small muted">
            Google / Bing 是发现渠道，原始发布者显示在来源详情中。
          </p>
        </fieldset>
        <fieldset>
          <legend>监控频道 · 可多选</legend>
          <div className="filter-chip-list">
            {monitors.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={f.monitorIds.includes(m.id)}
                className={f.monitorIds.includes(m.id) ? "selected" : ""}
                onClick={() =>
                  change(
                    "monitorIds",
                    f.monitorIds.includes(m.id)
                      ? f.monitorIds.filter((id) => id !== m.id)
                      : [...f.monitorIds, m.id],
                  )
                }
              >
                {m.name}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="settings-fields">
        <label>
          时间范围
          <select
            value={f.hours}
            onChange={(e) =>
              change("hours", e.target.value as FeedFilters["hours"])
            }
          >
            {[
              ["1", "近 1 小时"],
              ["6", "近 6 小时"],
              ["24", "近 24 小时"],
              ["168", "近 7 天"],
              ["all", "全部时间"],
            ].map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label>
          时间依据
          <select
            value={f.timeField}
            onChange={(e) =>
              change("timeField", e.target.value as FeedFilters["timeField"])
            }
          >
            <option value="discovery">首次发现</option>
            <option value="publication">可靠发布时间</option>
          </select>
        </label>
          <label>证据状态
            <select value={f.credibility} onChange={(e) => change("credibility", e.target.value as FeedFilters["credibility"])}>
              <option value="all">全部证据状态</option>
              {Object.entries(credibilityNames).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>
            重要性
            <select
              value={f.importance}
              onChange={(e) =>
                change(
                  "importance",
                  e.target.value as FeedFilters["importance"],
                )
              }
            >
              <option value="all">全部重要性</option>
              {Object.entries(importanceNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            X 账号范围
            <select
              value={f.accountScope}
              onChange={(e) =>
                change(
                  "accountScope",
                  e.target.value as FeedFilters["accountScope"],
                )
              }
            >
              <option value="all">全部账号与其他来源</option>
              <option value="curated">频道精选账号</option>
              <option value="official">已确认的官方 X 来源</option>
            </select>
          </label>
          <label>
            X 展示互动门槛
            <select
              value={f.engagement}
              onChange={(e) =>
                change(
                  "engagement",
                  e.target.value as FeedFilters["engagement"],
                )
              }
            >
              <option value="all">不限 · 保留精选低互动信号</option>
              <option value="standard">标准 · 10 赞 / 3 转发 / 5 回复</option>
              <option value="strict">严格 · 50 赞 / 10 转发 / 15 回复</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label>
            最低相关性
            <input
              type="number"
              min={0}
              max={100}
              value={f.minRelevance}
              onChange={(e) =>
                change(
                  "minRelevance",
                  Math.max(0, Math.min(100, Number(e.target.value))),
                )
              }
            />
          </label>
          {f.engagement === "custom" &&
            (["minLikes", "minReposts", "minReplies"] as const).map((k, i) => (
              <label key={k}>
                {["点赞至少", "转发至少", "回复至少"][i]}
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={f[k]}
                  onChange={(e) =>
                    change(
                      k,
                      Math.max(0, Math.min(100000, Number(e.target.value))),
                    )
                  }
                />
              </label>
            ))}
        </div>
        <p className="small muted">
          同一维度任选其一，不同维度同时满足。互动门槛满足任一项即可；蓝 V
          与高热度均不证明真实。
        </p>
      </details>
      <div className="filter-summary">
        <span role="status" aria-atomic="true">
          {loading ? "正在筛选…" : `${timeName} · ${total} 条情报`}
        </span>
        {modified && <button type="button" className="text-link" onClick={() => onChange(feedFilterInput.parse({}))}>清除筛选</button>}
      </div>
      {!!chips.length && (
        <div className="filter-chip-list active-filter-chips">
          {chips.map((c, i) => (
            <button
              type="button"
              key={i}
              onClick={c.clear}
              aria-label={`移除筛选：${c.label}`}
            >
              {c.label} ×
            </button>
          ))}
        </div>
      )}
      {f.timeField === "publication" && (
        <p className="small muted">
          日期未知的信号在限时筛选中排除；选择全部时间可查看，按发布时间排序时置后。
        </p>
      )}
    </div>
  );
}
