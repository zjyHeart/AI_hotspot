"use client";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type ReactNode,
} from "react";
import { HomeStatus } from "./home-status";
import {
  PipelinePanel,
  AnalysisSettings,
  EventFeedback,
} from "./pipeline-panel";
import { ListInput } from "./list-input";
import { PublisherEditor } from "./publisher-editor";
import { XAccountEditor } from "./x-account-editor";
import { FeedControls } from "./feed-filters";
import {
  feedFilterInput,
  firstDiscovered,
  socialHeat,
  eventSources,
  type FeedFilters,
  type FeedPage,
} from "@/shared/feed";
import {
  qualityInput,
  sourceNames,
  credibilityNames,
  importanceNames,
  type Dashboard,
  type Monitor,
  type MonitorInput,
  type Event,
  type Settings,
  type Source,
  type ScanRun,
  type SourceReport,
} from "@/shared/types";

const paths: Record<string, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="m12 12 6-6" />
      <circle cx="15" cy="9" r="1" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  external: (
    <>
      <path d="M13 4h7v7m0-7L9 15" />
      <path d="M10 4H4v16h16v-6" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m8 5 11 7-11 7z" />,
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-2l2 7M4 12l2 7a7 7 0 0 0 12-2" />
    </>
  ),
  edit: (
    <>
      <path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  signal: (
    <>
      <path d="M4 20v-4M9 20v-8M14 20V8M19 20V4" />
    </>
  ),
  book: (
    <>
      <path d="M12 6C8 3 4 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-1-10 2zM12 6v14" />
    </>
  ),
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.signal}
    </svg>
  );
}
const dt = (n: number | null) =>
  n
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(n)
    : "尚未扫描";
