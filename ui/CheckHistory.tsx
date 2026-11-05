import React, { Fragment, useEffect, useRef, useState } from "react";
import "./check-history.css";

const ranges = {
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  all: "全部",
  custom: "自定义日期",
};
const kinds = {
  all: "全部",
  delivered: "已联系",
  silent: "保持安静",
  skipped: "策略跳过",
  unfinished: "未完成",
  running: "检查中",
};
const states: Record<string, string> = {
  delivered: "已联系",
  silent: "保持安静",
  skipped: "策略跳过",
  failed: "检查失败",
  cancelled: "检查已取消",
  interrupted: "运行中断",
  running: "检查中",
};
const modelLabels: Record<string, string> = {
  none: "未调用模型",
  called: "已调用模型",
  started: "已启动模型检查",
  queued: "已排队检查",
};
const KEY = "pa-check-history-filters-v1";
type Filter = { range: string; kind: string; from: string; to: string };
const day = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(0, 10);
const clock = (n: number) =>
  new Date(n).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const defaults = (today: string): Filter => ({
  range: "today",
  kind: "all",
  from: today,
  to: today,
});

export function CheckHistory({
  data,
  api,
}: {
  data: any;
  api: (path: string) => Promise<any>;
}) {
  const today = day(data.serverTime);
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      const f = JSON.parse(localStorage.getItem(KEY) || "null");
      if (
        f &&
        Object.hasOwn(ranges, f.range) &&
        Object.hasOwn(kinds, f.kind) &&
        /^\d{4}-\d{2}-\d{2}$/.test(f.from) &&
        /^\d{4}-\d{2}-\d{2}$/.test(f.to)
      )
        return f;
    } catch {}
    return defaults(today);
  });
  const [result, setResult] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0),
    [seen, setSeen] = useState("");
  const sequence = useRef(0);
  const fingerprint = data.checks
    .map((c: any) => [c.id, c.status, c.finished_at].join(":"))
    .join("|");
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  const validation =
    filter.range === "custom"
      ? !filter.from || !filter.to
        ? "请选择开始和结束日期"
        : filter.from > filter.to
          ? "开始日期不能晚于结束日期"
          : ""
      : "";
  const params = new URLSearchParams({
    range: filter.range,
    kind: filter.kind,
  });
  if (filter.range === "custom") {
    params.set("from", filter.from);
    params.set("to", filter.to);
  }
  const path = "heartbeat/history?" + params;
  const dateKey = ["today", "yesterday", "week"].includes(filter.range)
    ? today
    : "";
  const requestKey = path + dateKey;
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(filter));
    } catch {}
  }, [filter]);
  useEffect(() => {
    const ticket = ++sequence.current,
      captured = currentFingerprint.current;
    setResult(null);
    setError("");
    if (validation) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api(path)
      .then((r) => {
        if (sequence.current === ticket) {
          setResult({ ...r, requestKey });
          setSeen(captured);
        }
      })
      .catch((e) => {
        if (sequence.current === ticket) setError(e.message || "记录加载失败");
      })
      .finally(() => {
        if (sequence.current === ticket) setLoading(false);
      });
    return () => {
      sequence.current++;
    };
  }, [path, dateKey, validation, refresh, api]);
  const visible = result?.requestKey === requestKey ? result : null;
  const more = async () => {
    if (!visible?.nextCursor || loading) return;
    const ticket = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const r = await api(
        path + "&cursor=" + encodeURIComponent(visible.nextCursor),
      );
      if (ticket === sequence.current)
        setResult({
          ...r,
          requestKey,
          checks: [...visible.checks, ...r.checks].filter(
            (c, i, all) => all.findIndex((x) => x.id === c.id) === i,
          ),
        });
    } catch (e: any) {
      if (ticket === sequence.current)
        setError(e.message || "加载失败，请重试");
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  };
  const reset = () => {
    setFilter(defaults(today));
    setRefresh((v) => v + 1);
  };
  return (
    <section className="care-section check-history" aria-label="最近检查">
      <div className="history-heading">
        <h3>最近检查</h3>
        <button
          type="button"
          className="history-text-button"
          onClick={() => setRefresh((v) => v + 1)}
          disabled={loading || !!validation}
        >
          {visible && seen !== fingerprint ? "有更新，刷新记录" : "刷新记录"}
        </button>
      </div>
      <p className="history-intro">
        看看每次检查做了什么，以及为什么联系你，或选择保持安静。
      </p>
      <div className="history-filters">
        <div className="history-filter-row" role="group" aria-label="时间范围">
          <span className="history-field">时间范围</span>
          {Object.entries(ranges).map(([id, label]) => (
            <button
              type="button"
              className="history-pill"
              aria-pressed={filter.range === id}
              key={id}
              onClick={() => setFilter((f) => ({ ...f, range: id }))}
            >
              {label}
            </button>
          ))}
        </div>
        {filter.range === "custom" && (
          <div className="history-dates">
            <label>
              开始日期
              <input
                type="date"
                aria-label="开始日期"
                value={filter.from}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, from: e.target.value }))
                }
              />
            </label>
            <span>至</span>
            <label>
              结束日期
              <input
                type="date"
                aria-label="结束日期"
                value={filter.to}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, to: e.target.value }))
                }
              />
            </label>
            <small>北京时间，包含结束当天</small>
          </div>
        )}
        <div
          className="history-filter-row history-kind-row"
          role="group"
          aria-label="行为类型"
        >
          <span className="history-field">行为类型</span>
          {Object.entries(kinds).map(([id, label]) => (
            <button
              type="button"
              className="history-pill"
              aria-pressed={filter.kind === id}
              key={id}
              onClick={() => setFilter((f) => ({ ...f, kind: id }))}
            >
              {label}
              {visible && <small>{visible.counts[id]}</small>}
            </button>
          ))}
        </div>
      </div>
      <div className="history-meta" aria-live="polite">
        <span>
          {validation ||
            (visible ? (
              <>
                共 <strong>{visible.summary.total}</strong> 条记录 · 模型检查{" "}
                {visible.summary.models} 次 · 已联系 {visible.summary.contacts}{" "}
                次
              </>
            ) : loading ? (
              "正在查询历史记录…"
            ) : (
              "暂未取得记录"
            ))}
        </span>
        <button type="button" className="history-text-button" onClick={reset}>
          重置筛选
        </button>
      </div>
      {error && (
        <div role="alert" className="history-error">
          {error}{" "}
          <button
            type="button"
            onClick={() =>
              visible?.nextCursor ? void more() : setRefresh((v) => v + 1)
            }
            disabled={loading}
          >
            重试
          </button>
        </div>
      )}
      {visible && (
        <>
          <div className="history-list" aria-busy={loading}>
            {!visible.checks.length && (
              <div className="history-empty">
                <strong>这个范围内没有相关检查</strong>
                <span>试试其他时间或行为类型。</span>
                <button type="button" onClick={reset}>
                  重置筛选
                </button>
              </div>
            )}
            {visible.checks.map((c: any, i: number) => (
              <Fragment key={c.id}>
                {(i === 0 ||
                  day(c.created_at) !==
                    day(visible.checks[i - 1].created_at)) && (
                  <div className="history-date">
                    {day(c.created_at).replaceAll("-", " / ")}
                    {day(c.created_at) === today && " · 今天"}
                  </div>
                )}
                <details className="history-check" data-check-id={c.id}>
                  <summary>
                    <span
                      className={"history-mark " + c.status}
                      aria-hidden="true"
                    >
                      {c.status === "delivered"
                        ? "↗"
                        : c.status === "silent"
                          ? "−"
                          : c.status === "skipped"
                            ? "↷"
                            : c.status === "running"
                              ? "·"
                              : "!"}
                    </span>
                    <span className="history-body">
                      <span className="history-title">
                        {states[c.status] || c.status}
                        <small className="history-tag">
                          {c.modelState === "queued" && c.status !== "running"
                            ? "未启动模型"
                            : modelLabels[c.modelState]}
                        </small>
                      </span>
                      <span className="history-reason">{c.reason}</span>
                    </span>
                    <span className="history-time">
                      {clock(c.created_at)} <span aria-hidden="true">⌄</span>
                      <small>
                        {c.trigger === "manual" ? "手动" : "自动"}检查
                      </small>
                    </span>
                  </summary>
                  <div className="history-detail">
                    {c.modelState === "none" ? (
                      "服务按联系规则直接跳过，本次未调用模型。"
                    ) : (
                      <>
                        模型用量：
                        {c.totalTokens === null
                          ? "未返回用量"
                          : `${c.totalTokens.toLocaleString()} tokens`}{" "}
                        · 搜索 / 阅读 {c.web_calls || 0} 次 · 模型重试{" "}
                        {c.retry_count || 0} 次
                      </>
                    )}
                    <br />
                    {c.status === "delivered"
                      ? "交付：已进入同一长对话。"
                      : c.status === "running"
                        ? "检查尚未结束，结果待更新。"
                        : "交付：本次没有新增对话消息。"}
                  </div>
                </details>
              </Fragment>
            ))}
          </div>
          <div className="history-footer">
            <span>
              已加载 {visible.checks.length} / {visible.summary.total} 条 ·
              按检查时间倒序
            </span>
            {visible.nextCursor && (
              <button
                type="button"
                onClick={() => void more()}
                disabled={loading}
              >
                {loading ? "正在加载…" : "加载更多"}
              </button>
            )}
          </div>
        </>
      )}
      <p className="care-hint">
        今日用量：模型检查 {data.counts.models} / {data.policy.modelDailyLimit}{" "}
        次 · 搜索与阅读 {data.counts.searches} / {data.policy.searchDailyLimit}{" "}
        次。
      </p>
      <p className="care-hint">
        北京时间 ·
        “未完成”包含失败、取消与中断；策略跳过可能未调用模型。模型检查次数不等于
        API 请求数。
      </p>
    </section>
  );
}
