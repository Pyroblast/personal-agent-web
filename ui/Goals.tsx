import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./goals.css";

const labels: Record<string, string> = {
  draft: "待确认",
  active: "进行中",
  waiting: "等待处理",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  scheduled: "已安排",
  running: "正在处理",
  failed: "未完成",
  expired: "已过期",
  unknown: "待核对",
  interrupted: "已中断",
};
const modes: Record<string, string> = {
  inherit: "跟随默认",
  milestones_and_decisions: "阶段成果与需要我决定",
  decisions_only: "仅需要我决定",
  silent: "静默保存",
};
const time = (v: number | null) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "尚未安排";
const ended = (s: string) => ["completed", "cancelled"].includes(s);
type Props = {
  data: any;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  api: (path: string, data?: unknown) => Promise<any>;
  selected: string | null;
  select: (id: string) => void;
  chat: (text?: string) => void;
  care: () => void;
};
export function GoalsPanel({
  data,
  busy,
  act,
  api,
  selected,
  select,
  chat,
  care,
}: Props) {
  const [filter, setFilter] = useState("open"),
    [notifications, setNotifications] = useState(false),
    [settings, setSettings] = useState<any>(null),
    [receipt, setReceipt] = useState(""),
    [artifact, setArtifact] = useState<any>(null),
    [artifactError, setArtifactError] = useState(""),
    [reschedule, setReschedule] = useState<string | null>(null),
    [when, setWhen] = useState(""),
    [confirm, setConfirm] = useState<string | null>(null);
  const [deliveryEdit, setDeliveryEdit] = useState<any>(null);
  const goals = data?.goals || [];
  const list = goals.filter(
    (g: any) =>
      filter === "all" ||
      (filter === "ended" ? ended(g.status) : !ended(g.status)),
  );
  const g = list.find((x: any) => x.id === selected) || list[0];
  useEffect(() => {
    setArtifact(null);
    setArtifactError("");
    setConfirm(null);
    setReschedule(null);
    setDeliveryEdit(null);
  }, [g?.id]);
  if (!data) return <p>正在读取目标…</p>;
  const command = (name: string, args: any) =>
    act(async () => {
      const r = await api("work", {
        name,
        args,
        requestKey: crypto.randomUUID(),
      });
      setReceipt(r.summary);
      setConfirm(null);
      setReschedule(null);
      setDeliveryEdit(null);
      return r;
    });
  const goalAction = (action: string, extra: any = {}) =>
    command("goal_manage", {
      action,
      id: g.id,
      revision: g.revision,
      ...extra,
    });
  const tasks = data.tasks.filter((t: any) => t.goal_id === g?.id),
    artifacts = data.artifacts.filter((a: any) => a.goal_id === g?.id),
    events = data.events.filter((e: any) => e.goal_id === g?.id).slice(0, 20);
  const contactLimit = data.contactLimits?.find(
    (l: any) => l.goal_id === g?.id,
  );
  const working = data.workingStates?.find((m: any) => m.goal_id === g?.id);
  const d = settings || data.defaults;
  const openArtifact = async (id: string, version?: number) => {
    setArtifactError("");
    try {
      const a = await api(
        "artifact?id=" +
          encodeURIComponent(id) +
          (version ? "&version=" + version : ""),
      );
      setArtifact(a);
    } catch (e) {
      setArtifactError((e as Error).message);
    }
  };
  const download = () => {
    const u = URL.createObjectURL(
      new Blob([artifact.body], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = u;
    a.download = artifact.title.replace(/[\\/:*?"<>|]/g, "_") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  return (
    <section className="goals-panel">
      <div className="goals-toolbar">
        <p>
          {notifications
            ? "目标进展与具体交付，各有约定。"
            : "想做的事和正在推进的事，都在这里。"}
        </p>
        <button
          onClick={() => {
            setNotifications(!notifications);
            setReceipt("");
          }}
        >
          {notifications ? "返回目标" : "通知设置"}
        </button>
      </div>
      {receipt && (
        <p className="goal-receipt" role="status">
          {receipt}
        </p>
      )}
      {notifications ? (
        <div className="goal-notifications">
          <h2>目标通知设置</h2>
          <p>反馈仍进入同一段对话。静默保存不会停止工作。</p>
          <label>
            目标进展默认方式
            <select
              value={d.goal_mode}
              onChange={(e) => setSettings({ ...d, goal_mode: e.target.value })}
            >
              {Object.entries(modes)
                .filter(([k]) => k !== "inherit")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </label>
          <label>
            新研究任务的交付方式
            <select
              value={d.task_mode}
              onChange={(e) => setSettings({ ...d, task_mode: e.target.value })}
            >
              <option value="result_and_failure">成果与失败反馈</option>
              <option value="failure_only">仅失败反馈</option>
              <option value="silent">静默保存</option>
            </select>
            <small>只影响新安排，已有任务的约定需要逐项修改。</small>
          </label>
          <label>
            新提醒的联系时段
            <select
              value={d.reminder_quiet}
              onChange={(e) =>
                setSettings({ ...d, reminder_quiet: e.target.value })
              }
            >
              <option value="exact_time">按约定时间提醒</option>
              <option value="respect_window">遵守联系时段</option>
            </select>
          </label>
          <div className="goal-next">
            <small>共同联系偏好</small>
            <p>
              {data.contactPolicy.startHour}:00–{data.contactPolicy.endHour}:00
              · 普通消息每天最多 {data.contactPolicy.dailyLimit} 条，间隔{" "}
              {data.contactPolicy.minGapMinutes} 分钟。
            </p>
            <button onClick={care}>到关心管理 →</button>
            <small>明确约定的提醒、成果与失败反馈不占普通消息额度。</small>
          </div>
          {settings && settings.revision !== data.defaults.revision && (
            <p role="alert">设置已在别处更新，请重新读取后修改。</p>
          )}
          <div className="goal-buttons">
            <button
              disabled={
                busy ||
                !settings ||
                settings.revision !== data.defaults.revision
              }
              onClick={() =>
                act(async () => {
                  const r = await api("notification-policies", {
                    revision: d.revision,
                    goal_mode: d.goal_mode,
                    task_mode: d.task_mode,
                    reminder_quiet: d.reminder_quiet,
                  });
                  setSettings(null);
                  setReceipt(r.summary);
                })
              }
            >
              保存通知设置
            </button>
            {settings && (
              <button onClick={() => setSettings(null)}>放弃修改</button>
            )}
          </div>
        </div>
      ) : (
        <div className="goals-layout">
          <div className="goals-list">
            <div className="goal-filters" aria-label="目标状态筛选">
              {[
                ["all", "全部"],
                ["open", "进行中"],
                ["ended", "已结束"],
              ].map(([k, v]) => (
                <button
                  key={k}
                  aria-pressed={filter === k}
                  className={filter === k ? "selected" : ""}
                  onClick={() => setFilter(k)}
                >
                  {v}
                </button>
              ))}
            </div>
            {list.map((x: any) => (
              <button
                key={x.id}
                className={
                  "goal-list-item" + (g?.id === x.id ? " selected" : "")
                }
                onClick={() => {
                  select(x.id);
                  if (window.matchMedia("(max-width:760px)").matches)
                    requestAnimationFrame(() =>
                      document.getElementById("goal-detail")?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      }),
                    );
                }}
              >
                <strong>{x.title}</strong>
                <span>
                  {x.execution_policy === "record_only" && x.status === "active"
                    ? "已记录"
                    : labels[x.status] || x.status}
                </span>
                <small>
                  {x.execution_policy === "record_only"
                    ? "已记录 · 暂不主动跟进"
                    : x.next_action || x.wait_condition || "准备接下来的安排"}
                </small>
              </button>
            ))}
            {!list.length && (
              <p className="goal-empty">
                还没有{filter === "ended" ? "已结束的" : ""}
                目标。直接在对话里告诉我想做的事。
              </p>
            )}
            <button className="goal-chat-link" onClick={() => chat()}>
              在对话里安排 →
            </button>
          </div>
          {g ? (
            <div className="goal-detail" id="goal-detail">
              <span className="goal-status">
                {g.execution_policy === "record_only" && g.status === "active"
                  ? "已记录"
                  : labels[g.status]}
              </span>
              <h2>{g.title}</h2>
              <div className="goal-next">
                <small>下一步</small>
                <p>{g.next_action || g.wait_condition || "等待下一次推进"}</p>
                {g.execution_policy === "record_only" && (
                  <button
                    onClick={() =>
                      chat(`请持续跟进「${g.title}」，先和我确认范围。`)
                    }
                  >
                    讨论下一步
                  </button>
                )}
                {working &&
                  (working.items.length > 0 ||
                    working.questions.length > 0) && (
                    <details>
                      <summary>决定与待办</summary>
                      {working.items.map((item: any) => (
                        <p key={item.id}>
                          {item.decision === "reported_done"
                            ? "你已确认完成"
                            : item.decision === "selected"
                              ? "已选择"
                              : item.decision === "rejected"
                                ? "暂不采用"
                                : "考虑中"}{" "}
                          · {item.label}
                          {item.next_action && ` — ${item.next_action}`}
                        </p>
                      ))}
                      {working.questions.map((q: any) => (
                        <p key={q.id}>
                          {q.status === "answered"
                            ? "已回答"
                            : q.status === "paused"
                              ? "暂缓"
                              : "待决定"}{" "}
                          · {q.question}
                        </p>
                      ))}
                    </details>
                  )}
                {g.support_until && (
                  <small>自主跟进授权至：{time(g.support_until)}</small>
                )}
                {g.nextCheckAt && !ended(g.status) && (
                  <small>下次跟进：{time(g.nextCheckAt)}</small>
                )}
                {g.wait_condition && (
                  <small>等待条件：{g.wait_condition}</small>
                )}
              </div>
              <section>
                <h3>执行安排</h3>
                {!tasks.length && (
                  <p className="goal-empty">
                    先明确下一步，有具体工作时再安排。
                  </p>
                )}
                {tasks.map((t: any) => (
                  <div key={t.id} className="goal-task">
                    <div>
                      <strong>{t.title}</strong>
                      <span>
                        {labels[t.status] || t.status} ·{" "}
                        {t.owner === "user" ? "你安排的" : "助理安排"}
                      </span>
                      <small>
                        {t.next_run_at ? time(t.next_run_at) : t.reason}
                        {t.recurrence !== "once"
                          ? " · " + (t.recurrence === "daily" ? "每天" : "每周")
                          : ""}
                        {t.deliver_at
                          ? " · " + time(t.deliver_at) + " 交付"
                          : ""}
                      </small>
                      {t.reason && t.next_run_at && <small>{t.reason}</small>}
                    </div>
                    {!ended(t.status) && !ended(g.status) && (
                      <div className="goal-buttons">
                        <button
                          disabled={busy}
                          onClick={() => {
                            setReschedule(t.id);
                            setWhen("");
                          }}
                        >
                          改期
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            command("task_manage", {
                              action:
                                t.status === "paused" ? "resume" : "pause",
                              id: t.id,
                              revision: t.revision,
                            })
                          }
                        >
                          {t.status === "paused" ? "恢复" : "暂停"}
                        </button>
                        <button onClick={() => setDeliveryEdit({ ...t })}>
                          交付设置
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setConfirm("task:" + t.id)}
                        >
                          取消
                        </button>
                      </div>
                    )}
                    {reschedule === t.id && (
                      <form
                        className="goal-inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const at = Date.parse(when + ":00+08:00");
                          void command("task_manage", {
                            action: "reschedule",
                            id: t.id,
                            revision: t.revision,
                            due_at: at,
                            ...(t.deliver_at
                              ? {
                                  deliver_at:
                                    at + (t.deliver_at - t.next_run_at),
                                }
                              : {}),
                          });
                        }}
                      >
                        <label>
                          新的执行时间（北京时间）
                          <input
                            type="datetime-local"
                            required
                            value={when}
                            onChange={(e) => setWhen(e.target.value)}
                          />
                        </label>
                        <button disabled={busy}>保存改期</button>
                        <button
                          type="button"
                          onClick={() => setReschedule(null)}
                        >
                          取消修改
                        </button>
                      </form>
                    )}
                    {deliveryEdit?.id === t.id && (
                      <div className="goal-inline-form">
                        <label>
                          联系时段
                          <select
                            value={deliveryEdit.delivery_contract.quiet}
                            onChange={(e) =>
                              setDeliveryEdit({
                                ...deliveryEdit,
                                delivery_contract: {
                                  ...deliveryEdit.delivery_contract,
                                  quiet: e.target.value,
                                },
                              })
                            }
                          >
                            <option value="exact_time">按约定时间</option>
                            <option value="respect_window">遵守联系时段</option>
                          </select>
                        </label>
                        {t.kind !== "reminder" && (
                          <label>
                            交付方式
                            <select
                              value={deliveryEdit.delivery_contract.mode}
                              onChange={(e) =>
                                setDeliveryEdit({
                                  ...deliveryEdit,
                                  delivery_contract: {
                                    ...deliveryEdit.delivery_contract,
                                    mode: e.target.value,
                                  },
                                })
                              }
                            >
                              <option value="result_and_failure">
                                成果与失败反馈
                              </option>
                              <option value="failure_only">仅失败反馈</option>
                              <option value="silent">静默保存</option>
                            </select>
                          </label>
                        )}
                        <button
                          disabled={busy}
                          onClick={() =>
                            command("task_manage", {
                              action: "delivery",
                              id: t.id,
                              revision: deliveryEdit.revision,
                              delivery_mode:
                                deliveryEdit.delivery_contract.mode,
                              quiet_behavior:
                                deliveryEdit.delivery_contract.quiet,
                            })
                          }
                        >
                          保存这项约定
                        </button>
                        <button onClick={() => setDeliveryEdit(null)}>
                          放弃修改
                        </button>
                      </div>
                    )}
                    {confirm === "task:" + t.id && (
                      <div className="goal-confirm">
                        <p>取消「{t.title}」的未来安排？历史记录会保留。</p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            command("task_manage", {
                              action: "cancel",
                              id: t.id,
                              revision: t.revision,
                            })
                          }
                        >
                          确认取消
                        </button>
                        <button onClick={() => setConfirm(null)}>保留</button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
              {!!artifacts.length && (
                <section>
                  <h3>成果</h3>
                  {artifacts.map((a: any) => (
                    <button
                      className="goal-artifact"
                      key={a.id}
                      onClick={() => void openArtifact(a.id)}
                    >
                      {a.title}
                      <small>
                        版本 {a.version} · {time(a.created_at)}
                        {a.context_epoch !== data.contextEpoch ||
                        a.facts_revision !== g.facts_revision
                          ? " · 历史上下文"
                          : ""}
                      </small>
                    </button>
                  ))}
                </section>
              )}
              {artifactError && <p role="alert">{artifactError}</p>}
              {artifact && (
                <section className="goal-artifact-body">
                  <div className="goal-buttons">
                    <h3>{artifact.title}</h3>
                    <label className="goal-version">
                      版本
                      <select
                        aria-label="成果版本"
                        value={artifact.version}
                        onChange={(e) =>
                          void openArtifact(
                            artifact.artifact_id,
                            Number(e.target.value),
                          )
                        }
                      >
                        {Array.from(
                          {
                            length:
                              artifacts.find(
                                (a: any) => a.id === artifact.artifact_id,
                              )?.version || artifact.version,
                          },
                          (_, i) => (
                            <option key={i} value={i + 1}>
                              第 {i + 1} 版
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <button onClick={download}>下载 Markdown</button>
                    <button onClick={() => setArtifact(null)}>收起</button>
                  </div>
                  {artifact.historicalContext && (
                    <p>这是历史版本，部分依据已经变化，不再作为当前事实。</p>
                  )}
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      img: () => null,
                      a: ({ href, children }) =>
                        artifact.sources.some((x: any) => x.url === href) ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ) : (
                          <span>{children}（链接未核验）</span>
                        ),
                      table: ({ children }) => (
                        <div className="table-scroll">
                          <table>{children}</table>
                        </div>
                      ),
                    }}
                  >
                    {artifact.body}
                  </Markdown>
                  <details>
                    <summary>来源与查询时间</summary>
                    {artifact.sources.length ? (
                      artifact.sources.map((x: any) => (
                        <p key={x.url}>
                          <a href={x.url} target="_blank" rel="noreferrer">
                            {x.title || x.url}
                          </a>{" "}
                          · {time(x.fetched_at)}
                        </p>
                      ))
                    ) : (
                      <p>本成果没有使用网页来源。</p>
                    )}
                  </details>
                </section>
              )}
              <section>
                <h3>目标管理</h3>
                <p className="goal-completion">
                  完成条件 · {g.completion_criteria}
                </p>
                {g.execution_policy === "autonomous" && (
                  <label>
                    进展通知
                    <select
                      disabled={busy}
                      value={g.notification_mode}
                      onChange={(e) =>
                        void goalAction("notification", {
                          notification_mode: e.target.value,
                        })
                      }
                    >
                      {Object.entries(modes).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <small>静默仍继续工作；明确交付的提醒保留原约定。</small>
                  </label>
                )}
                {g.execution_policy === "autonomous" && (
                  <label>
                    这个目标的联系上限
                    <select
                      aria-label="这个目标的联系上限"
                      disabled={busy}
                      value={
                        contactLimit
                          ? `${contactLimit.count}/${contactLimit.days}`
                          : "default"
                      }
                      onChange={(e) => {
                        const [count, days] = e.target.value
                          .split("/")
                          .map(Number);
                        void goalAction("notification", {
                          notification_mode: g.notification_mode,
                          contact_limit:
                            e.target.value === "default"
                              ? null
                              : { count, days },
                        });
                      }}
                    >
                      <option value="default">沿用共同联系偏好</option>
                      <option value="1/7">每 7 天最多一次</option>
                      <option value="2/7">每 7 天最多两次</option>
                      <option value="1/1">每天最多一次</option>
                      {contactLimit &&
                        !["1/7", "2/7", "1/1"].includes(
                          `${contactLimit.count}/${contactLimit.days}`,
                        ) && (
                          <option
                            value={`${contactLimit.count}/${contactLimit.days}`}
                          >
                            每 {contactLimit.days} 天最多 {contactLimit.count}{" "}
                            次
                          </option>
                        )}
                    </select>
                    <small>
                      关心与目标进展合并计算；你明确约定的提醒不受影响。
                    </small>
                  </label>
                )}
                {!ended(g.status) && (
                  <div className="goal-buttons">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void goalAction(
                          g.status === "paused" ? "resume" : "pause",
                        )
                      }
                    >
                      {g.status === "paused" ? "恢复整个目标" : "暂停整个目标"}
                    </button>
                    {g.execution_policy === "autonomous" && (
                      <button
                        disabled={busy || g.status === "paused"}
                        onClick={() =>
                          void goalAction(
                            g.support_enabled
                              ? "pause_support"
                              : "resume_support",
                          )
                        }
                      >
                        {g.support_enabled ? "仅暂停自主推进" : "恢复自主推进"}
                      </button>
                    )}
                    {g.execution_policy === "autonomous" && (
                      <button
                        disabled={
                          busy || g.status === "paused" || !g.support_enabled
                        }
                        onClick={() => void goalAction("reevaluate")}
                      >
                        重新评估
                      </button>
                    )}
                    <button onClick={() => setConfirm("complete")}>
                      标记完成
                    </button>
                    <button onClick={() => setConfirm("cancel")}>
                      取消目标
                    </button>
                  </div>
                )}
                {["complete", "cancel"].includes(confirm || "") && (
                  <div className="goal-confirm">
                    <p>
                      {confirm === "complete"
                        ? "确认这个目标已经完成？"
                        : "确认取消整个目标？"}
                      所有关联的未来安排会停止，历史保留。
                    </p>
                    <button
                      disabled={busy}
                      onClick={() => void goalAction(confirm!)}
                    >
                      确认{confirm === "complete" ? "完成" : "取消"}
                    </button>
                    <button onClick={() => setConfirm(null)}>返回</button>
                  </div>
                )}
                <button
                  className="goal-chat-link"
                  onClick={() => chat(`关于「${g.title}」：`)}
                >
                  回到对话，继续补充 →
                </button>
              </section>
              {!!g.facts.length && (
                <details className="goal-events">
                  <summary>已确认的信息</summary>
                  {g.facts.map((x: any) => (
                    <p key={x.id}>
                      {x.content}
                      {x.value !== null ? " · " + x.value + (x.unit || "") : ""}
                      <small>{time(x.updated_at)} · 用户提供</small>
                    </p>
                  ))}
                </details>
              )}
              <details className="goal-events">
                <summary>动态与记录</summary>
                {events.map((x: any) => (
                  <p key={x.id}>
                    {x.body}
                    <small>{time(x.created_at)}</small>
                  </p>
                ))}
                {data.deliveries
                  .filter(
                    (x: any) => x.goal_id === g.id && x.status !== "delivered",
                  )
                  .slice(0, 6)
                  .map((x: any) => (
                    <p key={x.id}>
                      {x.decision_reason || "等待交付"}
                      {x.status === "pending"
                        ? " · " + time(x.eligible_at)
                        : ""}
                    </p>
                  ))}
              </details>
            </div>
          ) : (
            <div className="goal-welcome">
              <h2>从一件具体的事开始。</h2>
              <p>提醒、研究，或一段需要持续推进的计划，都可以直接聊。</p>
              <button onClick={() => chat("明天上午九点提醒我喝水。")}>
                试试安排提醒 →
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
