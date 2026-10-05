"use client";
import { BentoGridItem } from "@/components/ui/bento-grid";
import type { Dashboard } from "@/shared/types";
import { updateStatus } from "@/shared/update-status";

export function HomeStatus({ data, onDetails, onHelp }: {
  data: Dashboard;
  onDetails: () => void;
  onHelp: () => void;
}) {
  const status = updateStatus(data);
  return (
    <section aria-label="后台更新进度" className="home-status">
      <BentoGridItem
        className={`update-card ${status.tone}`}
        title={
          <div className="update-title-row">
            <div className="update-status-line" role="status" aria-atomic="true">
              <span className="update-dot" aria-hidden="true" />
              <strong>{status.title}</strong>
            </div>
            <button className="text-link" onClick={data.health.worker ? onDetails : onHelp}>
              {data.health.worker ? "查看更新记录" : "如何启动后台"}
            </button>
          </div>
        }
        header={<p className="update-description">{status.description}</p>}
        description={
          status.tone === "active" && <div className="update-bottom">
            <ol className="update-stages" aria-label="更新流程">
              {["采集内容", "AI 分析", "情报展示"].map((label, i) => (
                <li key={label} className={status.stage === i ? "current" : ""}
                  aria-current={status.stage === i ? "step" : undefined}>
                  <span>{i + 1}</span>{label}
                </li>
              ))}
            </ol>
          </div>
        }
      />
    </section>
  );
}
