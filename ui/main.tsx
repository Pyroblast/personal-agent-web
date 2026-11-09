import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  Fragment,
} from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./chat-layout.css";
import { Icon } from "./Icon";
import { sendsMessage, dayKey, dateLabel } from "./chat-interaction";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProfilePanel, UpkeepPanel } from "./ProfileMemory";
import { HeartbeatPanel } from "./Heartbeat";
import { GoalsPanel } from "./Goals";
import { createCredentials, AUTH_KEY } from "./auth";
const storage = (kind: "localStorage" | "sessionStorage") => ({
  getItem: (key: string) => window[kind].getItem(key),
  setItem: (key: string, value: string) => window[kind].setItem(key, value),
  removeItem: (key: string) => window[kind].removeItem(key),
});
const credentials = createCredentials(
  storage("localStorage"),
  storage("sessionStorage"),
);
function acceptEntry() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has("token")) {
    credentials.offer(hash.get("token")!);
    hash.delete("token");
    history.replaceState(
      null,
      "",
      location.pathname + location.search + (hash.size ? "#" + hash : ""),
    );
  }
}
acceptEntry();
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api(path: string, data?: unknown) {
  const token = credentials.current();
  const r = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  const b = await r.json();
  if (!r.ok) {
    if (r.status === 401) credentials.rejected(token);
    throw new ApiError(b.error, r.status);
  }
  if (path === "state")
    b.browserAuthorizationSaved = credentials.verified(token);
  return b;
}
function sourceHref(href: string | undefined, urls: string[]) {
  if (!href) return;
  const canonical = (s: string) => {
    try {
      const u = new URL(
        decodeURI(s)
          .split(/[（），。；\s]/)[0]
          .replace(/\*+$/, ""),
      );
      u.hash = "";
      return u.href;
    } catch {
      return s;
    }
  };
  return urls.find((url) => canonical(url) === canonical(href));
}
function Reply({ text, urls = [] }: { text: string; urls?: string[] }) {
  return (
    <div className="reply-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) =>
            sourceHref(href, urls) ? (
              <a href={sourceHref(href, urls)} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>
                {children}
                <small>（链接未核验）</small>
              </span>
            ),
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
          img: () => null,
        }}
      >
        {text.replace(
          /(https?:\/\/[^\s<>）。，；()\[\]*]+)(?=[）。，；])/g,
          "<$1>",
        )}
      </Markdown>
    </div>
  );
}
function App() {
  const follow = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const scrollPosition = useRef(0);
  const knownMessages = useRef<Set<string> | null>(null);
  const submitting = useRef(false);
  const [away, setAway] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("pa-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const compact = narrow ? !mobileOpen : collapsed;
  const jumpToLatest = () => {
    follow.current = true;
    setAway(false);
    setNewMessages(0);
    if (scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  const toggleSidebar = () => {
    if (narrow) setMobileOpen((v) => !v);
    else
      setCollapsed((v) => {
        try {
          localStorage.setItem("pa-sidebar-collapsed", String(!v));
        } catch {}
        return !v;
      });
  };
  const seenPending = useRef(new Set<string>());
  const pending = useRef<{
    body: string;
    key: string;
    replyTo: string | null;
  } | null>(null);
  const [state, setState] = useState<any>(),
    [error, setError] = useState(""),
    [connection, setConnection] = useState("loading"),
    [draft, setDraft] = useState(""),
    [tab, setTab] = useState("chat"),
    [selectedGoal, setSelectedGoal] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [memory, setMemory] = useState(""),
    [kind, setKind] = useState("preference"),
    [expires, setExpires] = useState(""),
    [edit, setEdit] = useState<any>(null),
    [notice, setNotice] = useState(""),
    [replyTo, setReplyTo] = useState<string | null>(null);
  const refresh = async () => {
    const s = await api("state");
    setState(s);
    setConnection("ready");
  };
  useEffect(() => {
    let active = true,
      polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        const s = await api("state");
        if (active) {
          setState(s);
          setConnection("ready");
        }
      } catch (e) {
        if (active) {
          const unauthorized = e instanceof ApiError && e.status === 401;
          setConnection(unauthorized ? "unauthorized" : "offline");
          if (unauthorized) setState(undefined);
        }
      } finally {
        polling = false;
      }
    };
    const onEntry = () => {
      acceptEntry();
      setError("");
      void tick();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTH_KEY || e.key === null) void tick();
    };
    window.addEventListener("hashchange", onEntry);
    window.addEventListener("storage", onStorage);
    void tick();
    const timer = setInterval(tick, 600);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("hashchange", onEntry);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const resize = () => {
      setNarrow(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    setMobileOpen(false);
    setShowStatus(false);
  }, [tab]);
  useEffect(() => {
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        setShowStatus(false);
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (input) {
      input.style.height = "0px";
      input.style.height = Math.min(160, input.scrollHeight) + "px";
    }
    if (tab === "chat" && follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [draft, replyTo, tab, compact, narrow]);
  useLayoutEffect(() => {
    if (tab !== "chat" || !scroller.current) return;
    scroller.current.scrollTop = follow.current
      ? scroller.current.scrollHeight
      : scrollPosition.current;
    const observer = new ResizeObserver(() => {
      if (follow.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight;
    });
    if (timeline.current) observer.observe(timeline.current);
    observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [tab]);
  useLayoutEffect(() => {
    if (!state?.messages) return;
    const messages = state.messages as any[];
    const previous = knownMessages.current;
    knownMessages.current = new Set(messages.map((m) => m.id));
    if (previous && !(follow.current && tab === "chat")) {
      const added = messages.filter(
        (m) => m.role === "assistant" && !previous.has(m.id),
      ).length;
      if (added) setNewMessages((n) => n + added);
    }
    if (tab === "chat" && follow.current) jumpToLatest();
  }, [state, tab]);
  useEffect(() => {
    if (tab !== "chat" || connection !== "ready" || !state?.heartbeat) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (document.visibilityState !== "visible") return;
        const ids = entries
          .filter(
            (e) =>
              e.isIntersecting &&
              !seenPending.current.has(e.target.getAttribute("data-delivery")!),
          )
          .map((e) => e.target.getAttribute("data-delivery")!);
        if (!ids.length) return;
        ids.forEach((id) => seenPending.current.add(id));
        void api("heartbeat/seen", { ids }).catch(() =>
          ids.forEach((id) => seenPending.current.delete(id)),
        );
      },
      { root: scroller.current, threshold: 0.1 },
    );
    for (const d of state.heartbeat.deliveries)
      if (!d.seen_at) {
        const el = document.getElementById("message-" + d.message_id);
        if (el) observer.observe(el);
      }
    return () => observer.disconnect();
  }, [tab, connection, state?.heartbeat]);
  const act = async (fn: () => Promise<unknown>) => {
    if (connection !== "ready") return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={"shell" + (compact ? " sidebar-collapsed" : "")}>
      {narrow && mobileOpen && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside>
        <div className="brand-row">
          <div className="brand">
            Personal Agent<span>你的个人空间</span>
          </div>
          <button
            className="icon-button sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={compact ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!compact}
            title={compact ? "展开侧边栏" : "收起侧边栏"}
          >
            <Icon name="panel" />
          </button>
        </div>
        <nav aria-label="主要导航">
          {[
            ["chat", "对话", "chat"],
            ["goals", "目标", "goal"],
            ["memory", "记忆", "memory"],
            ["care", "关心", "care"],
            ["profile", "设置", "monitor"],
          ].map(([key, label, icon]) => (
            <button
              key={key}
              aria-label={label}
              title={label}
              aria-current={tab === key ? "page" : undefined}
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setMobileOpen(false);
              }}
            >
              <Icon name={icon} />
              <span className="nav-label">{label}</span>
              {key === "memory" && (
                <span className="nav-count">{state?.memories.length || 0}</span>
              )}
              {key === "care" && (
                <span className="nav-count">
                  {state?.heartbeat?.policy.enabled ? "●" : "○"}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="aside-note">
          <div className="local-label" title="本机 · 私有存储">
            <Icon name="monitor" />
            <span>本机 · 私有存储</span>
          </div>
          <p>记住在意的事，适时出现。</p>
          {connection === "ready" && (
            <div>
              <button
                className="auth-forget"
                onClick={() => {
                  credentials.forget();
                  setState(undefined);
                  setConnection("unauthorized");
                  setNotice("");
                  setError("");
                }}
              >
                忘记此浏览器的授权
              </button>
            </div>
          )}
        </div>
      </aside>
      <main className={tab === "chat" ? "chat-main" : "settings-main"}>
        <header className="app-header">
          <h1>
            {
              {
                chat: "对话",
                goals: "目标",
                memory: "记忆",
                care: "关心",
                profile: "设置",
              }[tab]
            }
          </h1>
          <div className="header-status">
            <button
              className="status-button"
              aria-expanded={showStatus}
              aria-controls="connection-details"
              onClick={() => setShowStatus((v) => !v)}
            >
              <span className="status-dot" />
              <span>
                {connection !== "ready"
                  ? (
                      {
                        loading: "正在连接",
                        unauthorized: "尚未授权",
                        offline: "后台连接中断",
                      } as any
                    )[connection]
                  : state?.runtime?.mode !== "deepseek"
                    ? "模型未连接"
                    : state?.heartbeat?.policy.pausedUntil > Date.now()
                      ? "主动关心已暂停"
                      : state?.heartbeat?.policy.enabled
                        ? "主动关心已开启"
                        : "主动关心已关闭"}
              </span>
              <Icon name="chevron" />
            </button>
            {showStatus && (
              <div id="connection-details" className="status-popover">
                <p>{state?.runtime?.label || "正在连接本机服务"}</p>
                <p>MVP 2.0 · 本地 Web</p>
                <p>每 30 分钟检查，有值得说的再联系。</p>
                <button
                  onClick={() => {
                    setTab("profile");
                    setShowStatus(false);
                  }}
                >
                  助理设置 →
                </button>
                <button onClick={() => setTab("care")}>管理主动关心 →</button>
                {connection === "ready" && (
                  <button
                    onClick={() => {
                      credentials.forget();
                      setState(undefined);
                      setConnection("unauthorized");
                      setShowStatus(false);
                    }}
                  >
                    忘记此浏览器的授权
                  </button>
                )}
              </div>
            )}
          </div>
        </header>
        <div className="connection-notices">
          {(connection !== "ready" ||
            state?.runtime?.mode !== "deepseek" ||
            state?.browserAuthorizationSaved === false) && (
            <div className="banner">
              {connection === "unauthorized"
                ? "此浏览器尚未授权或授权已失效。请用本机启动入口验证一次，之后即可收藏此地址直接打开。"
                : connection === "offline"
                  ? "暂时无法连接本机后台，正在自动重连。请确认后台服务仍在运行。"
                  : connection === "loading"
                    ? "正在连接本机服务…"
                    : state?.runtime?.mode === "deepseek"
                      ? "真实 DeepSeek 对话 · 自动记忆 · 公开网页搜索。主动关心可在侧栏管理。"
                      : "后台已连接，但尚未配置 DeepSeek；输入只会保存，不会自动执行。"}
              {connection === "unauthorized" && (
                <p>
                  在项目目录运行 <code>npm run local:open</code>
                  ，用它提供的完整入口打开当前浏览器。
                </p>
              )}
              {connection === "ready" &&
                state?.browserAuthorizationSaved === false && (
                  <p>
                    浏览器未允许保存授权；当前页面可以使用，重新打开时仍需完整入口。
                  </p>
                )}
            </div>
          )}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
        </div>
        {tab === "chat" ? (
          <>
            <div
              className="chat-scroll"
              ref={scroller}
              aria-label="对话消息"
              onWheel={(e) => {
                if (e.deltaY < 0) follow.current = false;
              }}
              onScroll={(e) => {
                const el = e.currentTarget;
                scrollPosition.current = el.scrollTop;
                const near =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 64;
                follow.current = near;
                setAway(!near);
                if (near) setNewMessages(0);
              }}
            >
              <section className="timeline" ref={timeline}>
                {!state?.messages.length && (
                  <div className="welcome">
                    <span className="eyebrow">A LITTLE MORE PERSONAL</span>
                    <h2>从今天的想法开始。</h2>
                    <p>
                      聊聊你在意的事。你的偏好、交流和搜索结果，都会在这里接续。
                    </p>
                    <div className="suggestions">
                      {[
                        "我通常晚饭后练吉他，这周晚上要加班",
                        "帮我搜索北京近期的吉他演出，给我来源",
                      ].map((s) => (
                        <button key={s} onClick={() => setDraft(s)}>
                          {s} ↗
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {state?.messages.map((m: any, index: number) => {
                  const delivery = state.heartbeat?.deliveries.find(
                    (d: any) => d.message_id === m.id,
                  );
                  const run = state.runs.find(
                    (r: any) =>
                      r.message_id === m.id ||
                      m.id === "reply-" + r.id ||
                      r.id === delivery?.run_id,
                  );
                  const sources =
                    m.role === "assistant"
                      ? state.sources.filter((x: any) => x.run_id === run?.id)
                      : [];
                  const actions =
                    m.role === "assistant" ||
                    ["failed", "interrupted", "cancelled"].includes(m.status)
                      ? state.actions.filter((x: any) => x.run_id === run?.id)
                      : [];
                  const careActions =
                    m.role === "assistant" ||
                    ["failed", "interrupted", "cancelled"].includes(m.status)
                      ? (state.heartbeat?.actions || []).filter(
                          (a: any) => a.run_id === run?.id,
                        )
                      : [];
                  const workActions =
                    m.role === "assistant" ||
                    ["failed", "interrupted", "cancelled"].includes(m.status)
                      ? (state.work?.actions || []).filter(
                          (a: any) => a.run_id === run?.id,
                        )
                      : [];
                  return (
                    <Fragment key={m.id}>
                      {(index === 0 ||
                        dayKey(m.created_at) !==
                          dayKey(state.messages[index - 1].created_at)) && (
                        <div className="date-divider">
                          {dateLabel(m.created_at)}
                        </div>
                      )}
                      <article
                        className={
                          "message " + m.role + (delivery ? " proactive" : "")
                        }
                        id={"message-" + m.id}
                        data-delivery={delivery ? m.id : undefined}
                      >
                        <small
                          className={"speaker" + (!delivery ? " sr-only" : "")}
                        >
                          {m.role === "user"
                            ? "你"
                            : delivery
                              ? delivery.source === "goal"
                                ? "目标进展"
                                : delivery.source === "task"
                                  ? "安排交付"
                                  : "主动关心"
                              : "Personal Agent"}
                        </small>
                        {m.role === "user" ? (
                          <div className="user-text">{m.body}</div>
                        ) : (
                          <Reply
                            text={m.body}
                            urls={state.sources.map((s: any) => s.url)}
                          />
                        )}
                        {delivery && (
                          <div className="proactive-controls">
                            <button
                              onClick={() => {
                                setReplyTo(m.id);
                                requestAnimationFrame(() =>
                                  composerInput.current?.focus({
                                    preventScroll: true,
                                  }),
                                );
                              }}
                            >
                              回应这条
                            </button>
                            {delivery.source === "heartbeat" ? (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  act(() =>
                                    api("heartbeat", {
                                      revision: state.heartbeat.policy.revision,
                                      patch: {
                                        mutedTopics: {
                                          ...Object.fromEntries(
                                            Object.entries(
                                              state.heartbeat.policy
                                                .mutedTopics,
                                            ).filter(
                                              ([, v]) =>
                                                v === null ||
                                                Number(v) > Date.now(),
                                            ),
                                          ),
                                          [delivery.topic]: null,
                                        },
                                      },
                                    }),
                                  )
                                }
                              >
                                暂停这个话题
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  setSelectedGoal(delivery.goal_id);
                                  setTab("goals");
                                }}
                              >
                                查看目标 →
                              </button>
                            )}
                            <details>
                              <summary>为什么联系我</summary>
                              <p>{delivery.reason}</p>
                              <small>
                                {delivery.replied_at
                                  ? "你已回应"
                                  : delivery.source !== "heartbeat"
                                    ? delivery.seen_at
                                      ? "已读"
                                      : "已送达"
                                    : delivery.feedback_at
                                      ? "已记录你的话题偏好"
                                      : delivery.seen_at
                                        ? "已读，等待反馈；不会重复追问此话题"
                                        : "已送达，等待反馈；不会重复追问此话题"}
                              </small>
                            </details>
                          </div>
                        )}
                        {sources.length > 0 && (
                          <details className="sources">
                            <summary>参考来源 · {sources.length}</summary>
                            {sources.map((x: any) => (
                              <a
                                key={x.id}
                                href={x.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <strong>{x.title}</strong>
                                <span>
                                  {new URL(x.url).hostname} ·{" "}
                                  {x.published_at || "发布日期未知"}
                                </span>
                                <p>{x.snippet.slice(0, 180)}</p>
                              </a>
                            ))}
                          </details>
                        )}
                        {actions.length > 0 && (
                          <details className="receipts">
                            <summary>
                              ✓ 已完成操作 · {actions.length} 条
                            </summary>
                            {actions.map((a: any, i: number) => {
                              const result = JSON.parse(a.result);
                              const mem = state.memories.find(
                                (x: any) => x.id === result.id,
                              );
                              return (
                                <div key={i}>
                                  {a.name === "agent_profile" ? (
                                    <span>
                                      助理设置已更新{" "}
                                      <button onClick={() => setTab("profile")}>
                                        查看设置
                                      </button>
                                    </span>
                                  ) : a.name === "memory_forget" ? (
                                    "已忘记 · 原始聊天仍保留"
                                  ) : (
                                    "已保存记忆"
                                  )}
                                  {mem && (
                                    <>
                                      <span>{mem.content}</span>
                                      <button onClick={() => setTab("memory")}>
                                        查看
                                      </button>
                                      <button
                                        disabled={busy}
                                        onClick={() =>
                                          act(() =>
                                            api("memories/forget", {
                                              id: mem.id,
                                              revision: mem.revision,
                                            }),
                                          )
                                        }
                                      >
                                        撤销
                                      </button>
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </details>
                        )}
                        {workActions.length > 0 && (
                          <div className="action-receipts">
                            {workActions.map((a: any, i: number) => {
                              const r = JSON.parse(a.result);
                              return (
                                <div key={i} className="action-receipt">
                                  <p>✓ {r.summary}</p>
                                  {r.goal_id && (
                                    <button
                                      onClick={() => {
                                        setSelectedGoal(r.goal_id);
                                        setTab("goals");
                                      }}
                                    >
                                      查看目标 →
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {careActions.length > 0 && (
                          <details className="receipts">
                            <summary>
                              ✓ 关心设置已更新 · {careActions.length} 项
                            </summary>
                            {careActions.map((a: any, i: number) => {
                              const args = JSON.parse(a.args),
                                names: Record<string, string> = {
                                  enable: "已开启主动关心",
                                  disable: "已关闭主动关心",
                                  pause_today: "今日主动关心已暂停",
                                  resume: "已恢复主动关心",
                                  mute_topic: "话题已暂停",
                                  unmute_topic: "话题已恢复",
                                  hours: "联系时段已更新",
                                  search: "主动搜索设置已更新",
                                };
                              const label = state.heartbeat.topics.find(
                                (t: any) => t.id === args.topic,
                              )?.label;
                              return (
                                <div key={i}>
                                  {names[args.action] || "关心设置已更新"}
                                  {label && <span>{label}</span>}
                                  <button onClick={() => setTab("care")}>
                                    查看设置
                                  </button>
                                </div>
                              );
                            })}
                          </details>
                        )}
                        <footer>
                          <span>
                            {m.role === "assistant"
                              ? "" +
                                new Date(m.created_at).toLocaleTimeString(
                                  "zh-CN",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )
                              : (
                                  {
                                    queued: "已接收 · 排队中",
                                    running: "正在思考与处理",
                                    completed: new Date(
                                      m.created_at,
                                    ).toLocaleTimeString("zh-CN", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    }),
                                    blocked: "已保存 · 尚未配置模型",
                                    cancelled: "已取消",
                                    failed: run?.reason,
                                    interrupted: run?.reason,
                                  } as any
                                )[m.status]}
                          </span>
                          {["queued", "running", "blocked"].includes(
                            m.status,
                          ) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                act(() => api("messages/cancel", { id: m.id }))
                              }
                            >
                              {m.status === "running" ? "停止" : "取消"}
                            </button>
                          )}
                          {["failed", "interrupted", "blocked"].includes(
                            m.status,
                          ) && (
                            <button onClick={() => setDraft(m.body)}>
                              重新编辑发送
                            </button>
                          )}
                        </footer>
                      </article>
                    </Fragment>
                  );
                })}
                {state?.runs
                  .filter(
                    (r: any) =>
                      r.status === "running" && r.trigger_type === "user_message",
                  )
                  .map((r: any) => (
                    <article
                      key={r.id}
                      className="message assistant streaming"
                      aria-live="polite"
                    >
                      <small className="speaker">
                        Personal Agent · 正在回复
                      </small>
                      <Reply
                        urls={state.sources.map((s: any) => s.url)}
                        text={
                          r.preview ||
                          (r.web_calls
                            ? "正在搜索与阅读公开网页…"
                            : "正在理解你的问题…")
                        }
                      />
                    </article>
                  ))}
              </section>
            </div>
            <div className="composer-dock">
              {(away || newMessages > 0) && (
                <button className="jump-latest" onClick={jumpToLatest}>
                  <Icon name="down" />
                  {newMessages > 0 ? `${newMessages} 条新消息` : "回到最新消息"}
                </button>
              )}
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = draft;
                  if (
                    submitting.current ||
                    busy ||
                    connection !== "ready" ||
                    !state ||
                    !v.trim()
                  )
                    return;
                  submitting.current = true;
                  if (
                    !pending.current ||
                    pending.current.body !== v ||
                    pending.current.replyTo !== replyTo
                  )
                    pending.current = {
                      body: v,
                      key: crypto.randomUUID(),
                      replyTo,
                    };
                  const key = pending.current.key;
                  void act(async () => {
                    await api("messages", {
                      text: v,
                      requestKey: key,
                      replyTo,
                    });
                    setReplyTo(null);
                    follow.current = true;
                    pending.current = null;
                    setDraft("");
                    requestAnimationFrame(() =>
                      composerInput.current?.focus({ preventScroll: true }),
                    );
                  }).finally(() => {
                    submitting.current = false;
                  });
                }}
              >
                {replyTo && (
                  <div className="reply-target">
                    <span>
                      <small>回应这条消息</small>
                      {state?.messages
                        .find((m: any) => m.id === replyTo)
                        ?.body.slice(0, 60)}
                    </span>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="取消回应引用"
                      onClick={() => setReplyTo(null)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                )}
                <textarea
                  ref={composerInput}
                  rows={1}
                  disabled={busy}
                  aria-label="聊天输入"
                  onKeyDown={(e) => {
                    if (
                      sendsMessage({
                        ...e.nativeEvent,
                        key: e.key,
                        metaKey: e.metaKey,
                        ctrlKey: e.ctrlKey,
                        shiftKey: e.shiftKey,
                        altKey: e.altKey,
                        isComposing: e.nativeEvent.isComposing,
                        keyCode: e.nativeEvent.keyCode,
                        repeat: e.repeat,
                      })
                    ) {
                      e.preventDefault();
                      if (draft.trim() && !busy && connection === "ready")
                        e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="说说你现在的想法…"
                  value={draft}
                  maxLength={12000}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="composer-footer">
                  <span>
                    <kbd>
                      {/Mac|iPhone|iPad/.test(navigator.platform)
                        ? "⌘"
                        : "Ctrl"}{" "}
                      Enter
                    </kbd>{" "}
                    发送 <span className="newline-hint">· Enter 换行</span>
                  </span>
                  <button
                    disabled={
                      busy || connection !== "ready" || !state || !draft.trim()
                    }
                    type="submit"
                    className="send-button"
                    aria-label="发送消息"
                    title="发送消息"
                  >
                    <Icon name="up" />
                  </button>
                </div>
              </form>
              <div className="composer-note">
                内容发往 DeepSeek · 本机保存对话与记忆
              </div>
            </div>
          </>
        ) : (
          <div className="page-scroll">
            {tab === "goals" ? (
              <GoalsPanel
                data={state?.work}
                busy={busy || connection !== "ready"}
                act={act}
                api={api}
                selected={selectedGoal}
                select={setSelectedGoal}
                care={() => setTab("care")}
                chat={(text) => {
                  setTab("chat");
                  if (text) {
                    setDraft((old) => (old ? old + "\n" + text : text));
                  }
                  requestAnimationFrame(() => composerInput.current?.focus());
                }}
              />
            ) : tab === "profile" ? (
              <ProfilePanel
                data={state?.agentProfile}
                busy={busy || connection !== "ready"}
                act={act}
                api={api}
              />
            ) : tab === "care" ? (
              <HeartbeatPanel
                key={state?.instanceId}
                data={state?.heartbeat}
                busy={busy || connection !== "ready"}
                act={act}
                api={api}
              />
            ) : (
              <section className="memories">
                <UpkeepPanel
                  data={state?.upkeep}
                  busy={busy || connection !== "ready"}
                  act={act}
                  api={api}
                />
                <p>
                  助理从你明确表达的信息中保存记忆。你可以直接在聊天中纠正，也可以在这里编辑；过期记忆不再使用。
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(async () => {
                      await api("memories", {
                        id: edit?.id,
                        revision: edit?.revision,
                        content: memory,
                        kind,
                        expiresAt: expires ? new Date(expires).getTime() : null,
                      });
                      setMemory("");
                      setEdit(null);
                      setExpires("");
                      setNotice("记忆已保存。");
                    });
                  }}
                >
                  <label>
                    记忆内容
                    <textarea
                      required
                      value={memory}
                      maxLength={2000}
                      onChange={(e) => setMemory(e.target.value)}
                    />
                  </label>
                  <div className="fields">
                    <label>
                      类型
                      <select
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                      >
                        <option value="preference">偏好</option>
                        <option value="fact">事实</option>
                        <option value="temporary">临时约束</option>
                      </select>
                    </label>
                    <label>
                      有效期（临时约束必填）
                      <input
                        type="datetime-local"
                        required={kind === "temporary"}
                        value={expires}
                        onChange={(e) => setExpires(e.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    disabled={busy || connection !== "ready" || !state}
                    type="submit"
                  >
                    {edit ? "保存纠正" : "添加记忆"}
                  </button>
                  {edit && (
                    <button
                      type="button"
                      onClick={() => {
                        setEdit(null);
                        setMemory("");
                        setExpires("");
                      }}
                    >
                      取消编辑
                    </button>
                  )}
                </form>
                {state?.memories.map((m: any) => (
                  <article className="memory" key={m.id}>
                    <small>
                      {
                        (
                          {
                            preference: "偏好",
                            fact: "事实",
                            temporary: "临时约束",
                          } as any
                        )[m.kind]
                      }{" "}
                      · {m.source_message_id ? "来自对话" : "手动维护"}
                      {m.expired ? " · 已过期" : ""}
                    </small>
                    <p>{m.content}</p>
                    <small>
                      记录于 {new Date(m.updated_at).toLocaleString("zh-CN")}
                      {m.expires_at
                        ? " · 有效至 " +
                          new Date(m.expires_at).toLocaleString("zh-CN")
                        : ""}
                    </small>
                    {(m.source_message_id ||
                      state.memorySources?.some(
                        (s: any) => s.memory_id === m.id,
                      )) && (
                      <details>
                        <summary>查看来源原话</summary>
                        {[
                          ...new Set(
                            [
                              m.source_message_id,
                              ...(state.memorySources || [])
                                .filter((s: any) => s.memory_id === m.id)
                                .map((s: any) => s.source_message_id),
                            ].filter(Boolean),
                          ),
                        ].map((id: any) => (
                          <p key={id}>
                            {state.messages.find((x: any) => x.id === id)
                              ?.body || "来源记录暂不可用"}
                          </p>
                        ))}
                      </details>
                    )}
                    <div>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setEdit(m);
                          setMemory(m.content);
                          setKind(m.kind);
                          setExpires(
                            m.expires_at
                              ? new Date(
                                  m.expires_at -
                                    new Date(m.expires_at).getTimezoneOffset() *
                                      60000,
                                )
                                  .toISOString()
                                  .slice(0, 16)
                              : "",
                          );
                        }}
                      >
                        纠正
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await api("memories/forget", {
                              id: m.id,
                              revision: m.revision,
                            });
                            setNotice("已停止使用该记忆；原始聊天记录仍保留。");
                            if (edit?.id === m.id) {
                              setEdit(null);
                              setMemory("");
                            }
                          })
                        }
                      >
                        忘记
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