const statusNames: Record<string, string> = {
  idle: "等待首轮",
  queued: "已排队",
  running: "扫描中",
  success: "扫描完成",
  partial: "本轮完成 · 查看采集详情",
  failed: "采集失败",
  analysis_failed: "AI 分析失败",
  interrupted: "任务中断",
};
function sourceHasError(report: SourceReport) {
  return (
    report.status === "error" ||
    (report.source === "rss" && report.status === "partial")
  );
}
function runPresentation(run: ScanRun) {
  if (run.status === "partial") {
    if (
      run.reports.some((p) => sourceHasError(p) || p.status === "unconfigured")
    )
      return { label: "本轮完成 · 部分来源异常", badge: "disputed" };
    if (run.reports.some((p) => p.status === "budget"))
      return { label: "本轮完成 · 搜索预算暂停", badge: "unverified" };
    const limited = run.reports.some(
      (p) => p.status === "partial" && (p.source === "x" || p.source === "hn"),
    );
    return {
      label: limited ? "本轮完成 · 采集达到上限" : "本轮完成 · 有限采集",
      badge: "unverified",
    };
  }
  return {
    label: statusNames[run.status] || run.status,
    badge:
      run.status === "success"
        ? "supported"
        : run.status === "running"
          ? "unverified"
          : "disputed",
  };
}
const emailNames: Record<string, string> = {
  unconfigured: "邮件未配置",
  queued: "邮件待发送",
  sending: "邮件投递中",
  accepted: "SMTP 已接受",
  retry: "等待重试",
  failed: "邮件发送失败",
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    method,
    headers:
      method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data as T;
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">SIGNAL DESK / WORKSPACE</span>
          <h2>{title}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="关闭对话框">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function MonitorForm({
  monitor,
  defaults,
  onClose,
  onSaved,
}: {
  monitor: Monitor | null;
  defaults: Settings;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<MonitorInput>(
    monitor
      ? {
          ...monitor,
          quality: qualityInput.parse({
            ...monitor.quality,
            engagementMode: monitor.quality?.engagementMode ?? "loose",
          }),
        }
      : {
          name: "",
          kind: "keyword",
          keywords: "",
          aliases: "",
          excludes: "",
          sources: ["x", "hn", "rss", "google", "bing"],
          rssUrls: [],
          intervalMinutes: defaults.defaultInterval,
          minRelevance: 65,
          notifyUnverified: false,
          cooldownMinutes: 60,
          active: true,
          quality: qualityInput.parse({}),
        },
  );
  const [rss, setRss] = useState(value.rssUrls.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = <K extends keyof MonitorInput>(key: K, v: MonitorInput[K]) =>
    setValue((old) => ({ ...old, [key]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        monitor ? `monitors/${monitor.id}` : "monitors",
        monitor ? "PUT" : "POST",
        {
          ...value,
          rssUrls: rss
            .split(/\n/)
            .map((x) => x.trim())
            .filter(Boolean),
        },
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={monitor ? "编辑监控频道" : "建立你的信号频道"}
      onClose={onClose}
    >
      <form onSubmit={submit} className="monitor-form">
        <button
          type="button"
          className="btn secondary topic-preset"
          onClick={() =>
            setValue((old) => ({
              ...old,
              name: "AI 编程与 Agent",
              kind: "topic",
              keywords: "AI coding agent",
              aliases:
                "Claude Code, Codex, Cursor, Cline, OpenCode, LangGraph, coding agent",
              sources: [...new Set([...old.sources, "x" as Source])],
              intervalMinutes: 30,
              quality: {
                ...old.quality,
                useCuratedAccounts: true,
                engagementMode: "standard",
                observationMinutes: 120,
              },
            }))
          }
        >
          应用「AI 编程与 Agent」专题
        </button>
        <div className="segmented">
          <button
            type="button"
            className={value.kind === "keyword" ? "selected" : ""}
            onClick={() => change("kind", "keyword")}
          >
            关键词监控
          </button>
          <button
            type="button"
            className={value.kind === "topic" ? "selected" : ""}
            onClick={() => change("kind", "topic")}
          >
            领域热点发现
          </button>
        </div>
        <p className="muted form-intro">
          {value.kind === "keyword"
            ? "关注具体产品、公司或议题，发现相关新内容时提醒你。"
            : "从一个领域的动态中，聚合事件、识别热点并解释上榜依据。"}
        </p>
        <label>
          频道名称
          <input
            autoFocus
            required
            maxLength={80}
            value={value.name}
            placeholder="例如：AI 编程观察"
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        <label>
          {value.kind === "keyword" ? "监控关键词" : "关注领域"}
          <input
            required
            maxLength={200}
            value={value.keywords}
            placeholder="例如：AI 编程、Claude Code、Cursor"
            onChange={(e) => change("keywords", e.target.value)}
          />
        </label>
        <div className="quick-terms">
          试试：
          {["AI 编程", "Claude Code", "AI Agent"].map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => {
                change("keywords", t);
                change("name", `${t}观察`);
                if (t === "AI 编程")
                  change(
                    "aliases",
                    "AI coding, coding agent, Cursor, Claude Code",
                  );
              }}
            >
              {t}
              <span>↗</span>
            </button>
          ))}
        </div>
        <label>
          同义词 / 扩展词
          <input
            value={value.aliases}
            maxLength={500}
            placeholder="AI coding, coding agent（逗号分隔）"
            onChange={(e) => change("aliases", e.target.value)}
          />
        </label>
        <label>
          排除词
          <input
            value={value.excludes}
            maxLength={500}
            placeholder="广告、招聘（逗号分隔，可留空）"
            onChange={(e) => change("excludes", e.target.value)}
          />
        </label>
        <fieldset>
          <legend>获取渠道</legend>
          <div className="source-options">
            {Object.entries(sourceNames).map(([k, v]) => (
              <label className="check-label" key={k}>
                <input
                  type="checkbox"
                  checked={value.sources.includes(k as Source)}
                  onChange={(e) =>
                    change(
                      "sources",
                      e.target.checked
                        ? [...value.sources, k as Source]
                        : value.sources.filter((x) => x !== k),
                    )
                  }
                />
                {v}
              </label>
            ))}
          </div>
        </fieldset>
        {value.sources.includes("rss") && (
          <label>
            自定义 RSS / Atom 地址
            <textarea
              value={rss}
              onChange={(e) => setRss(e.target.value)}
              placeholder="每行一个公开订阅地址，留空使用预置 AI 技术源"
              rows={2}
            />
          </label>
        )}
        <details className="quality-options">
          <summary>信息质量与多源设置</summary>
          <p className="small muted">
            精选与已确认官方账号不限互动量；普通搜索按下方规则过滤。新帖先观察再复查，回复保留技术细节；蓝
            V 不证明真实。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={value.quality.useCuratedAccounts}
              onChange={(e) =>
                change("quality", {
                  ...value.quality,
                  useCuratedAccounts: e.target.checked,
                })
              }
            />
            监控 AI 编程与 Agent 精选账号（在设置中管理）
          </label>
          <div className="form-grid">
            <label>
              普通账号互动策略
              <select
                value={value.quality.engagementMode}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    engagementMode: e.target
                      .value as MonitorInput["quality"]["engagementMode"],
                  })
                }
              >
                <option value="loose">宽松 · 全部进入 AI 初筛</option>
                <option value="standard">标准 · 10 赞 / 3 转发 / 5 回复</option>
                <option value="strict">严格 · 50 赞 / 10 转发 / 15 回复</option>
                <option value="custom">自定义 · 使用下方门槛</option>
              </select>
            </label>
            <label>
              新帖观察时间（分钟）
              <input
                type="number"
                min={0}
                max={1440}
                value={value.quality.observationMinutes}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    observationMinutes: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              自定义门槛：或回复至少
              <input
                type="number"
                min={0}
                max={100000}
                value={value.quality.minReplies}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    minReplies: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={value.quality.excludeReplies}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    excludeReplies: e.target.checked,
                  })
                }
              />
              过滤无实质信息的回复（保留技术回复）
            </label>
            <label>
              自定义门槛：点赞至少
              <input
                type="number"
                min="0"
                max="100000"
                value={value.quality.minLikes}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    minLikes: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              或转发至少
              <input
                type="number"
                min="0"
                max="100000"
                value={value.quality.minReposts}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    minReposts: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              网页搜索间隔
              <select
                value={value.quality.webIntervalMinutes}
                onChange={(e) =>
                  change("quality", {
                    ...value.quality,
                    webIntervalMinutes: Number(e.target.value),
                  })
                }
              >
                {[
                  30,
                  60,
                  120,
                  240,
                  360,
                  720,
                  1440,
                  ...(![30, 60, 120, 240, 360, 720, 1440].includes(
                    value.quality.webIntervalMinutes,
                  )
                    ? [value.quality.webIntervalMinutes]
                    : []),
                ].map((t) => (
                  <option value={t} key={t}>
                    {t} 分钟
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            额外监控的 X 账号（会主动采集，不限互动）
            <ListInput
              value={value.quality.followedAccounts}
              placeholder="不含 @，多个账号用逗号分隔"
              onChange={(parts) =>
                change("quality", { ...value.quality, followedAccounts: parts })
              }
            />
          </label>
          <label>
            屏蔽 X 账号
            <ListInput
              value={value.quality.blockedAccounts}
              onChange={(parts) =>
                change("quality", { ...value.quality, blockedAccounts: parts })
              }
            />
          </label>
          <label>
            关注 GitHub 版本发布
            <ListInput
              multiline
              value={value.quality.githubRepos}
              placeholder="每行 owner/repo，例如 vercel/next.js。留空使用仓库发现，仓库更新不代表发布。"
              onChange={(parts) =>
                change("quality", { ...value.quality, githubRepos: parts })
              }
            />
          </label>
          <p className="small muted">
            泛词 Agent 容易混入无关领域，建议填 AI
            Agent，并在扩展词中填写对应英文。广告排除和互动过滤不会证明内容真实。
          </p>
        </details>
        <div className="form-grid">
          <label>
            扫描间隔
            <select
              value={value.intervalMinutes}
              onChange={(e) =>
                change("intervalMinutes", Number(e.target.value))
              }
            >
              {[
                5,
                15,
                30,
                60,
                120,
                360,
                1440,
                ...(![5, 15, 30, 60, 120, 360, 1440].includes(
                  value.intervalMinutes,
                )
                  ? [value.intervalMinutes]
                  : []),
              ].map((t) => (
                <option value={t} key={t}>
                  {t} 分钟
                </option>
              ))}
            </select>
          </label>
          <label>
            相关性阈值
            <input
              type="number"
              min="0"
              max="100"
              value={value.minRelevance}
              onChange={(e) => change("minRelevance", Number(e.target.value))}
            />
          </label>
          <label>
            提醒冷却时间（分钟）
            <input
              type="number"
              min="0"
              max="1440"
              value={value.cooldownMinutes}
              onChange={(e) =>
                change("cooldownMinutes", Number(e.target.value))
              }
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={value.active}
              onChange={(e) => change("active", e.target.checked)}
            />
            保存后启用监控
          </label>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={value.notifyUnverified}
            onChange={(e) => change("notifyUnverified", e.target.checked)}
          />
          同时提醒待核实内容
        </label>
        <p className="small muted">
          默认只提醒有来源支持的新内容。历史内容会展示，不触发首轮提醒。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "正在保存…" : monitor ? "保存修改" : "创建频道"}
            <Icon name="arrow" />
          </button>
        </div>
      </form>
    </Modal>
  );
}
function EventDetail({
  event,
  onClose,
}: {
  event: Event;
  onClose: () => void;
}) {
  return (
    <Modal title="情报详情" onClose={onClose} wide>
      <article className="event-detail">
        <div className="detail-meta">
          <span className="badge">
            重要性 {importanceNames[event.details?.importance ?? "unassessed"]}
          </span>
          <span className={`badge ${event.credibility}`}>
            {credibilityNames[event.credibility]}
          </span>
          <span>{dt(event.updatedAt)}</span>
          <span>相关性 {event.relevance}</span>
        </div>
        <h3>{event.title}</h3>
        <p className="detail-summary">{event.summary}</p>
        <p className="small muted">
          首次发现 {dt(firstDiscovered(event))} · 可靠发布时间{" "}
          {event.details?.publishedAt ? dt(event.details.publishedAt) : "未知"}
        </p>
        <h4>
          原始来源{" "}
          <span className="muted">
            /{event.evidence.length.toString().padStart(2, "0")}
          </span>
        </h4>
        <div className="evidence-list">
          {event.evidence.map((e) => {
            const a = event.articles?.find((a) => a.id === e.articleId);
            return (
              <div key={e.articleId} className="evidence">
                <div className="row-between">
                  <span className="source-pill">
                    {a ? sourceNames[a.source] : "来源缺失"}
                  </span>
                  <span className="small muted">
                    {a?.author} · {dt(a?.publishedAt || null)}
                  </span>
                </div>
                <p className="small muted">
                  {a?.metadata?.contentStatus === "full"
                    ? "已读取原文"
                    : a?.metadata?.contentStatus === "snippet"
                      ? "仅有检索/订阅摘要"
                      : a?.metadata?.contentStatus === "failed"
                        ? "正文读取失败 · 当前仅摘要"
                        : "来源原始记录"}
                  {a?.metadata?.discoverySources?.length
                    ? ` · 发现渠道：${a.metadata.discoverySources.map((s) => sourceNames[s]).join(" / ")}`
                    : ""}
                  {a?.metadata?.fetchError ? ` · ${a.metadata.fetchError}` : ""}
                </p>
                {a?.source === "x" && (
                  <p className="small muted">
                    {a.metadata?.isBlueVerified
                      ? "蓝 V · 不代表专业或真实"
                      : "蓝 V 状态未确认 / 未认证"}
                    {a.metadata?.verifiedType
                      ? ` · 认证类型 ${a.metadata.verifiedType}`
                      : ""}
                    {a.metadata?.followers !== undefined
                      ? ` · 粉丝 ${a.metadata.followers.toLocaleString()}`
                      : ""}
                    {a.metadata?.xDiscovery?.length
                      ? ` · 采集：${a.metadata.xDiscovery.map((l) => ({ accounts: "账号监控", keywords: "关键词搜索", observation: "互动复查" })[l]).join(" / ")}`
                      : ""}
                  </p>
                )}
                <blockquote>{e.excerpt}</blockquote>
                {a && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    阅读原文
                    <Icon name="external" size={14} />
                  </a>
                )}
                <p className="small muted">
                  {e.role === "first_party"
                    ? "一手声明"
                    : e.role === "independent"
                      ? "独立报道"
                      : e.role === "repost"
                        ? "转述/转载"
                        : "来源身份待核实"}
                  {a && Object.keys(a.metrics).length
                    ? ` · ${Object.entries(a.metrics)
                        .map(
                          ([k, v]) =>
                            `${({ likes: "点赞", replies: "回复", reposts: "转发", quotes: "引用", views: "浏览", points: "积分", stars: "Star" } as Record<string, string>)[k]} ${v}`,
                        )
                        .join(" / ")}`
                    : " · 无可用互动数据"}
                </p>
              </div>
            );
          })}
        </div>
        <details className="detail-analysis">
          <summary>查看 AI 分析与核验细节</summary>
        <div className="detail-explanation">
          <div>
            <strong>重要性依据</strong>
            <p>
              {event.details?.importanceReason ||
                "旧分析尚未评估重要性，可分析已有材料更新。"}
            </p>
          </div>
        </div>
        <div className="detail-explanation">
          <Icon name="signal" />
          <div>
            <strong>推荐综合分 · {event.score} 分</strong>
            <p>{event.scoreReason}</p>
          </div>
        </div>
        <div className="detail-explanation">
          <Icon name="shield" />
          <div>
            <strong>证据判断</strong>
            <p>{event.reason}</p>
            <p className="small">
              有来源支持表示已采集材料支持该说法，不保证事实绝对正确。
            </p>
          </div>
        </div>
        {event.details?.impact && (
          <div className="detail-explanation">
            <div>
              <strong>信息价值 {event.details.value} · 实际影响</strong>
              <p>{event.details.impact}</p>
            </div>
          </div>
        )}
        {!!event.details?.claims?.length && (
          <div className="claim-audit">
        <h4>逐项核验</h4>
            {event.details.claims.map((c, i) => (
              <div key={i}>
                <strong>{c.claim}</strong>
                <span className="source-pill">
                  {
                    {
                      supported: "有材料支持",
                      insufficient: "证据不足",
                      contradicted: "存在反证",
                    }[c.verdict]
                  }
                </span>
                <p>{c.reason}</p>
                {c.citations?.map((ref, j) => (
                  <blockquote key={j}>
                    <p>{ref.excerpt}</p>
                    <a
                      href={
                        event.articles?.find((a) => a.id === ref.articleId)?.url
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      查看对应原文 ↗
                    </a>
                  </blockquote>
                ))}
              </div>
            ))}
          </div>
        )}
        {!!event.details?.gaps?.length && (
          <div className="detail-explanation">
            <div>
              <strong>仍需核实</strong>
              <ul>
                {event.details.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <EventFeedback id={event.id} />
        </details>
      </article>
    </Modal>
  );
}
export default function Desk() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [view, setView] = useState("overview");
  const [form, setForm] = useState<Monitor | null | undefined>(undefined);
  const [detail, setDetail] = useState<Event | null>(null);
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [workerHelp, setWorkerHelp] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const dashboardRequest = useRef<AbortController | null>(null);
  const lastFeedQuery = useRef("");
  const lastSuccessfulFeedQuery = useRef("");
  const manualFeedRefresh = useRef(false);
  const [filters, setFilters] = useState<FeedFilters>(
    feedFilterInput.parse({}),
  );
  const [filtersReady, setFiltersReady] = useState(false);
  const [feed, setFeed] = useState<FeedPage>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 30,
  });
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("signal-feed-filters-v1");
      if (stored) setFilters(feedFilterInput.parse(JSON.parse(stored)));
    } catch {
      /* Ignore invalid or unavailable browser storage. */
    }
    setFiltersReady(true);
  }, []);
  useEffect(() => {
    if (!filtersReady) return;
    try {
      localStorage.setItem("signal-feed-filters-v1", JSON.stringify(filters));
    } catch {
      /* Storage may be disabled. */
    }
  }, [filters, filtersReady]);
  function changeFilters(next: FeedFilters) {
    setFilters(next);
    setPage(1);
  }
  useEffect(() => {
    if (!data || !filtersReady) return;
    const controller = new AbortController();
    const queryKey = JSON.stringify([filters, page]);
    if (lastFeedQuery.current !== queryKey) setFeedLoading(true);
    lastFeedQuery.current = queryKey;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        filters: JSON.stringify(filters),
        page: String(page),
      });
      void fetch("/api/events?" + params, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (res) => {
          const payload = await res.json();
          if (!res.ok) throw new Error(payload.error || "筛选失败");
          if (!controller.signal.aborted) {
            setFeed(payload);
            setFeedError("");
            lastSuccessfulFeedQuery.current = queryKey;
            setRefreshedAt(Date.now());
            if (manualFeedRefresh.current) setToast("列表已刷新；新内容由后台采集和分析后自动出现。");
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setFeedError(error.message);
            // Keep matching results during a polling failure, never show another filter's results.
            if (lastSuccessfulFeedQuery.current !== queryKey)
              setFeed({ items: [], total: 0, page: 1, pageSize: 30 });
            if (manualFeedRefresh.current) setToast("刷新列表失败，请重试。");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setFeedLoading(false);
            if (manualFeedRefresh.current) {
              setRefreshing(false);
              manualFeedRefresh.current = false;
            }
          }
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [data, filters, page, filtersReady]);
  const [draft, setDraft] = useState<Settings | null>(null);
  const reload = useCallback(async (manual = false) => {
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    if (manual) { setRefreshing(true); manualFeedRefresh.current = true; }
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal: controller.signal });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || "加载失败");
      if (controller.signal.aborted) return;
      setData(next);
      setLoadError("");
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoadError((error as Error).message);
        setRefreshing(false);
        manualFeedRefresh.current = false;
      }
    } finally {
      if (dashboardRequest.current === controller) dashboardRequest.current = null;
    }
  }, []);
  useEffect(() => {
    void reload();
    const interval = setInterval(() => { if (!document.hidden && !dashboardRequest.current) void reload(); }, 10000);
    const visible = () => { if (!document.hidden) void reload(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      dashboardRequest.current?.abort();
    };
  }, [reload]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function act(
    id: string,
    task: () => Promise<unknown>,
    message: string,
  ) {
    setBusy(id);
    try {
      const result = await task();
      setToast(
        result && typeof result === "object" && "message" in result
          ? String(result.message)
          : message,
      );
      await reload();
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  const titles: Record<string, string> = {
    overview: "最新情报",
    monitors: "监控频道",
    notifications: "通知中心",
    runs: "更新记录",
    settings: "连接与设置",
  };
  const unread = data?.notifications.filter((n) => !n.readAt).length || 0;
  const list = feed.items;
  const active = data?.monitors.filter((m) => m.active).length || 0;
  const updateScope = filters.monitorIds.length === 1 ? filters.monitorIds[0]
    : filters.monitorIds.length > 1 ? "selected" : "active";
  const updateTargets = (data?.monitors || []).filter((m) =>
    filters.monitorIds.length ? filters.monitorIds.includes(m.id) : m.active,
  );
  const canUpdate = !!data?.health.worker && !!updateTargets.length &&
    updateTargets.some((m) => !m.scanRequested && m.leaseUntil <= Date.now());
  async function updateIntelligence() {
    if (!canUpdate || busy) return;
    setBusy("update-feed");
    let count = 0;
    const failures: string[] = [];
    for (const m of updateTargets) {
      if (m.scanRequested || m.leaseUntil > Date.now()) continue;
      try {
        await api(`monitors/${m.id}/scan`, "POST");
        count++;
      } catch (error) { failures.push(`${m.name}：${(error as Error).message}`); }
    }
    setToast([count ? `${count} 个频道已排队：采集 → AI 分析 → 显示情报。` : "未能开始更新", ...failures].join("；"));
    await reload();
    setBusy("");
  }
  function viewMonitor(m: Monitor) {
    changeFilters(feedFilterInput.parse({ monitorIds: [m.id], hours: "all" }));
    setView("overview");
  }
  function monitorCard(m: Monitor, compact = false) {
    const latest = data?.runs.find(
      (r) => r.monitorId === m.id && r.status === m.lastStatus,
    );
    const status = latest
      ? runPresentation(latest).label
      : statusNames[m.lastStatus] || m.lastStatus;
    return (
      <div className={`monitor-card ${compact ? "compact" : ""}`} key={m.id}>
        <div className="row-between">
          <span className="eyebrow">
            {m.kind === "topic" ? "TOPIC DISCOVERY" : "KEYWORD WATCH"}
          </span>
          <span className={`state-dot ${m.active ? "on" : ""}`}>
            {m.active ? "定时已启用" : "已暂停"}
          </span>
        </div>
        <h3>{m.name}</h3>
        <p className="monitor-keyword">{m.keywords}</p>
        <div className="monitor-tags">
          {m.sources.map((s) => (
            <span key={s}>
              {
                {
                  x: "X",
                  hn: "HN",
                  rss: "RSS",
                  github: "GitHub",
                  google: "Google",
                  bing: "Bing",
                }[s]
              }
            </span>
          ))}
          <span>{m.intervalMinutes} min</span>
        </div>
        <div className="monitor-status">
          <span>{status}</span>
          <span>{m.lastRunAt ? dt(m.lastRunAt) : "等待首轮扫描"}</span>
        </div>
        {!compact && (
          <p className="small muted">
            {m.active ? `下次扫描 ${dt(m.nextRunAt)}` : "启用后恢复定时扫描"} ·
            相关性 ≥{m.minRelevance}
          </p>
        )}
        <div className="monitor-actions">
          <button onClick={() => viewMonitor(m)}><Icon name="book" size={14} />查看情报</button>
          <button
            onClick={() =>
              void act(
                m.id,
                () => api(`monitors/${m.id}/scan`, "POST"),
                "扫描已排队，后台任务将执行",
              )
            }
            disabled={!!busy || !data?.health.worker || m.scanRequested || m.leaseUntil > Date.now()}
          >
            <Icon name="refresh" size={14} />
            {m.leaseUntil > Date.now() ? "更新中" : m.scanRequested ? "已排队" : "更新情报"}
          </button>
          <button
            className="icon-btn"
            aria-label={`编辑 ${m.name}`}
            onClick={() => setForm(m)}
            disabled={m.lastStatus === "running"}
          >
            <Icon name="edit" size={15} />
          </button>
          <button
            className="icon-btn"
            aria-label={`${m.active ? "暂停" : "启用"} ${m.name}`}
            onClick={() =>
              void act(
                m.id,
                () => api(`monitors/${m.id}`, "PATCH", { active: !m.active }),
                m.active ? "频道已暂停" : "频道已启用",
              )
            }
            disabled={busy === m.id}
          >
            <Icon name={m.active ? "pause" : "play"} size={15} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        跳至工作区
      </a>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Signal Desk 首页">
          <span className="brand-symbol">
            <Icon name="activity" size={25} />
          </span>
          <span>
            SIGNAL<span className="brand-sub">DESK / 信号台</span>
          </span>
        </a>
        <div className="sidebar-caption">YOUR INTELLIGENCE DESK</div>
        <nav aria-label="主导航">
          {[
            ["overview", "grid"],
            ["monitors", "radar"],
            ["notifications", "bell"],
            ["runs", "activity"],
            ["settings", "settings"],
          ].map(([k, icon]) => (
            <button
              key={k}
              aria-label={titles[k]}
              title={titles[k]}
              aria-current={view === k ? "page" : undefined}
              className={`nav-item ${view === k ? "active" : ""}`}
              onClick={() => {
                setView(k);
                setDraft(null);
              }}
            >
              <Icon name={icon} />
              <span>{titles[k]}</span>
              {k === "notifications" && unread > 0 && (
                <b className="nav-count">{unread}</b>
              )}
              {k === "monitors" && (
                <span className="nav-index">
                  {String(data?.monitors.length || 0).padStart(2, "0")}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="eyebrow">
              LESS NOISE.
              <br />
              MORE SIGNAL.
            </span>
            <p>
              信息很多。
              <br />
              值得关注的，应该更少。
            </p>
            <div className="note-line" />
          </div>
          <button
            className="worker-indicator"
            onClick={() => setView("settings")}
          >
            <span
              className={`dot ${data?.health.worker ? "green" : "amber"}`}
            />
            <span>
              {data?.health.worker ? "后台采集在线" : "后台采集离线"}
              <small>
                {data?.health.worker ? "网页关闭后继续工作" : "需要启动 worker"}
              </small>
            </span>
            <Icon name="arrow" size={14} />
          </button>
          <span className="sidebar-version">
            LOCAL EDITION <span>V 0.1</span>
          </span>
        </div>
      </aside>
      <main className="workspace" id="workspace" tabIndex={-1}>
        <header className="topbar">
          <div className="breadcrumb">
            工作台 <span>/</span>
            <strong>{titles[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-label">LOCAL EDITION</span>
            <time>
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: "Asia/Shanghai",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(new Date())}
            </time>
            <button
              className="notification-icon"
              aria-label="查看通知"
              onClick={() => setView("notifications")}
            >
              <Icon name="bell" />
              {unread > 0 && <span className="dot amber" />}
            </button>
            <span className="avatar">S.</span>
          </div>
        </header>
        {toast && (
          <div className="toast" role="status">
            <span>{toast}</span>
            <button onClick={() => setToast("")} aria-label="关闭提示">
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {loadError && (
          <div className="error-banner" role="alert">
            无法加载工作台：{loadError}
            <button onClick={() => void reload()}>重试</button>
          </div>
        )}
        {!data && !loadError ? (
          <div className="loading-state">
            <span className="eyebrow">CONNECTING TO YOUR DESK</span>
            <h1>
              正在载入信号台<span className="loading-dots">…</span>
            </h1>
            <div className="skeleton" />
            <div className="skeleton short" />
          </div>
        ) : (
          data && (
            <div className="page-content">
              {view === "overview" && (
                <>
                  <section className="home-heading">
                    <div>
                      <span className="eyebrow">YOUR DAILY SIGNAL</span>
                      <h1>最新情报</h1>
                      <p>监控后的情报都在这里，点击标题查看摘要和来源。</p>
                    </div>
                    <button className="btn secondary" onClick={() => setForm(null)}><Icon name="plus" size={16} />添加监控</button>
                  </section>
                  <div className="home-update-toolbar">
                    <label>监控频道
                      <select value={updateScope} onChange={(e) => changeFilters({ ...filters, monitorIds: e.target.value === "active" ? [] : [e.target.value] })}>
                        <option value="active">全部频道 · {active} 个运行中</option>
                        {updateScope === "selected" && <option value="selected">已筛选的 {filters.monitorIds.length} 个频道</option>}
                        {data.monitors.map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? "" : " · 已暂停"}</option>)}
                      </select>
                    </label>
                    <button className="btn primary" disabled={!canUpdate || !!busy} onClick={() => void updateIntelligence()}>
                      <Icon name="refresh" size={16} />{busy === "update-feed" ? "提交更新…" : "更新情报"}
                    </button>
                    <button className="btn secondary" disabled={refreshing} onClick={() => void reload(true)}>
                      <Icon name="refresh" size={16} />{refreshing ? "刷新中…" : "刷新列表"}
                    </button>
                    <p className="update-hint">更新：采集 + AI 分析 · 刷新：读取结果</p>
                  </div>
                  <HomeStatus data={data} onDetails={() => setView("runs")} onHelp={() => setWorkerHelp(true)} />
                  <div className="home-reading-line">
                    <span>{refreshedAt ? `最近同步 ${dt(refreshedAt)}` : "正在同步列表"} · 每 10 秒自动同步</span>
                  </div>
                  {(!data.health.x || !data.health.ai) && (
                    <div className="setup-notice">
                      <Icon name="settings" size={17} />
                      <span>
                        {!data.health.x && !data.health.ai
                          ? "连接 X 与 AI，让信号开始流动。"
                          : !data.health.x
                            ? "X 尚未连接，填写 twitterapi.io Key 即可开启。"
                            : "原始内容会保留，连接 OpenRouter 后开始 AI 分析。"}
                      </span>
                      <button onClick={() => setView("settings")}>
                        完成连接
                        <Icon name="arrow" size={14} />
                      </button>
                    </div>
                  )}
                  <div className="home-feed-layout">
                    <section className="signal-feed" aria-busy={feedLoading}>
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">THE SIGNAL FEED</span>
                          <h2>
                            情报列表
                            <span className="section-count">
                              /{String(feed.total).padStart(2, "0")}
                            </span>
                          </h2>
                        </div>
                      </div>
                      <FeedControls
                        value={filters}
                        onChange={changeFilters}
                        monitors={data.monitors}
                        total={feed.total}
                        loading={feedLoading}
                      />
                      {feedError && (
                        <p role="alert" className="form-error">
                          {feedError}
                        </p>
                      )}
                      {list.length ? (
                        list.map((e, i) => (
                          <button
                            className={`signal-story ${i === 0 ? "lead-story" : ""}`}
                            key={e.id}
                            onClick={() => setDetail(e)}
                          >
                            <div className="story-index">
                              {String(i + 1).padStart(2, "0")}
                              <span>
                                {eventSources(e)
                                  .map((s) => s.toUpperCase())
                                  .join(" / ")}
                              </span>
                            </div>
                            <div className="story-body">
                              <div className="story-meta">
                                <span className={`badge ${e.credibility}`}>
                                  {credibilityNames[e.credibility]}
                                </span>
                                <span className="badge">
                                  重要性{" "}
                                  {
                                    importanceNames[
                                      e.details?.importance ?? "unassessed"
                                    ]
                                  }
                                </span>
                                <span>发现于 {dt(firstDiscovered(e))}</span>
                              </div>
                              <h3>{e.title}</h3>
                              <p>{e.summary}</p>
                              <div className="story-footer">
                                <span>
                                  {e.evidence.length} 条来源依据 · 相关性{" "}
                                  {e.relevance}
                                </span>
                                <span>
                                  查看情报 <Icon name="arrow" size={14} />
                                </span>
                              </div>
                            </div>
                            <div className="heat">
                              <b>{socialHeat(e)}</b>
                              <span title="X 点赞 + 转发 ×3 + 回复 ×2；不代表可信度">
                                X 互动
                              </span>
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="empty-feed" aria-busy={feedLoading}>
                          <Icon name="book" size={32} />
                          <h3>{feedLoading ? "正在读取情报…" : feedError ? "情报读取失败" : data.pipeline.displayed ? "当前筛选没有匹配情报" : "情报还在准备中"}</h3>
                          <p>{feedError ? "读取失败，请刷新列表重试。" : feedLoading ? "已有结果会显示在这里。" : data.pipeline.displayed
                            ? "可以清除筛选，查看全部时间的情报。"
                            : !data.monitors.length ? "先添加一个监控，后台采集和分析后，结果会出现在这里。"
                            : !data.health.worker ? "先启动后台，再更新情报；采集到的材料会经过 AI 分析。"
                            : "后台采集和 AI 分析需要一些时间，请查看上方更新进度。"}</p>
                          {!feedLoading && <button className="btn secondary" onClick={() => {
                            if (data.pipeline.displayed) changeFilters(feedFilterInput.parse({ hours: "all" }));
                            else if (!data.monitors.length) setForm(null);
                            else if (!data.health.worker) setWorkerHelp(true);
                            else setView("runs");
                          }}>{data.pipeline.displayed ? "查看全部情报" : !data.monitors.length ? "添加监控" : !data.health.worker ? "启动后台说明" : "查看更新记录"}</button>}
                        </div>
                      )}
                      {feed.total > feed.pageSize && (
                        <nav className="feed-pagination" aria-label="信号分页">
                          <button
                            className="btn secondary"
                            disabled={feedLoading || feed.page <= 1}
                            onClick={() => setPage(feed.page - 1)}
                          >
                            上一页
                          </button>
                          <span>
                            第 {feed.page} /{" "}
                            {Math.ceil(feed.total / feed.pageSize)} 页
                          </span>
                          <button
                            className="btn secondary"
                            disabled={
                              feedLoading ||
                              feed.page >= Math.ceil(feed.total / feed.pageSize)
                            }
                            onClick={() => setPage(feed.page + 1)}
                          >
                            下一页
                          </button>
                        </nav>
                      )}
                    </section>

                  </div>
                </>
              )}
              {view === "monitors" && (
                <>
                  <PageHeading
                    kicker="YOUR WATCHLIST"
                    title="把关注，交给持续监控。"
                    description="关键词追踪与领域热点发现，使用同一套有据可查的情报流程。"
                    action={
                      <button
                        className="btn primary"
                        onClick={() => setForm(null)}
                      >
                        <Icon name="plus" />
                        新建频道
                      </button>
                    }
                  />
                  <div className="monitor-grid">
                    {data.monitors.map((m) => monitorCard(m))}
                    <button
                      className="new-monitor-tile"
                      onClick={() => setForm(null)}
                    >
                      <Icon name="plus" size={30} />
                      <strong>
                        {data.monitors.length
                          ? "再添加一个关注领域"
                          : "创建第一个频道"}
                      </strong>
                      <span>
                        默认每 {data.settings.defaultInterval}{" "}
                        分钟，寻找新的变化。
                      </span>
                    </button>
                  </div>
                </>
              )}
              {view === "notifications" && (
                <>
                  <PageHeading
                    kicker="YOUR INBOX"
                    title="重要变化，已经抵达。"
                    description="站内提醒与邮件投递，各有清晰的状态记录。"
                    action={
                      <button
                        className="btn secondary"
                        disabled={!unread || Boolean(busy)}
                        onClick={() =>
                          void act(
                            "read-all",
                            () => api("notifications/all/read", "POST"),
                            "已全部标记为已读",
                          )
                        }
                      >
                        <Icon name="check" />
                        全部已读
                      </button>
                    }
                  />
                  {data.notifications.length ? (
                    <div className="notification-list">
                      {data.notifications.map((n) => (
                        <article
                          className={`notification-row ${!n.readAt ? "unread" : ""}`}
                          key={n.id}
                        >
                          <span
                            className={`dot ${!n.readAt ? "amber" : "subtle"}`}
                          />
                          <div>
                            <div className="row-between">
                              <span className="eyebrow">
                                {data.monitors.find((m) => m.id === n.monitorId)
                                  ?.name || "监控提醒"}
                              </span>
                              <time className="small muted">
                                {dt(n.createdAt)}
                              </time>
                            </div>
                            <button
                              className="notification-title"
                              onClick={() => {
                                const event = data.events.find(
                                  (e) => e.id === n.eventId,
                                );
                                if (event) setDetail(event);
                                if (!n.readAt)
                                  void act(
                                    n.id,
                                    () =>
                                      api(`notifications/${n.id}/read`, "POST"),
                                    "已标记为已读",
                                  );
                              }}
                            >
                              {n.title}
                              <Icon name="arrow" size={16} />
                            </button>
                            <p>{n.body}</p>
                            <div className="notification-footer">
                              <span
                                className={`badge ${n.emailStatus === "accepted" ? "supported" : "unverified"}`}
                              >
                                <Icon name="mail" size={12} />
                                {emailNames[n.emailStatus] || n.emailStatus}
                              </span>
                              {!n.readAt && (
                                <button
                                  onClick={() =>
                                    void act(
                                      n.id,
                                      () =>
                                        api(
                                          `notifications/${n.id}/read`,
                                          "POST",
                                        ),
                                      "已标记为已读",
                                    )
                                  }
                                >
                                  标记已读
                                </button>
                              )}
                              {["failed", "retry", "unconfigured"].includes(
                                n.emailStatus,
                              ) && (
                                <button
                                  disabled={Boolean(busy) || !data.health.email}
                                  onClick={() =>
                                    void act(
                                      n.id,
                                      () =>
                                        api(
                                          `notifications/${n.id}/retry`,
                                          "POST",
                                        ),
                                      "邮件已加入重试队列",
                                    )
                                  }
                                >
                                  重试邮件
                                </button>
                              )}
                            </div>
                            {n.lastError && (
                              <p className="error small">{n.lastError}</p>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="此刻，没有待处理的提醒。"
                      text="符合提醒条件的新事件出现后，会保存在这里，并通过邮件发送。"
                      icon="bell"
                    />
                  )}
                </>
              )}
              {view === "runs" && (
                <>
                  <PageHeading
                    kicker="COLLECTION JOURNAL"
                    title="更新记录"
                    description="查看采集与 AI 分析进度、原始材料和失败原因。分析完成的情报在首页阅读。"
                  />
                  <PipelinePanel data={data} reload={reload} />
                  {data.rawArticles.length > 0 && (
                    <details className="source-diagnostics raw-records">
                      <summary>查看原始材料（尚未核实）</summary>
                      <p className="small muted">原始内容供排查采集情况。请在首页阅读经过分析的情报。</p>
                      {data.rawArticles.map((a) => <a className="raw-story" key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
                        <span className="source-pill">{sourceNames[a.source]}</span>
                        <div><strong>{a.title}</strong><span>{a.author} · {dt(a.publishedAt)}</span></div>
                        <Icon name="external" size={14} />
                      </a>)}
                    </details>
                  )}
                  <section className="source-diagnostics">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">SOURCE HEALTH</span>
                        <h2>信息源与处理进度</h2>
                      </div>
                      <span className="small muted">
                        Google / Bing：{data.searchUsage.day}/
                        {data.settings.searchDailyLimit} 次今日调用
                      </span>
                    </div>
                    <div className="source-stat-grid">
                      {data.sourceStats.map((p) => (
                        <div className="source-stat" key={p.source}>
                          <strong>{sourceNames[p.source]}</strong>
                          <span>
                            已发现 <b>{p.collected}</b>
                          </span>
                          <span>
                            待分析 <b>{p.pending}</b>
                          </span>
                          <span>
                            已过滤任务 <b>{p.filtered}</b>
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="small muted">
                      同文跨渠道发现只保留一份证据，渠道计数可重叠。待分析和过滤按频道任务计数；网页调用量为本机保守计数，账单以供应商为准。
                    </p>
                  </section>
                  <div className="journal-status">
                    <span
                      className={`dot ${data.health.worker ? "green" : "amber"}`}
                    />
                    {data.health.worker
                      ? "后台任务在线"
                      : "后台任务离线，请运行 npm run worker"}
                    <span>最近心跳：{dt(data.health.workerAt)}</span>
                  </div>
                  {data.runs.length ? (
                    <div className="run-list">
                      {data.runs.map((r) => {
                        const presentation = runPresentation(r);
                        return (
                          <article className="run-card" key={r.id}>
                            <div className="row-between">
                              <div>
                                <span className="eyebrow">
                                  {dt(r.startedAt)}
                                </span>
                                <h3>{r.monitorName}</h3>
                              </div>
                              <span className={`badge ${presentation.badge}`}>
                                {presentation.label}
                              </span>
                            </div>
                            <div className="run-counts">
                              <span>
                                已分析 <b>{r.analyzedCount}</b>
                              </span>
                              <span>
                                事件 <b>{r.eventCount}</b>
                              </span>
                              <span>
                                AI tokens <b>{r.tokens}</b>
                              </span>
                              <span>
                                耗时{" "}
                                <b>
                                  {r.finishedAt
                                    ? `${Math.round((r.finishedAt - r.startedAt) / 1000)}s`
                                    : "进行中"}
                                </b>
                              </span>
                            </div>
                            {r.reports.map((p) => (
                              <div className="source-report" key={p.source}>
                                <span
                                  className={`dot ${p.status === "ok" ? "green" : sourceHasError(p) ? "red" : "amber"}`}
                                />
                                <strong>{sourceNames[p.source]}</strong>
                                <span>
                                  {p.count} 条合格候选 / {p.requests} 次请求
                                </span>
                                <p>
                                  {p.message}
                                  {p.filteredCount
                                    ? ` · 过滤 ${p.filteredCount} 条（${Object.entries(
                                        p.filterReasons || {},
                                      )
                                        .map(([k, v]) => `${k} ${v}`)
                                        .join(" / ")}）`
                                    : ""}
                                  {typeof p.analyzedCount === "number"
                                    ? ` · 本轮分析 ${p.analyzedCount} 条 / 原文 ${p.fullCount || 0} 篇`
                                    : p.fullCount
                                      ? ` · 本轮分析原文 ${p.fullCount} 篇`
                                      : ""}
                                </p>
                              </div>
                            ))}
                            {r.error && (
                              <p className="error" role="status">
                                {r.error}
                              </p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      title="第一轮扫描，尚未开始。"
                      text="创建并启用频道，或点击“立即扫描”，后台会在这里留下记录。"
                      icon="activity"
                    />
                  )}
                </>
              )}
              {view === "settings" && (
                <>
                  <PageHeading
                    kicker="CONNECTIONS & PREFERENCES"
                    title="连接信号的源头。"
                    description="密钥保留在本机服务端。这里展示配置状态，并提供真实连接测试。"
                  />
                  <div className="settings-layout">
                    <section>
                      <div className="settings-section">
                        <h2>
                          服务连接<span className="section-count">/05</span>
                        </h2>
                        {[
                          {
                            id: "x",
                            title: "X / Twitter",
                            subtitle: "twitterapi.io · 关键词检索与互动数据",
                            ok: data.health.x,
                            icon: "signal",
                            key: "TWITTERAPI_API_KEY",
                            test: "测试 X 连接",
                          },
                          {
                            id: "ai",
                            title: "AI 分析",
                            subtitle: "OpenRouter · 语义理解、事件聚合与证据判断",
                            ok: data.health.ai,
                            icon: "activity",
                            key: "OPENROUTER_API_KEY / AI_MODEL",
                            test: "测试 AI 连接",
                          },
                          {
                            id: "google",
                            title: "Google 网页发现",
                            subtitle:
                              "SerpAPI · 发现公开原文，受频率与预算限制",
                            ok: data.health.search,
                            icon: "search",
                            key: "SERPAPI_API_KEY",
                            test: "测试 Google",
                          },
                          {
                            id: "bing",
                            title: "Bing 网页发现",
                            subtitle: "SerpAPI · 使用相同 Key，独立检索并去重",
                            ok: data.health.search,
                            icon: "search",
                            key: "SERPAPI_API_KEY",
                            test: "测试 Bing",
                          },
                          {
                            id: "email",
                            title: "邮件通知",
                            subtitle: "SMTP · 后台投递，不依赖网页打开",
                            ok: data.health.email,
                            icon: "mail",
                            key: "SMTP_HOST / SMTP_USER / SMTP_PASSWORD / EMAIL_FROM / EMAIL_TO",
                            test: "发送测试邮件",
                          },
                        ].map((c) => (
                          <div className="connection-row" key={c.id}>
                            <span
                              className={`connection-icon ${c.ok ? "ready" : ""}`}
                            >
                              <Icon name={c.icon} size={23} />
                            </span>
                            <div className="connection-copy">
                              <h3>
                                {c.title}
                                <span
                                  className={`badge ${c.ok ? "supported" : "unverified"}`}
                                >
                                  {c.ok ? "已配置 · 待测试" : "未配置"}
                                </span>
                              </h3>
                              <p>{c.subtitle}</p>
                              <span className="config-key">{c.key}</span>
                            </div>
                            <button
                              className="btn secondary"
                              disabled={Boolean(busy)}
                              onClick={() =>
                                void act(
                                  c.id,
                                  () =>
                                    api<{ message: string }>(
                                      `connections/${c.id}`,
                                      "POST",
                                    ).then((r) => {
                                      setToast(r.message);
                                      return r;
                                    }),
                                  "连接测试已完成，请确认实际结果",
                                )
                              }
                            >
                              {busy === c.id ? "测试中…" : c.test}
                              <Icon name="arrow" size={14} />
                            </button>
                          </div>
                        ))}
                        <p className="small muted">
                          X、AI 与网页搜索
                          测试会发出真实请求并消耗账户额度。测试邮件会发送至配置的收件地址。SMTP
                          已接受不等同于最终送达。
                        </p>
                      </div>
                      <form
                        className="settings-section"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(
                            "settings",
                            () =>
                              api("settings", "PUT", draft || data.settings),
                            "工作台设置已保存",
                          );
                        }}
                      >
                        <h2>工作台偏好</h2>
                        <div className="settings-fields">
                          <label>
                            新频道默认扫描间隔
                            <select
                              value={(draft || data.settings).defaultInterval}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  defaultInterval: Number(e.target.value),
                                })
                              }
                            >
                              {[5, 15, 30, 60, 120, 360, 1440].map((t) => (
                                <option key={t} value={t}>
                                  {t} 分钟
                                </option>
                              ))}
                            </select>
                            <small>已有频道在编辑窗口中单独调整。</small>
                          </label>
                          <label>
                            OpenRouter 模型
                            <input
                              value={(draft || data.settings).model}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  model: e.target.value,
                                })
                              }
                              placeholder="填写令牌分组可用模型"
                              maxLength={150}
                            />
                            <small>
                              填写 OpenRouter 模型页面中的完整模型
                              ID，不沿用其他平台的模型名称。
                            </small>
                          </label>
                          <label>
                            OpenRouter 接口地址
                            <input
                              value={(draft || data.settings).baseUrl}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  baseUrl: e.target.value,
                                })
                              }
                              required
                            />
                            <small>
                              接口地址 https://openrouter.ai/api/v1；按所选模型
                              支持的输出模式测试连接。
                            </small>
                          </label>
                          <label>
                            AI 输出模式
                            <select
                              value={(draft || data.settings).outputMode}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  outputMode: e.target
                                    .value as Settings["outputMode"],
                                })
                              }
                            >
                              <option value="json_schema">
                                严格 JSON Schema
                              </option>
                              <option value="json_object">JSON 对象模式</option>
                              <option value="text">提示词 JSON 模式</option>
                            </select>
                            <small>
                              按实际模型能力选择，所有模式均经过本地结构与引用校验。
                            </small>
                          </label>
                          <label>
                            每次 X 采集最大页数
                            <input
                              type="number"
                              min="1"
                              max="10"
                              value={(draft || data.settings).maxPages}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  maxPages: Number(e.target.value),
                                })
                              }
                            />
                            <small>达到上限后保留游标，下轮继续。</small>
                          </label>
                          <label>
                            候选初筛批次（实际最多 5 条）
                            <input
                              type="number"
                              min="1"
                              max="30"
                              value={(draft || data.settings).batchSize}
                              onChange={(e) =>
                                setDraft({
                                  ...(draft || data.settings),
                                  batchSize: Number(e.target.value),
                                })
                              }
                            />
                            <small>按输入长度切分小批次，剩余内容保留。</small>
                          </label>
                        </div>
                        <div className="search-budget">
                          <h3>搜索与原文预算</h3>
                          <p className="small muted">
                            今日 {data.searchUsage.day} 次 / 本月{" "}
                            {data.searchUsage.month} 次 / 今日事件核验{" "}
                            {data.searchUsage.verification}{" "}
                            次。达到任一上限会暂停搜索；填写 0 可关闭对应功能。
                          </p>
                          <div className="settings-fields">
                            {[
                              {
                                key: "searchDailyLimit",
                                label: "每日搜索请求上限",
                                max: 10000,
                              },
                              {
                                key: "searchMonthlyLimit",
                                label: "每月搜索请求上限",
                                max: 100000,
                              },
                              {
                                key: "verificationDailyLimit",
                                label: "每日事件核验上限",
                                max: 1000,
                              },
                              {
                                key: "bodyFetchLimit",
                                label: "每轮原文抓取上限",
                                max: 20,
                              },
                            ].map((f) => (
                              <label key={f.key}>
                                {f.label}
                                <input
                                  type="number"
                                  min="0"
                                  max={f.max}
                                  value={
                                    (draft || data.settings)[
                                      f.key as keyof Pick<
                                        Settings,
                                        | "searchDailyLimit"
                                        | "searchMonthlyLimit"
                                        | "verificationDailyLimit"
                                        | "bodyFetchLimit"
                                      >
                                    ]
                                  }
                                  onChange={(e) =>
                                    setDraft({
                                      ...(draft || data.settings),
                                      [f.key]: Number(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <p className="small muted">
                            推荐 30 次/天、900 次/月、6
                            次事件核验/天。新增网页来源需在频道内勾选；已有频道保持原有来源。
                          </p>
                        </div>
                        <AnalysisSettings
                          value={draft || data.settings}
                          onChange={setDraft}
                        />
                        <section className="x-budget-summary">
                          <h3>X 请求预算</h3>
                          <p>
                            今日 {data.xUsage.day}/
                            {data.settings.xDailyRequestLimit} · 本月{" "}
                            {data.xUsage.month}/
                            {data.settings.xMonthlyRequestLimit}
                          </p>
                          <p className="small muted">
                            账号、关键词、互动复查、根帖及连接测试共用预算；失败请求也计数。预算不足会保留采集进度。
                          </p>
                          <div className="settings-fields">
                            {(
                              [
                                {
                                  key: "xDailyRequestLimit",
                                  label: "每日请求上限",
                                  max: 10000,
                                  min: 0,
                                },
                                {
                                  key: "xMonthlyRequestLimit",
                                  label: "每月请求上限",
                                  max: 100000,
                                  min: 0,
                                },
                                {
                                  key: "xRequestsPerScan",
                                  label: "每频道单轮请求上限",
                                  max: 20,
                                  min: 1,
                                },
                              ] as const
                            ).map((f) => (
                              <label key={f.key}>
                                {f.label}
                                <input
                                  type="number"
                                  min={f.min}
                                  max={f.max}
                                  value={(draft || data.settings)[f.key]}
                                  onChange={(e) =>
                                    setDraft({
                                      ...(draft || data.settings),
                                      [f.key]: Number(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </section>
                        <XAccountEditor
                          value={(draft || data.settings).xAccounts}
                          onChange={(xAccounts) =>
                            setDraft({ ...(draft || data.settings), xAccounts })
                          }
                        />
                        <PublisherEditor
                          value={(draft || data.settings).publishers}
                          onChange={(publishers) =>
                            setDraft({
                              ...(draft || data.settings),
                              publishers,
                            })
                          }
                        />
                        <button
                          className="btn primary"
                          disabled={busy === "settings"}
                        >
                          {busy === "settings" ? "保存中…" : "保存设置"}
                          <Icon name="check" size={16} />
                        </button>
                      </form>
                    </section>
                    <aside className="config-guide">
                      <span className="eyebrow">
                        A SMALL SETUP, A BIG DIFFERENCE.
                      </span>
                      <h2>
                        三步，让情报台
                        <br />
                        开始工作。
                      </h2>
                      <ol>
                        <li>
                          <strong>填写本机配置</strong>
                          <p>
                            在项目根目录的 <code>.env.local</code> 中填写
                            X、OpenRouter 及可选 SerpAPI Key、SMTP
                            信息与收件地址。
                          </p>
                        </li>
                        <li>
                          <strong>重启服务与后台</strong>
                          <p>
                            配置更新后重启 Web 和
                            worker，让两个进程读取相同的配置。
                          </p>
                        </li>
                        <li>
                          <strong>测试连接，创建频道</strong>
                          <p>
                            确认 X、AI
                            和邮件连接正常。创建关注领域，开始持续收集。
                          </p>
                        </li>
                      </ol>
                      <div className="worker-guide">
                        <Icon name="activity" />
                        <div>
                          <strong>
                            {data.health.worker
                              ? "后台进程在线"
                              : "后台进程离线"}
                          </strong>
                          <p>
                            <code>npm run worker</code>
                          </p>
                        </div>
                      </div>
                      <p className="small muted">
                        电脑休眠或后台停止时，定时扫描也会停止。
                      </p>
                    </aside>
                  </div>
                </>
              )}
              <footer className="page-footer">
                <span>
                  SIGNAL DESK <span className="footer-slash">/</span>{" "}
                  为值得关注的变化留一个位置。
                </span>
                <span>BUILT FOR CURIOSITY.</span>
              </footer>
            </div>
          )
        )}
      </main>
      {workerHelp && <Modal title="启动后台，让情报持续更新" onClose={() => setWorkerHelp(false)}>
        <div className="worker-help">
          <p>网页负责展示；后台负责采集、AI 分析和提醒。后台停止时，已有情报仍可阅读。</p>
          <ol><li>在项目目录打开终端。</li><li>运行 <code>rtk proxy npm run worker</code>，保持终端运行。</li><li>回到首页，状态变为“后台在线”后点击“更新情报”。</li></ol>
          <p className="small muted">保持终端运行，后台才会持续更新。更新和分析受已配置的调用预算限制。</p>
          <button className="btn secondary" onClick={() => { setWorkerHelp(false); setView("settings"); }}>查看连接配置</button>
        </div>
      </Modal>}
      {data && form !== undefined && (
        <MonitorForm
          monitor={form}
          defaults={data.settings}
          onClose={() => setForm(undefined)}
          onSaved={async () => {
            await reload();
            setToast(form ? "频道已更新" : "监控已创建，采集和分析后的结果会显示在首页。");
            if (!form) { setView("overview"); changeFilters(feedFilterInput.parse({})); }
          }}
        />
      )}
      {detail && <EventDetail event={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
function PageHeading({
  kicker,
  title,
  description,
  action,
}: {
  kicker: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <span className="eyebrow">
          <span className="tiny-square" />
          {kicker}
        </span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </section>
  );
}
function Empty({
  title,
  text,
  icon,
}: {
  title: string;
  text: string;
  icon: string;
}) {
  return (
    <div className="empty-page">
      <Icon name={icon} size={42} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
