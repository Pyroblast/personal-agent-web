import React, { useState } from "react";
import { CheckHistory } from "./CheckHistory";
export const time = (n: number | undefined | null) =>
  n
    ? new Date(n).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Shanghai",
      })
    : "尚无";
const labels: Record<string, string> = {
  running: "检查中",
  delivered: "已发到对话",
  silent: "模型决定保持安静",
  skipped: "策略跳过",
  failed: "检查失败",
  cancelled: "已取消旧检查",
  interrupted: "运行中断",
};
export function HeartbeatPanel({
  data,
  busy,
  act,
  api,
}: {
  data: any;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  api: (path: string, data?: unknown) => Promise<any>;
}) {
  const [draft, setDraft] = useState<any>(null);
  if (!data) return <p>正在连接心跳服务…</p>;
  const p = data.policy,
    edit = draft || p,
    latest = data.checks[0],
    last = data.deliveries
      .filter((d: any) => d.obligation !== "committed")
      .at(-1);
  const patch = (value: any) =>
    act(() => api("heartbeat", { patch: value, revision: p.revision }));
  const paused = p.pausedUntil > data.serverTime;
  const running = data.checks.some((c: any) => c.status === "running");
  return (
    <section className="care-panel">
      <div className="care-intro">
        <span className={"care-dot " + (p.enabled && !paused ? "on" : "")} />
        <div>
          <h2>
            {!p.enabled
              ? "主动关心已关闭"
              : paused
                ? "今天先安静陪伴"
                : running
                  ? "正在看看有没有值得联系你的事"
                  : "主动关心已开启"}
          </h2>
          <p>
            每 30 分钟结合记忆、对话和目标进展检查一次。有值得说的再联系你，消息仍在同一段对话里。
          </p>
        </div>
      </div>
      <div className="care-buttons">
        <button disabled={busy} onClick={() => patch({ enabled: !p.enabled })}>
          {p.enabled ? "关闭主动关心" : "开启主动关心"}
        </button>
        {p.enabled && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                patch({
                  pausedUntil: paused
                    ? null
                    : new Date(
                        new Date(data.serverTime + 8 * 3600000)
                          .toISOString()
                          .slice(0, 10) + "T00:00:00+08:00",
                      ).getTime() + 86400000,
                })
              }
            >
              {paused ? "恢复关心" : "今天先别打扰"}
            </button>
            <button
              disabled={busy || running || data.busyWithConversation}
              onClick={() => act(() => api("heartbeat/check", {}))}
            >
              {running
                ? "正在检查…"
                : data.busyWithConversation
                  ? "当前对话优先"
                  : "现在检查一次"}
            </button>
          </>
        )}
      </div>
      <p className="care-hint">
        {data.gateReason || "检查时由 DeepSeek 判断是否值得联系。"}{" "}
        手动检查同样遵守时段、间隔和预算。
      </p>
      <div className="care-stats">
        <div>
          <small>上次检查</small>
          <strong>{time(latest?.created_at)}</strong>
          <span>{latest ? labels[latest.status] : "还未执行"}</span>
        </div>
        <div>
          <small>下次检查</small>
          <strong>{p.enabled ? time(data.nextAt) : "关闭期间不执行"}</strong>
          <span>
            {data.busyWithConversation && data.nextAt <= data.serverTime
              ? "等待当前对话完成"
              : "后台每 30 分钟唤醒"}
          </span>
        </div>
        <div>
          <small>上次主动联系</small>
          <strong>{time(last?.created_at)}</strong>
          <span>
            今日普通消息 {data.counts.contacts} / {p.dailyLimit} 条
          </span>
        </div>
      </div>
      <div className="care-section">
        <h3>联系偏好</h3>
        <p>
          也可以在聊天中说“今天别主动联系我”“暂停练琴话题”或“恢复主动关心”。普通消息额度由关心和目标进展共用；明确提醒与约定成果不占用此额度。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { revision, ...values } = draft || {};
            if (!draft) return;
            act(async () => {
              await api("heartbeat", { patch: values, revision });
              setDraft(null);
            });
          }}
        >
          <div className="care-fields">
            {(
              [
                ["startHour", "开始联系（小时）", 0, 23],
                ["endHour", "结束联系（小时）", 1, 24],
                ["dailyLimit", "每天最多消息", 1, 6],
                ["minGapMinutes", "两次联系间隔（分钟）", 30, 1440],
                ["topicCooldownHours", "同话题冷却（小时）", 1, 168],
                ["modelDailyLimit", "每天后台模型上限", 1, 28],
                ["searchDailyLimit", "关心每天搜索 / 阅读上限", 0, 6],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  required
                  min={min}
                  max={max}
                  value={edit[key] ?? p[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      revision: draft?.revision ?? p.revision,
                      [key]: Number(e.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <label className="care-switch">
            <input
              type="checkbox"
              checked={edit.searchEnabled ?? p.searchEnabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  revision: draft?.revision ?? p.revision,
                  searchEnabled: e.target.checked,
                })
              }
            />
            <span>
              允许主动关心时搜索公开网页
              <small>
                默认关闭；开启后会额外调用联网服务，每次最多一次搜索和一次阅读。
              </small>
            </span>
          </label>
          <p className="care-hint">
            时间按北京时间（Asia/Shanghai）。后台检查与搜索会使用已有的 DeepSeek
            API 配置。
          </p>
          {draft && (
            <div className="care-buttons">
              <button type="submit" disabled={busy}>
                保存设置
              </button>
              <button type="button" onClick={() => setDraft(null)}>
                取消编辑
              </button>
            </div>
          )}
        </form>
      </div>
      <div className="care-section">
        <h3>话题管理</h3>
        <p>未回应的话题会等待反馈，不会每半小时重复追问。</p>
        <div className="topic-list">
          {data.topics.map((t: any) => {
            const muted =
              Object.hasOwn(p.mutedTopics, t.id) &&
              (p.mutedTopics[t.id] === null ||
                p.mutedTopics[t.id] > data.serverTime);
            return (
              <div key={t.id}>
                <span>
                  {t.label}
                  <small>{t.reason || "可根据记忆判断"}</small>
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    const mutedTopics = Object.fromEntries(
                      Object.entries(p.mutedTopics).filter(
                        ([, v]) => v === null || Number(v) > data.serverTime,
                      ),
                    );
                    if (muted) delete mutedTopics[t.id];
                    else mutedTopics[t.id] = null;
                    void patch({ mutedTopics });
                  }}
                >
                  {muted ? "恢复话题" : "暂停话题"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <CheckHistory data={data} api={api} />
      <p className="care-hint">
        后台服务运行且 Mac
        保持唤醒时有效。关闭网页不影响后台；睡眠、关机后的漏跑合并为一次检查，过时结果不会补发。
      </p>
    </section>
  );
}
