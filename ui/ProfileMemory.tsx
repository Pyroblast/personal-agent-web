import React, { useState } from "react";
import { time } from "./Heartbeat";
type Props = {
  data: any;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  api: (path: string, data?: unknown) => Promise<any>;
};
export function ProfilePanel({ data, busy, act, api }: Props) {
  const [draft, setDraft] = useState<any>(null),
    [saved, setSaved] = useState(false);
  if (!data) return <p>正在读取助理设置…</p>;
  const d = draft || data;
  const change = (patch: any) => {
    setDraft({ ...d, ...patch });
    setSaved(false);
  };
  return (
    <section className="care-panel profile-panel">
      <h2>同一个助理，一致的交流方式</h2>
      <p>聊天和主动关心共用这些设置。你也可以在聊天里说“以后简短直接一点”。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api("profile", {
              patch: {
                name: d.name,
                verbosity: d.verbosity,
                tone: d.tone,
                challenge: d.challenge,
              },
              revision: d.revision,
            });
            setDraft(null);
            setSaved(true);
          });
        }}
      >
        <label>
          助理名称
          <input
            maxLength={40}
            required
            value={d.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <div className="fields">
          <label>
            回答长度
            <select
              value={d.verbosity}
              onChange={(e) => change({ verbosity: e.target.value })}
            >
              <option value="concise">简短</option>
              <option value="balanced">适中</option>
              <option value="detailed">详细</option>
            </select>
          </label>
          <label>
            交流语气
            <select
              value={d.tone}
              onChange={(e) => change({ tone: e.target.value })}
            >
              <option value="warm">温和自然</option>
              <option value="direct">直接清楚</option>
            </select>
          </label>
        </div>
        <label>
          建议方式
          <select
            value={d.challenge}
            onChange={(e) => change({ challenge: e.target.value })}
          >
            <option value="balanced">有必要时提出不同意见</option>
            <option value="candid">主动指出问题，坦诚提出不同意见</option>
          </select>
        </label>
        {draft && draft.revision !== data.revision && (
          <p role="alert">设置已在别处更新。请放弃草稿后重新编辑。</p>
        )}
        <div className="care-buttons">
          <button disabled={busy || !draft || draft.revision !== data.revision}>
            保存助理设置
          </button>
          {draft && (
            <button type="button" onClick={() => setDraft(null)}>
              放弃草稿
            </button>
          )}
        </div>
        {saved && <p role="status">已保存，后续聊天与主动关心将使用新设置。</p>}
      </form>
      <details>
        <summary>共同原则与能力边界</summary>
        <p>
          诚实、克制、有帮助；区分事实、推断和建议；不从沉默推断你的状态。先完成动作，再说明结果。
        </p>
        <p>
          这些设置只改变交流方式。主动联系的时段和频率仍在“主动关心”管理，工具权限不会随语气设置改变。
        </p>
      </details>
    </section>
  );
}
export function UpkeepPanel({ data, busy, act, api }: Props) {
  const [selection, setSelection] = useState<Record<string, string>>({});
  if (!data) return null;
  const running = data.checks.some((c: any) => c.status === "running"),
    p = data.policy,
    c = data.current;
  const labels: Record<string, string> = {
    running: "整理中",
    succeeded: "整理完成",
    failed: "整理失败",
    cancelled: "旧整理已取消",
    interrupted: "整理中断",
  };
  return (
    <section className="upkeep-panel">
      <h2>记忆整理</h2>
      <p>
        有新信息且交流空闲后整理，每天最多 2
        次。整理不会另发聊天，也不会自行决定冲突事实。
      </p>
      <div className="care-buttons">
        <button
          disabled={busy}
          onClick={() =>
            act(() =>
              api("upkeep", { enabled: !p.enabled, revision: p.revision }),
            )
          }
        >
          {p.enabled ? "关闭自动整理" : "开启自动整理"}
        </button>
        <button
          disabled={
            busy || running || !p.enabled || data.usedToday >= data.dailyLimit
          }
          onClick={() => act(() => api("upkeep/check", {}))}
        >
          {running ? "正在整理…" : "现在整理一次"}
        </button>
      </div>
      <p className="muted">
        {p.enabled ? "自动整理已开启" : "自动整理已关闭"} · 今日已运行{" "}
        {data.usedToday}/{data.dailyLimit} 次
        {p.enabled ? " · 下次条件检查 " + time(data.nextAt) : ""}
      </p>
      <small>
        条件检查不等于调用模型。自动触发需 3 次新记忆变更，或 6
        条新交流且记忆有变化，并空闲 10 分钟；自动间隔至少 30 分钟。使用
        DeepSeek 可能产生费用。
      </small>
      {data.expiredCount > 0 && (
        <p>{data.expiredCount} 条临时记忆已过期，不再用于个性化。</p>
      )}
      {c?.stale ? (
        <p>记忆已更新，旧概览已停用，等待下次整理。</p>
      ) : (
        c && (
          <>
            <h3>当前记忆概览</h3>
            <ul>
              {c.overview.map((m: any) => (
                <li key={m.id}>{m.content}</li>
              ))}
            </ul>
            {!c.overview.length && <p>本次没有选取概览。</p>}
            {c.candidates.map((g: any) => {
              const key = c.id + ":" + g.index;
              return (
                <article className="memory" key={key}>
                  <h3>
                    {g.kind === "duplicate"
                      ? "可能重复，是否合并？"
                      : "信息可能冲突，由你决定"}
                  </h3>
                  <p>
                    {g.kind === "duplicate"
                      ? "确认后保留所选表述，并关联各条来源。"
                      : "保留所选事实，其他项不再用于个性化。"}
                  </p>
                  {g.memories.map((m: any) => (
                    <label className="upkeep-choice" key={m.id}>
                      <input
                        type="radio"
                        name={key}
                        checked={selection[key] === m.id}
                        onChange={() =>
                          setSelection({ ...selection, [key]: m.id })
                        }
                      />
                      <span>
                        {m.content}
                        <small>
                          记录于 {time(m.updated_at)} ·{" "}
                          {m.source_message_id ? "来自对话" : "手动维护"}
                        </small>
                      </span>
                    </label>
                  ))}
                  <div className="care-buttons">
                    <button
                      disabled={busy || !selection[key]}
                      onClick={() =>
                        act(() =>
                          api("upkeep/resolve", {
                            checkId: c.id,
                            index: g.index,
                            keepId: selection[key],
                          }),
                        )
                      }
                    >
                      确认保留所选
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api("upkeep/resolve", {
                            checkId: c.id,
                            index: g.index,
                            keepId: null,
                          }),
                        )
                      }
                    >
                      保留全部，不合并
                    </button>
                  </div>
                </article>
              );
            })}
            {!c.candidates.length && <p>本次没有待确认的重复或冲突。</p>}
          </>
        )
      )}
      {!c && <p>尚未生成概览。即时记忆仍正常保存与使用。</p>}
      {data.checks.length > 0 && (
        <details open={running}>
          <summary>最近整理记录</summary>
          {data.checks.map((r: any) => (
            <p key={r.id}>
              {time(r.created_at)} · {labels[r.status] || r.status}
              <br />
              <small>{r.reason}</small>
              {r.usage && (
                <small>
                  {" "}
                  · Token 用量 {JSON.parse(r.usage).totalTokens || 0}
                </small>
              )}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
