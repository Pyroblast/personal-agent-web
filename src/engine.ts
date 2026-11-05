import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, InputError } from "./store.js";
import { Heartbeat } from "./heartbeat.js";
import { Profile } from "./profile.js";
import { MemoryUpkeep } from "./upkeep.js";
import { Work } from "./work.js";
import { WORK_MODES } from "./work-schema.js";
import { loadConfig } from "./config.js";
export const ALLOWED = [
  "memory_list",
  "memory_save",
  "memory_forget",
  "web_search",
  "web_fetch",
  "care_policy",
  "agent_profile",
  "task_manage",
  "goal_manage",
  "goal_progress",
  "work_context",
  "artifact_read",
];
export class Engine {
  child?: ChildProcess;
  active: any;
  pumping = false;
  closing = false;
  ready = false;
  bridgeUrl = "";
  timer?: NodeJS.Timeout;
  config;
  loadedSession?: string;
  searchCalls = 0;
  stopping = false;
  testSearchFault?: string;
  heartbeat: Heartbeat;
  profile: Profile;
  upkeep: MemoryUpkeep;
  work: Work;
  workerMode?: string;
  heartbeatTimer?: NodeJS.Timeout;
  manualClaim: any;
  webKinds: Record<string, number> = {};
  providerIssue = "";
  workerStop?: Promise<void>;
  constructor(
    public store: Store,
    public dir: string,
    public token: string,
  ) {
    this.config = loadConfig(dir);
    store.recover();
    this.heartbeat = new Heartbeat(store);
    this.heartbeat.modelAvailable = !!this.config;
    this.profile = new Profile(store);
    this.upkeep = new MemoryUpkeep(store, this.profile);
    this.upkeep.modelAvailable = !!this.config;
    this.work = new Work(store, this.heartbeat);
    this.work.modelAvailable = !!this.config;
  }
  status() {
    return {
      mode: this.config ? "deepseek" : "not-connected",
      label: this.config ? "DeepSeek · DSH" : "未配置 DeepSeek",
      model: this.config?.model,
      search: !!this.config,
      automaticMemory: !!this.config,
      ready: this.ready,
      tools: JSON.parse(this.store.getMeta("verified_tools") || "[]"),
    };
  }
  start(url: string) {
    this.bridgeUrl = url;
    void this.pump();
    this.heartbeatTimer = setInterval(() => void this.pump(), 5000);
    this.heartbeatTimer.unref();
  }
  isHeartbeat() {
    return this.active?.trigger_type === "heartbeat";
  }
  isUpkeep() {
    return this.active?.trigger_type === "memory_upkeep";
  }
  isWork() {
    return WORK_MODES.includes(this.active?.trigger_type);
  }
  deadline() {
    return this.isWork() ? 120000 : this.isBackground() ? 60000 : 180000;
  }
  isBackground() {
    return this.isHeartbeat() || this.isUpkeep() || this.isWork();
  }
  toolsForRun() {
    if (this.isUpkeep()) return [];
    if (this.isWork()) {
      const c = this.work.context(this.active.id);
      return [
        "work_context",
        "artifact_read",
        "artifact_stage",
        ...(c.authority.allowSearch ? ["web_search", "web_fetch"] : []),
      ];
    }
    return this.isHeartbeat()
      ? [
          "memory_list",
          ...(this.heartbeat.policy().searchEnabled
            ? ["web_search", "web_fetch"]
            : []),
        ]
      : ALLOWED;
  }
  async onUserInput() {
    this.heartbeat.invalidate("收到新的用户输入，旧检查已失效");
    this.upkeep.invalidate("收到新用户输入，旧整理失效");
    this.work?.invalidate("收到新用户输入，按最新情况继续");
    if (this.isBackground()) await this.fail("优先处理用户的新消息");
    else void this.pump();
  }
  async updatePolicy(patch: any, revision: number) {
    const result = this.heartbeat.update(patch, revision);
    if (this.isHeartbeat()) await this.fail("关心设置已改变");
    return result;
  }
  async checkNow() {
    if (this.active || this.pumping || this.stopping || this.store.next())
      throw new InputError("正在处理对话或检查，请稍后再试", 409);
    if (!this.heartbeat.policy().enabled)
      throw new InputError("请先开启主动关心");
    const claimed = this.heartbeat.claim(true);
    if (claimed && !("skipped" in claimed)) {
      this.manualClaim = claimed;
      await this.pump();
    }
    return { ok: true, checkId: claimed?.checkId };
  }
  async ensureWorker() {
    const mode = this.isWork()
      ? "work"
      : this.isUpkeep()
        ? "upkeep"
        : this.isHeartbeat()
          ? "heartbeat"
          : "chat";
    const profile =
      mode +
      (mode === "heartbeat" && this.heartbeat.policy().searchEnabled
        ? "-search"
        : this.isWork() &&
            this.work.context(this.active.id).authority.allowSearch
          ? "-search"
          : "");
    if (this.child && this.workerMode !== profile) await this.stopWorker();
    if (this.child) return;
    this.workerMode = profile;
    if (!this.config) throw new Error("未配置 DeepSeek");
    const home = join(this.dir, mode === "chat" ? "dsh" : "dsh-" + mode),
      workspace = join(
        this.dir,
        mode === "chat" ? "workspace" : "workspace-" + mode,
      );
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
      TZ: "Asia/Shanghai",
      DSH_HOME: home,
      PA_WORKSPACE: workspace,
      DEEPSEEK_API_KEY: this.config.apiKey,
      PA_MODEL: this.config.model,
      PA_RUN_MODE: mode,
      PA_WORK_SEARCH:
        this.isWork() && this.work.context(this.active.id).authority.allowSearch
          ? "1"
          : "0",
      PA_HEARTBEAT_SEARCH: this.heartbeat.policy().searchEnabled ? "1" : "0",
      PA_BRIDGE_URL: this.bridgeUrl,
      PA_BRIDGE_TOKEN: this.token,
      NODE_USE_ENV_PROXY: "1",
      PA_MVP_TEST_COMPACTION: process.env.PA_MVP_TEST_COMPACTION,
    };
    for (const k of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ])
      if (process.env[k]) env[k] = process.env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    env.no_proxy = env.NO_PROXY;
    this.child = fork(resolve("runtime/worker.mjs"), [], {
      execPath: resolve(".runtime/node_modules/node/bin/node"),
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const child = this.child;
    const log = (b: Buffer) => {
      const clean = b.toString().split(this.config!.apiKey).join("[REDACTED]");
      appendFileSync(join(this.dir, "runtime.log"), clean, { mode: 0o600 });
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.on("message", (m: any) => {
      if (child !== this.child) return;
      if (m.type === "ready") this.ready = true;
      const r = this.active;
      if (!r) return;
      if (m.type === "provider-issue") {
        this.providerIssue =
          m.status === 503
            ? "DeepSeek 服务繁忙（503）"
            : m.status === 429
              ? "DeepSeek 请求受限（429）"
              : "模型服务暂时不可用";
        if (
          this.isBackground() &&
          (
            this.store.db
              .prepare("SELECT retry_count FROM runs WHERE id=?")
              .get(r.id) as any
          ).retry_count >= 2
        ) {
          void this.fail(this.providerIssue + "；本轮重试预算已用尽");
          return;
        }
        this.store.db
          .prepare("UPDATE runs SET retry_count=retry_count+1 WHERE id=?")
          .run(r.id);
        if (this.isHeartbeat())
          this.store.db
            .prepare(
              "UPDATE heartbeat_checks SET reason=? WHERE run_id=? AND status='running'",
            )
            .run(this.providerIssue + "，正在限时重试", r.id);
      }
      if (m.type === "receipt" && m.id)
        this.store.db
          .prepare("UPDATE runs SET inbox_id=? WHERE id=?")
          .run(m.id, r.id);
      if (m.type === "compact")
        this.store.setMeta(
          "last_compaction",
          JSON.stringify({ runId: r.id, type: m.eventType, data: m.data }),
        );
      if (m.type === "result") {
        if (Date.now() - r.started_at > this.deadline()) {
          void this.fail("执行期限已过，恢复后没有发布过时回复。");
          return;
        }
        const reason = m.turnEnd?.reason;
        if (reason?.kind !== "completed" || !m.text?.trim()) {
          void this.fail(
            (this.providerIssue ? this.providerIssue + "；" : "") +
              "模型执行未正常完成，请查看本轮已保存动作。",
          );
          return;
        }
        if (!this.store.active(r.session_id).inbox_id) {
          void this.fail("缺少输入接收证据，未发布回复。");
          return;
        }
        this.store.db
          .prepare("UPDATE runs SET usage=? WHERE id=?")
          .run(JSON.stringify(m.usage || {}), r.id);
        if (
          r.profile_revision !== this.profile.get().revision &&
          this.store.active(r.session_id).profile_revision !==
            this.profile.get().revision
        ) {
          void this.fail("助理设置已变化，旧结果不发布");
          return;
        }
        if (this.isWork()) {
          this.work.settle(r.id, m.text);
        } else if (r.trigger_type === "memory_upkeep") {
          this.upkeep.settle(r.id, m.text);
        } else if (r.trigger_type === "heartbeat") {
          try {
            this.heartbeat.settle(r.id, m.text);
          } catch (e) {
            this.heartbeat.failed(r.id, "提案处理失败，未发布");
          }
        } else {
          this.store.finish(r.id, m.text, {
            turnEnd: m.turnEnd,
            eventTypes: m.eventTypes,
          });
          this.loadedSession = m.sessionId;
          this.store.setMeta("session_id", m.sessionId);
          this.store.setMeta("session_epoch", String(r.context_epoch));
          this.store.setMeta(
            "session_profile_revision",
            String(r.profile_revision),
          );
        }
        this.active = undefined;
        clearTimeout(this.timer);
        void this.pump();
      }
      if (m.type === "error") {
        appendFileSync(join(this.dir, "runtime.log"), String(m.error) + "\n", {
          mode: 0o600,
        });
        void this.fail(
          "本轮执行失败；已完成的动作保留。可重新发送，详细错误记录在本机运行日志。",
        );
      }
    });
    child.on("error", () => {
      if (child === this.child && this.active) void this.fail("运行时启动失败");
    });
    child.on("exit", () => {
      if (child === this.child) {
        this.child = undefined;
        this.ready = false;
        this.loadedSession = undefined;
        if (this.active) {
          this.upkeep.failed(
            this.active.id,
            "运行时中断，未自动重放",
            "interrupted",
          );
          this.heartbeat.failed(
            this.active.id,
            "运行时中断，未自动重放",
            "interrupted",
          );
          if (this.isWork())
            this.work.failed(
              this.active.id,
              "运行时中断，结果待核对",
              "unknown",
              false,
            );
          this.store.fail(
            this.active.id,
            "运行时中断，未自动重放。",
            "interrupted",
          );
          if (!this.isBackground()) this.store.setMeta("session_id", "");
          this.active = undefined;
          clearTimeout(this.timer);
        }
        void this.pump();
      }
    });
  }
  async pump() {
    if (!this.closing && this.bridgeUrl) this.work.tick();
    if (
      this.pumping ||
      this.stopping ||
      this.closing ||
      this.active ||
      !this.bridgeUrl
    )
      return;
    this.pumping = true;
    try {
      let r = this.store.next() || this.manualClaim || this.work.claim();
      this.manualClaim = undefined;
      if (!r) {
        const claimed = this.heartbeat.claim();
        r = claimed && !("skipped" in claimed) ? claimed : this.upkeep.claim();
      }
      if (!r) return;
      this.store.expireContext();
      const epoch = Number(this.store.getMeta("context_epoch") || 0);
      const old = this.store.getMeta("session_id");
      const session =
        r.trigger_type === "user_message" &&
        old &&
        Number(this.store.getMeta("session_epoch") || 0) === epoch &&
        Number(this.store.getMeta("session_profile_revision") || 1) ===
          this.profile.get().revision
          ? old
          : randomUUID();
      this.store.startRun(r.id, session);
      this.store.db
        .prepare("UPDATE runs SET profile_revision=? WHERE id=?")
        .run(this.profile.get().revision, r.id);
      this.active = this.store.active(session);
      this.searchCalls = 0;
      this.webKinds = {};
      this.providerIssue = "";
      await this.ensureWorker();
      const deadline = this.deadline();
      this.timer = setTimeout(
        () =>
          void this.fail(
            (this.providerIssue ? this.providerIssue + "；" : "") +
              "执行超过时限，已停止；已完成动作保留。",
          ),
        deadline,
      );
      this.child!.send({
        type: "run",
        sessionId: session,
        resume: !!old && session === old && this.loadedSession !== session,
        text: r.body,
      });
    } catch (e) {
      if (this.active) await this.fail((e as Error).message);
    } finally {
      this.pumping = false;
      if (!this.active && !this.closing && !this.stopping && this.store.next())
        setImmediate(() => void this.pump());
    }
  }
  async stopWorker() {
    if (this.workerStop) return this.workerStop;
    const child = this.child;
    this.child = undefined;
    this.loadedSession = undefined;
    this.ready = false;
    if (!child || child.exitCode !== null) return;
    this.workerStop = new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 12000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        child.send({ type: "stop" });
      } catch {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          clearTimeout(kill);
          resolve();
        }
      }
    });
    try {
      await this.workerStop;
    } finally {
      this.workerStop = undefined;
    }
  }
  async fail(reason: string) {
    if (this.stopping) return;
    this.stopping = true;
    const r = this.active;
    this.active = undefined;
    clearTimeout(this.timer);
    if (r) {
      this.upkeep?.failed(r.id, reason);
      this.heartbeat?.failed(r.id, reason);
      this.work?.failed(r.id, reason);
      this.store.fail(r.id, reason);
    }
    if (r?.trigger_type === "user_message")
      this.store.setMeta("session_id", "");
    await this.stopWorker();
    this.stopping = false;
    void this.pump();
  }
  async updateProfile(patch: any, revision: number) {
    const result = this.profile.update(patch, revision);
    this.upkeep.invalidate("助理设置已改变");
    this.heartbeat.invalidate("助理设置已改变");
    this.work?.invalidate("助理设置已改变");
    await this.fail("助理设置已改变，本轮旧结果不发布");
    return result;
  }
  async updateUpkeep(enabled: boolean, revision: number) {
    const result = this.upkeep.update(enabled, revision);
    if (this.isUpkeep()) await this.fail("整理设置已改变");
    return result;
  }
  async organizeNow() {
    if (this.active || this.pumping || this.stopping || this.store.next())
      throw new InputError("正在处理其他工作，请稍后再整理", 409);
    const r = this.upkeep.claim(true);
    if (r) {
      this.manualClaim = r;
      await this.pump();
    }
    return { ok: true };
  }
  async invalidate() {
    this.upkeep.invalidate("个人记忆已改变，旧整理失效");
    this.heartbeat.invalidate("个人记忆已改变，旧检查已失效");
    this.work?.invalidate("个人记忆已改变，旧结果失效");
    await this.fail(
      "个人记忆已被修改，本轮旧上下文失效。请重新发送需要继续的问题。",
    );
  }
  async cancel(id: string) {
    if (this.active?.message_id === id)
      await this.fail("用户已停止本轮回复；已成功保存的记忆保留。");
    else this.store.cancel(id);
  }
  async close() {
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.timer);
    if (this.active) {
      if (this.isWork())
        this.work.failed(
          this.active.id,
          "服务停止，结果待核对",
          "unknown",
          false,
        );
      this.upkeep.failed(
        this.active.id,
        "服务停止，旧整理不重放",
        "interrupted",
      );
      this.heartbeat.failed(
        this.active.id,
        "服务停止，旧检查不自动重放",
        "interrupted",
      );
      this.store.fail(
        this.active.id,
        "服务停止，本轮未自动重放。",
        "interrupted",
      );
      if (!this.isBackground()) this.store.setMeta("session_id", "");
      this.active = undefined;
    }
    await this.stopWorker();
  }
  internal(path: string, b: any) {
    const r = this.store.active(b.session);
    if (!this.active || this.active.id !== r.id)
      throw new InputError("执行已失效", 409);
    if (r.started_at && Date.now() - r.started_at > this.deadline()) {
      void this.fail("执行期限已过，恢复后停止旧执行。");
      throw new InputError("执行期限已过", 409);
    }
    const background = r.trigger_type !== "user_message";
    const upkeep = r.trigger_type === "memory_upkeep";
    const work = WORK_MODES.includes(r.trigger_type);
    const allowed = this.toolsForRun();
    if (upkeep) this.upkeep.context(r.id);
    else if (work) this.work.context(r.id);
    else if (background) this.heartbeat.context(r.id);
    if (path === "memories")
      return work
        ? this.work.context(r.id).memories
        : background
          ? this.heartbeat.context(r.id).memories
          : this.store.context().memories;
    if (path === "context") {
      const base = upkeep
        ? this.upkeep.context(r.id)
        : work
          ? this.work.context(r.id)
          : background
            ? this.heartbeat.context(r.id)
            : {
                ...this.store.runtimeContext(b.session),
                ...this.heartbeat.chatContext(r.message_id),
                ...this.work.chatContext(r.message_id),
              };
      return {
        ...base,
        agentProfile: this.profile.context(),
        memoryOverview: upkeep ? [] : this.upkeep.current()?.overview || [],
        memoryReviewCandidates: upkeep
          ? []
          : (this.upkeep.current()?.candidates || []).map((g: any) => ({
              kind: g.kind,
              ids: g.ids,
            })),
      };
    }
    if (path === "work-context")
      return work
        ? this.work.context(r.id)
        : this.work.chatContext(r.message_id);
    if (path === "work-action") {
      if (background) throw new InputError("后台不能管理用户委托", 403);
      return this.work.command(b.name, b.args, r.id, String(b.callId));
    }
    if (path === "artifact-stage") {
      if (!work) throw new InputError("只允许当前工作保存草稿", 403);
      return this.work.stage(r.id, b.args);
    }
    if (path === "artifact-read")
      return work ? this.work.readForRun(r.id, b.id) : this.work.artifact(b.id);
    if (path === "agent-profile") {
      if (background) throw new InputError("后台不能修改助理设置", 403);
      return this.profile.action(r.id, String(b.callId), b.args);
    }
    if (upkeep && !["step", "preview", "usage"].includes(path))
      throw new InputError("整理运行不允许工具或写操作", 403);
    if (path === "care-policy") {
      if (background) throw new InputError("后台不能修改联系设置", 403);
      return this.heartbeat.action(r.id, String(b.callId), b.args);
    }
    if (path === "web-failure") {
      if (work)
        this.store.db
          .prepare("UPDATE work_runs SET search_failed=1 WHERE run_id=?")
          .run(r.id);
      if (this.isHeartbeat())
        this.store.db
          .prepare("UPDATE heartbeat_checks SET search_failed=1 WHERE run_id=?")
          .run(r.id);
      return { ok: true };
    }
    if (path === "step") {
      if (
        !Array.isArray(b.tools) ||
        b.tools.some((x: any) => !allowed.includes(x)) ||
        b.tools.length !== allowed.length
      )
        throw new InputError("运行时工具集合不符合约定", 403);
      if (upkeep && r.steps >= 1)
        throw new InputError("整理模型步骤预算已用尽", 409);
      if (work && r.steps >= 8) throw new InputError("工作步骤预算已用尽", 409);
      if (this.isHeartbeat() && r.steps >= 3)
        throw new InputError("心跳模型步骤预算已用尽", 409);
      this.store.step(b.session, b.tools);
      return { ok: true };
    }
    if (path === "authorize") {
      if (!allowed.includes(b.name)) throw new InputError("工具未授权", 403);
      if (b.name.startsWith("web_")) {
        if (work) {
          const start = Date.parse(
            new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) +
              "T00:00:00+08:00",
          );
          const used = (
            this.store.db
              .prepare(
                "SELECT COALESCE(SUM(web_calls),0) n FROM runs WHERE trigger_type IN ('heartbeat','task','goal_step') AND created_at>=?",
              )
              .get(start) as any
          ).n;
          if ((this.webKinds[b.name] || 0) >= 2 || used >= 12)
            throw new InputError("后台搜索预算已用尽", 409);
          this.webKinds[b.name] = (this.webKinds[b.name] || 0) + 1;
        }
        if (this.isHeartbeat()) {
          const start = Date.parse(
            new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) +
              "T00:00:00+08:00",
          );
          const total = (
            this.store.db
              .prepare(
                "SELECT COALESCE(SUM(web_calls),0) n FROM runs WHERE trigger_type IN ('heartbeat','task','goal_step') AND created_at>=?",
              )
              .get(start) as any
          ).n;
          if (
            total >= 12 ||
            (this.webKinds[b.name] || 0) >= 1 ||
            this.heartbeat.counts().searches >=
              Math.min(6, this.heartbeat.policy().searchDailyLimit)
          ) {
            this.store.db
              .prepare(
                "UPDATE heartbeat_checks SET search_failed=CASE WHEN search_failed=1 THEN 1 ELSE 2 END WHERE run_id=?",
              )
              .run(r.id);
            throw new InputError("心跳搜索预算已用尽", 409);
          }
          this.webKinds[b.name] = (this.webKinds[b.name] || 0) + 1;
        }
        if (++this.searchCalls > 8) throw new InputError("搜索预算已用尽", 409);
        this.store.db
          .prepare("UPDATE runs SET web_calls=? WHERE id=?")
          .run(this.searchCalls, r.id);
      }
      return { ok: true };
    }
    if (path === "memory") {
      if (background) throw new InputError("心跳只允许读取记忆", 403);
      if (!["memory_save", "memory_forget"].includes(b.name))
        throw new InputError("记忆操作无效");
      return this.store.memoryAction(
        b.session,
        String(b.callId),
        b.name,
        b.args,
      );
    }
    if (path === "search-policy")
      return { fault: this.testSearchFault || null };
    if (path === "sources") {
      this.store.recordSources(b.session, b.sources);
      return { ok: true };
    }
    if (path === "fetch-authorize") {
      let u: URL;
      try {
        u = new URL(b.url);
      } catch {
        throw new InputError("网址无效");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(
          u.hostname,
        ) ||
        !u.hostname.includes(".") ||
        u.hostname.endsWith(".local")
      )
        throw new InputError("只允许公开网页", 403);
      if (
        !r.body.includes(b.url) &&
        !this.store.db
          .prepare("SELECT id FROM sources WHERE run_id=? AND url=?")
          .get(r.id, b.url)
      )
        throw new InputError("只能读取本轮用户提供或搜索得到的网址", 403);
      return { ok: true };
    }
    if (path === "preview") {
      if (background) return { ok: true };
      this.store.db
        .prepare("UPDATE runs SET preview=? WHERE id=?")
        .run(String(b.text || "").slice(0, 50000), r.id);
      return { ok: true };
    }
    if (path === "usage") {
      const total = JSON.parse(r.usage);
      for (const [k, v] of Object.entries(b.usage || {}))
        if (typeof v === "number") total[k] = (total[k] || 0) + v;
      this.store.db
        .prepare("UPDATE runs SET usage=? WHERE id=?")
        .run(JSON.stringify(total), r.id);
      return { ok: true };
    }
    throw new InputError("接口不存在", 404);
  }
}
