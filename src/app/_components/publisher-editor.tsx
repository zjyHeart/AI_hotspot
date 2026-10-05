"use client";
import { ListInput } from "./list-input";
import type { Publisher } from "@/shared/types";

export function PublisherEditor({
  value,
  onChange,
}: {
  value: Publisher[];
  onChange: (value: Publisher[]) => void;
}) {
  const update = (index: number, patch: Partial<Publisher>) =>
    onChange(value.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <details className="publisher-editor">
      <summary>
        管理已确认的发布者 <span>{value.length} 个</span>
      </summary>
      <p className="small muted">
        只有你已确认的官网、账号与组织才应加入。来源身份有依据，不代表其中每项宣传都已独立验证。更改后点击下方“保存设置”。
      </p>
      {value.map((p, i) => (
        <div className="publisher-row" key={p.id}>
          <strong>{p.name || "新发布者"}</strong>
          <div className="settings-fields">
            <label>
              机构或项目名称
              <input
                value={p.name}
                maxLength={80}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label>
              官网域名
              <ListInput
                value={p.domains}
                placeholder="example.com（不含 https://）"
                onChange={(parts) => update(i, { domains: parts })}
              />
            </label>
            <label>
              X 官方账号
              <ListInput
                value={p.xAccounts}
                placeholder="多个账号用逗号分隔"
                onChange={(parts) => update(i, { xAccounts: parts })}
              />
            </label>
            <label>
              GitHub 官方组织
              <ListInput
                value={p.githubOwners}
                placeholder="例如 vercel"
                onChange={(parts) => update(i, { githubOwners: parts })}
              />
            </label>
            <label className="full-span">
              身份核对依据
              <input
                type="url"
                value={p.proofUrl}
                placeholder="能核对官网与账号关系的 HTTPS 链接"
                onChange={(e) => update(i, { proofUrl: e.target.value })}
              />
            </label>
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            移出可信目录
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn secondary"
        onClick={() =>
          onChange([
            ...value,
            {
              id: "custom-" + Date.now(),
              name: "",
              domains: [],
              xAccounts: [],
              githubOwners: [],
              proofUrl: "",
            },
          ])
        }
      >
        添加已确认来源
      </button>
    </details>
  );
}
