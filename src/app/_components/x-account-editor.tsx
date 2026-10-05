"use client";
import type { XAccount } from "@/shared/types";

export function XAccountEditor({
  value,
  onChange,
}: {
  value: XAccount[];
  onChange: (v: XAccount[]) => void;
}) {
  const update = (index: number, patch: Partial<XAccount>) =>
    onChange(value.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  return (
    <details className="publisher-editor x-account-editor">
      <summary>
        AI 编程与 Agent · 精选 X 账号{" "}
        <span>
          {value.filter((a) => a.active).length}/{value.length} 启用
        </span>
      </summary>
      <p className="small muted">
        频道开启“监控精选账号”后生效。精选账号不设最低互动量，仍需 AI
        判断相关性、新信息与证据。账号类型是人工分类，蓝 V
        不作为可信依据；编辑后保存设置。
      </p>
      {value.map((a, i) => (
        <div className="publisher-row" key={i}>
          <div className="account-heading">
            <a
              href={`https://x.com/${a.handle}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              @{a.handle || "新账号"}
            </a>
            <label className="check">
              <input
                type="checkbox"
                checked={a.active}
                onChange={(e) => update(i, { active: e.target.checked })}
              />
              启用监控
            </label>
          </div>
          <div className="settings-fields">
            <label>
              X 用户名（不含 @）
              <input
                value={a.handle}
                maxLength={15}
                pattern="[a-zA-Z0-9_]{1,15}"
                onChange={(e) =>
                  update(i, { handle: e.target.value.replace(/^@/, "") })
                }
              />
            </label>
            <label>
              名称
              <input
                value={a.name}
                maxLength={80}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label>
              人工分类
              <select
                value={a.kind}
                onChange={(e) =>
                  update(i, { kind: e.target.value as XAccount["kind"] })
                }
              >
                <option value="official">官方产品账号</option>
                <option value="expert">开发者 / 技术分析</option>
              </select>
            </label>
            <label>
              关注内容
              <input
                value={a.focus}
                maxLength={200}
                onChange={(e) => update(i, { focus: e.target.value })}
              />
            </label>
            <label className="full-span">
              身份核对依据
              <input
                type="url"
                value={a.proofUrl}
                onChange={(e) => update(i, { proofUrl: e.target.value })}
              />
            </label>
          </div>
          <a
            className="small"
            href={a.proofUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看身份依据 ↗
          </a>
          <button
            type="button"
            className="text-link"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            移出监控名单
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn secondary"
        disabled={value.length >= 50}
        onClick={() =>
          onChange([
            ...value,
            {
              handle: "",
              name: "",
              kind: "expert",
              focus: "AI 编程与 Agent",
              proofUrl: "",
              active: true,
            },
          ])
        }
      >
        添加精选账号
      </button>
    </details>
  );
}
