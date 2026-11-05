import { randomUUID, createHash } from "node:crypto";
import { Store, InputError, text } from "./store.js";
import { migrateDeliveries } from "./work-schema.js";
export const INTERVAL = 30 * 60 * 1000;
export const TOPICS: Record<string, string> = {
  music_practice: "练琴与音乐练习",
  music_events: "音乐欣赏与演出",
  work_rest: "工作与休息",
  travel: "出行",
  daily_life: "日常生活",
};
export type Policy = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  dailyLimit: number;
  minGapMinutes: number;
  topicCooldownHours: number;
  recentMinutes: number;
  searchEnabled: boolean;
  modelDailyLimit: number;
  searchDailyLimit: number;
  pausedUntil: number | null;
  mutedTopics: Record<string, number | null>;
  revision: number;
  timezone: string;
};
export const DEFAULT_POLICY: Policy = {
  enabled: false,
  startHour: 8,
  endHour: 22,
  dailyLimit: 3,
  minGapMinutes: 120,
  topicCooldownHours: 24,
  recentMinutes: 10,
  searchEnabled: false,
  modelDailyLimit: 28,
  searchDailyLimit: 6,
  pausedUntil: null,
  mutedTopics: {},
  revision: 1,
  timezone: "Asia/Shanghai",
};
export function localDay(now: number) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
export function dayStart(now: number) {
  return Date.parse(localDay(now) + "T00:00:00+08:00");
}
export function topicFor(content: string) {
  if (/加班|工作|休息|睡眠|睡觉/.test(content)) return "work_rest";
  if (/练琴|吉他|钢琴|贝斯|架子鼓|演奏|乐器|弹琴|唱歌/.test(content))
    return "music_practice";
  if (/音乐|摇滚|演出|乐队|rock|shoegaze|indie/i.test(content))
    return "music_events";
  if (/旅行|出行|飞机|机票|酒店/.test(content)) return "travel";
  return "daily_life";
}
const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export class Heartbeat {
  modelAvailable = true;
  constructor(
    public store: Store,
    public now = () => Date.now(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS contact_policy(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS system_tasks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,next_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat_checks(id TEXT PRIMARY KEY,occurrence TEXT UNIQUE NOT NULL,trigger TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,run_id TEXT UNIQUE,snapshot TEXT NOT NULL DEFAULT '{}',decision TEXT NOT NULL DEFAULT '{}',search_failed INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS heartbeat_checks_created ON heartbeat_checks(created_at DESC);
   CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL,check_id TEXT UNIQUE NOT NULL,message_id TEXT UNIQUE NOT NULL,topic TEXT NOT NULL,body_hash TEXT NOT NULL,created_at INTEGER NOT NULL,replied_at INTEGER,seen_at INTEGER,reason TEXT NOT NULL,memory_refs TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS message_links(message_id TEXT PRIMARY KEY,reply_to TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS contact_actions(run_id TEXT NOT NULL,call_id TEXT NOT NULL,args TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,call_id));`);
    for (const [name, type] of [
      ["feedback_at", "INTEGER"],
      ["feedback", "TEXT"],
    ]) {
      if (
        !(
          store.db.prepare("PRAGMA table_info(deliveries)").all() as any[]
        ).some((c) => c.name === name)
      )
        store.db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`);
    }
    migrateDeliveries(store);
    store.db
      .prepare("INSERT OR IGNORE INTO contact_policy VALUES(1,?)")
      .run(JSON.stringify(DEFAULT_POLICY));
    store.db
      .prepare(
        "INSERT OR IGNORE INTO system_tasks VALUES('heartbeat','heartbeat',?)",
      )
      .run(this.now() + INTERVAL);
    store.db
      .prepare(
        "UPDATE runs SET status='interrupted',reason='后台中断；旧检查不自动重放' WHERE trigger_type='heartbeat' AND status IN ('queued','running')",
      )
      .run();
    store.db
      .prepare(
        "UPDATE heartbeat_checks SET status='interrupted',reason='后台中断；未自动重放旧检查',finished_at=? WHERE status='running'",
      )
      .run(this.now());
  }
  policy(): Policy {
    return JSON.parse(
      (
        this.store.db
          .prepare("SELECT body FROM contact_policy WHERE id=1")
          .get() as any
      ).body,
    );
  }
  update(patch: any, revision: number) {
    return this.store.transaction(() => {
      const old = this.policy();
      if (revision !== old.revision)
        throw new InputError("设置已变化，请刷新后重试", 409);
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new InputError("设置无效");
      const allowed = [
        "enabled",
        "startHour",
        "endHour",
        "dailyLimit",
        "minGapMinutes",
        "topicCooldownHours",
        "recentMinutes",
        "searchEnabled",
        "modelDailyLimit",
        "searchDailyLimit",
        "pausedUntil",
        "mutedTopics",
      ];
      if (Object.keys(patch).some((k) => !allowed.includes(k)))
        throw new InputError("不支持的设置项");
      const p = { ...old, ...patch, revision: old.revision + 1 };
      for (const k of ["enabled", "searchEnabled"] as const)
        if (typeof p[k] !== "boolean") throw new InputError("开关值无效");
      for (const [k, min, max] of [
        ["startHour", 0, 23],
        ["endHour", 1, 24],
        ["dailyLimit", 1, 6],
        ["minGapMinutes", 30, 1440],
        ["topicCooldownHours", 1, 168],
        ["recentMinutes", 1, 60],
        ["modelDailyLimit", 1, 28],
        ["searchDailyLimit", 0, 6],
      ] as const) {
        if (!Number.isInteger(p[k]) || p[k] < min || p[k] > max)
          throw new InputError("设置数值超出范围");
      }
      if (p.startHour >= p.endHour)
        throw new InputError("联系时段请设置为同一天内的开始和结束时间");
      const validUntil = (v: any) =>
        v === null ||
        (Number.isSafeInteger(v) &&
          v > this.now() &&
          v <= this.now() + 366 * 86400000);
      if (
        !Object.hasOwn(patch, "pausedUntil") &&
        p.pausedUntil &&
        p.pausedUntil <= this.now()
      )
        p.pausedUntil = null;
      if (!Object.hasOwn(patch, "mutedTopics"))
        p.mutedTopics = Object.fromEntries(
          Object.entries(p.mutedTopics).filter(
            ([, v]) => v === null || (v as number) > this.now(),
          ),
        );
      if (!validUntil(p.pausedUntil)) throw new InputError("暂停截止时间无效");
      if (
        !p.mutedTopics ||
        typeof p.mutedTopics !== "object" ||
        Array.isArray(p.mutedTopics) ||
        Object.entries(p.mutedTopics).some(
          ([k, v]) => !TOPICS[k] || !validUntil(v),
        )
      )
        throw new InputError("话题暂停设置无效");
      this.store.db
        .prepare("UPDATE contact_policy SET body=? WHERE id=1")
        .run(JSON.stringify(p));
      if (Object.hasOwn(patch, "mutedTopics"))
        for (const topic of Object.keys(TOPICS)) {
          if (
            old.mutedTopics[topic] !== p.mutedTopics[topic] ||
            Object.hasOwn(old.mutedTopics, topic) !==
              Object.hasOwn(p.mutedTopics, topic)
          )
            this.topicFeedback(
              topic,
              Object.hasOwn(p.mutedTopics, topic) ? "paused" : "resumed",
            );
        }
      if (p.enabled && !old.enabled)
        this.store.db
          .prepare("UPDATE system_tasks SET next_at=? WHERE id='heartbeat'")
          .run(this.now() + INTERVAL);
      this.invalidate("关心设置已改变，旧检查已失效");
      return p;
    });
  }
  invalidate(reason: string) {
    const rows = this.store.db
      .prepare("SELECT run_id FROM heartbeat_checks WHERE status='running'")
      .all() as any[];
    for (const r of rows)
      if (r.run_id) this.store.fail(r.run_id, reason, "cancelled");
    this.store.db
      .prepare(
        "UPDATE heartbeat_checks SET status='cancelled',reason=?,finished_at=? WHERE status='running'",
      )
      .run(reason, this.now());
  }
  memories() {
    return this.store.context(this.now()).memories as any[];
  }
  latestUser() {
    return (
      (this.store.db
        .prepare(
          "SELECT id,created_at FROM messages WHERE role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get() as any) || null
    );
  }
  version() {
    return digest(
      this.memories().map((m) => [m.id, m.revision, m.expires_at, m.content]),
    );
  }
  counts() {
    const start = dayStart(this.now());
    return {
      contacts: (
        this.store.db
          .prepare(
            "SELECT COUNT(*) n FROM deliveries WHERE obligation='discretionary' AND created_at>=?",
          )
          .get(start) as any
      ).n,
      models: (
        this.store.db
          .prepare(
            "SELECT COUNT(*) n FROM runs WHERE trigger_type IN ('heartbeat','task','goal_step') AND created_at>=?",
          )
          .get(start) as any
      ).n,
      searches: (
        this.store.db
          .prepare(
            "SELECT COALESCE(SUM(web_calls),0) n FROM runs WHERE trigger_type='heartbeat' AND created_at>=?",
          )
          .get(start) as any
      ).n,
    };
  }
  gate(includeModelBudget = true) {
    const p = this.policy(),
      now = this.now(),
      n = this.counts(),
      hour = new Date(now + 8 * 3600000).getUTCHours();
    if (!p.enabled) return "主动关心已关闭";
    if (!this.modelAvailable) return "未配置 DeepSeek，未调用模型";
    if (p.pausedUntil && p.pausedUntil > now) return "暂停期间，暂不联系";
    if (hour < p.startHour || hour >= p.endHour) return "安静时段，暂不联系";
    if (!this.memories().length) return "还没有有效记忆，先聊聊你在意的事";
    if (n.contacts >= p.dailyLimit) return "今日主动消息已达上限";
    if (includeModelBudget && n.models >= Math.min(28, p.modelDailyLimit))
      return "今日模型检查预算已用完";
    const last = this.store.db
      .prepare(
        "SELECT created_at FROM deliveries WHERE obligation='discretionary' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as any;
    if (last && now - last.created_at < p.minGapMinutes * 60000)
      return "距上次联系较近，保持安静";
    const user = this.latestUser();
    if (user && now - user.created_at < p.recentMinutes * 60000)
      return "刚刚交流过，暂不另起问候";
    return null;
  }
  topicBlocked(topic: string) {
    const p = this.policy(),
      now = this.now();
    if (
      Object.hasOwn(p.mutedTopics, topic) &&
      (p.mutedTopics[topic] === null || p.mutedTopics[topic]! > now)
    )
      return "该话题已暂停";
    const last = this.store.db
      .prepare(
        "SELECT * FROM deliveries WHERE source='heartbeat' AND topic=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(topic) as any;
    if (last && now - last.created_at < p.topicCooldownHours * 3600000)
      return "该话题处于冷却期";
    if (last && !last.replied_at && !last.feedback_at)
      return "等待你对上次该话题的反馈，不重复追问";
    return null;
  }
  snapshot() {
    const memories = this.memories();
    const groups = Object.entries(TOPICS).map(([id, label]) => ({
      id,
      label,
      blocked: this.topicBlocked(id),
      memoryIds: memories
        .filter((m) => topicFor(m.content) === id)
        .map((m) => m.id),
    }));
    let budget = 8000;
    const selected = memories.slice(0, 24).filter((m) => {
      budget -= m.content.length;
      return budget >= 0;
    });
    return {
      policy: this.policy(),
      memoryVersion: this.version(),
      latestUser: this.latestUser()?.id || null,
      now: this.now(),
      localTime: new Date(this.now()).toLocaleString("sv-SE", {
        timeZone: "Asia/Shanghai",
      }),
      memories: selected,
      topics: groups,
      recent: (
        this.store.db
          .prepare(
            "SELECT id,role,body,created_at FROM messages WHERE status='completed' AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 6",
          )
          .all(Number(this.store.getMeta("context_epoch") || 0)) as any[]
      )
        .reverse()
        .map((m) => ({
          ...m,
          body: m.body.slice(0, 1000),
          truncated: m.body.length > 1000,
        })),
      recentContacts: this.store.db
        .prepare(
          "SELECT topic,created_at,replied_at,feedback_at,feedback,reason FROM deliveries WHERE source='heartbeat' ORDER BY created_at DESC LIMIT 8",
        )
        .all(),
    };
  }
  claim(manual = false) {
    return this.store.transaction(() => {
      const now = this.now(),
        task = this.store.db
          .prepare("SELECT * FROM system_tasks WHERE id='heartbeat'")
          .get() as any;
      if (!this.policy().enabled) return null;
      if (!manual && task.next_at > now) return null;
      if (
        this.store.db
          .prepare("SELECT id FROM heartbeat_checks WHERE status='running'")
          .get()
      )
        return null;
      this.store.expireContext(now);
      if (manual) {
        const last = this.store.db
          .prepare(
            "SELECT created_at FROM heartbeat_checks ORDER BY created_at DESC LIMIT 1",
          )
          .get() as any;
        if (last && now - last.created_at < 60000)
          throw new InputError("请至少间隔一分钟再检查", 409);
      }
      const occurrence = manual
        ? "manual:" + randomUUID()
        : "scheduled:" + task.next_at;
      if (!manual)
        this.store.db
          .prepare("UPDATE system_tasks SET next_at=? WHERE id='heartbeat'")
          .run(now + INTERVAL);
      const id = randomUUID(),
        reason =
          this.gate() ||
          (!this.snapshot().topics.some((t) => t.memoryIds.length && !t.blocked)
            ? "所有相关话题均在暂停、冷却或等待反馈"
            : null);
      this.store.db
        .prepare(
          "INSERT INTO heartbeat_checks(id,occurrence,trigger,status,reason,created_at,finished_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          occurrence,
          manual ? "manual" : "scheduled",
          reason ? "skipped" : "running",
          reason || "正在检查",
          now,
          reason ? now : null,
        );
      if (reason) return { checkId: id, skipped: true };
      const runId = randomUUID(),
        snapshot = this.snapshot();
      this.store.db
        .prepare(
          "INSERT INTO runs(id,message_id,status,reason,created_at,trigger_type,trigger_id) VALUES(?,NULL,'queued','心跳检查',?,'heartbeat',?)",
        )
        .run(runId, now, id);
      this.store.db
        .prepare("UPDATE heartbeat_checks SET run_id=?,snapshot=? WHERE id=?")
        .run(runId, JSON.stringify(snapshot), id);
      return {
        id: runId,
        body: "请检查当前记忆与联系策略，决定联系或静默。仅返回约定 JSON 提案。",
        trigger_type: "heartbeat",
        trigger_id: id,
        checkId: id,
      };
    });
  }
  context(runId: string) {
    const c = this.store.db
      .prepare("SELECT * FROM heartbeat_checks WHERE run_id=?")
      .get(runId) as any;
    if (!c || c.status !== "running")
      throw new InputError("心跳授权已失效", 409);
    return { ...JSON.parse(c.snapshot), mode: "heartbeat", checkId: c.id };
  }
  settle(runId: string, raw: string) {
    return this.store.transaction(() => {
      const c = this.store.db
        .prepare("SELECT * FROM heartbeat_checks WHERE run_id=?")
        .get(runId) as any;
      const r = this.store.db
        .prepare("SELECT * FROM runs WHERE id=?")
        .get(runId) as any;
      if (!c || c.status !== "running" || r?.status !== "running") return;
      const snapshot = JSON.parse(c.snapshot);
      let invalid = this.gate(false);
      if (
        this.policy().revision !== snapshot.policy.revision ||
        this.version() !== snapshot.memoryVersion ||
        (this.latestUser()?.id || null) !== snapshot.latestUser
      )
        invalid = "检查期间记忆、设置或用户输入发生变化";
      if (invalid) {
        this.finish(c, "cancelled", invalid);
        return;
      }
      if (c.search_failed) {
        this.finish(
          c,
          c.search_failed === 2 ? "skipped" : "failed",
          c.search_failed === 2
            ? "心跳搜索预算已用尽，本轮没有交付"
            : "搜索服务未完成，本轮没有交付",
        );
        return;
      }
      let proposal: any;
      try {
        proposal = JSON.parse(
          raw
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, ""),
        );
      } catch {
        this.finish(c, "failed", "模型提案格式无效，没有发布");
        return;
      }
      if (
        !proposal ||
        !["contact", "silent"].includes(proposal.decision) ||
        typeof proposal.reason !== "string" ||
        !proposal.reason.trim() ||
        proposal.reason.length > 500
      ) {
        this.finish(c, "failed", "模型提案不符合契约");
        return;
      }
      if (proposal.decision === "silent") {
        this.finish(c, "silent", proposal.reason, proposal);
        return;
      }
      const topic = proposal.topic,
        refs = proposal.memoryIds;
      if (
        !TOPICS[topic] ||
        !Array.isArray(refs) ||
        !refs.length ||
        refs.some(
          (id: any) =>
            typeof id !== "string" ||
            !snapshot.memories.some((m: any) => m.id === id),
        ) ||
        !refs.some((id: string) =>
          snapshot.memories.some(
            (m: any) => m.id === id && topicFor(m.content) === topic,
          ),
        ) ||
        typeof proposal.message !== "string" ||
        !proposal.message.trim() ||
        proposal.message.length > 1200
      ) {
        this.finish(c, "failed", "提案缺少有效记忆依据或内容无效");
        return;
      }
      const blocked = this.topicBlocked(topic);
      if (blocked) {
        this.finish(c, "skipped", blocked);
        return;
      }
      const urls = (
        this.store.db
          .prepare("SELECT url FROM sources WHERE run_id=?")
          .all(runId) as any[]
      ).map((x) => x.url);
      const cited =
        proposal.message.match(/https?:\/\/[^\s)\]<>）。，；]+/g) || [];
      if (cited.some((u: string) => !urls.includes(u))) {
        this.finish(c, "failed", "提案引用了未经本轮搜索核验的链接");
        return;
      }
      const fingerprint = digest(proposal.message.replace(/\s/g, ""));
      if (
        this.store.db
          .prepare("SELECT id FROM deliveries WHERE body_hash=?")
          .get(fingerprint)
      ) {
        this.finish(c, "skipped", "相同内容已交付");
        return;
      }
      const mid = "proactive-" + c.id,
        now = this.now();
      this.store.db
        .prepare("INSERT INTO messages VALUES(?,?,'assistant',?,'completed',?)")
        .run(mid, mid, proposal.message, now);
      this.store.db
        .prepare(
          "INSERT INTO deliveries(id,run_id,check_id,message_id,topic,body_hash,created_at,reason,memory_refs) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          runId,
          c.id,
          mid,
          topic,
          fingerprint,
          now,
          proposal.reason,
          JSON.stringify(refs),
        );
      this.finish(c, "delivered", proposal.reason, proposal);
    });
  }
  finish(c: any, status: string, reason: string, decision: any = {}) {
    this.store.db
      .prepare(
        "UPDATE heartbeat_checks SET status=?,reason=?,decision=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(status, reason, JSON.stringify(decision), this.now(), c.id);
    this.store.db
      .prepare(
        "UPDATE runs SET status=?,reason=?,preview='',result=? WHERE id=? AND status='running'",
      )
      .run(
        ["delivered", "silent", "skipped"].includes(status)
          ? "succeeded"
          : status,
        reason,
        JSON.stringify(decision),
        c.run_id,
      );
  }
  failed(runId: string, reason: string, status = "failed") {
    const c = this.store.db
      .prepare("SELECT * FROM heartbeat_checks WHERE run_id=?")
      .get(runId) as any;
    if (c?.status === "running") this.finish(c, status, reason);
  }
  link(messageId: string, replyTo?: string) {
    let id = replyTo;
    if (!id) {
      const last = this.store.db
        .prepare(
          "SELECT id FROM messages WHERE id<>? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(messageId) as any;
      id = last?.id;
    }
    if (!id) return;
    const d = this.store.db
      .prepare("SELECT * FROM deliveries WHERE message_id=?")
      .get(id) as any;
    if (!d) {
      if (replyTo) throw new InputError("回复对象不是主动消息");
      return;
    }
    this.store.db
      .prepare("INSERT OR IGNORE INTO message_links VALUES(?,?)")
      .run(messageId, id);
    this.store.db
      .prepare(
        "UPDATE deliveries SET replied_at=COALESCE(replied_at,?),seen_at=COALESCE(seen_at,?) WHERE id=?",
      )
      .run(this.now(), this.now(), d.id);
  }
  chatContext(messageId: string) {
    const link = this.store.db
      .prepare(
        "SELECT m.id,m.body,d.topic FROM message_links l JOIN messages m ON m.id=l.reply_to JOIN deliveries d ON d.message_id=m.id WHERE l.message_id=?",
      )
      .get(messageId);
    const epoch = Number(this.store.getMeta("context_epoch") || 0);
    return {
      contactPolicy: this.policy(),
      contactTopics: TOPICS,
      replyTo: link || null,
      deliveredMessages: this.store.db
        .prepare(
          "SELECT m.id,m.body,d.topic,d.created_at FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.created_at>? ORDER BY d.created_at DESC LIMIT 6",
        )
        .all(epoch),
    };
  }
  seen(ids: unknown) {
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== "string")
    )
      throw new InputError("消息列表无效");
    this.store.transaction(() => {
      for (const id of ids)
        this.store.db
          .prepare(
            "UPDATE deliveries SET seen_at=COALESCE(seen_at,?) WHERE message_id=?",
          )
          .run(this.now(), id);
    });
    return { ok: true };
  }
  topicFeedback(topic: string, feedback: string) {
    this.store.db
      .prepare("UPDATE deliveries SET feedback_at=?,feedback=? WHERE topic=?")
      .run(this.now(), feedback, topic);
  }
  action(runId: string, callId: string, args: any) {
    return this.store.transaction(() => {
      const r = this.store.db
        .prepare(
          "SELECT m.body FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.status='running' AND r.trigger_type='user_message'",
        )
        .get(runId) as any;
      if (!r) throw new InputError("只允许用户对话管理关心设置", 403);
      const old = this.store.db
        .prepare("SELECT * FROM contact_actions WHERE run_id=? AND call_id=?")
        .get(runId, callId) as any;
      if (old) {
        if (old.args !== JSON.stringify(args))
          throw new InputError("重复操作内容不一致", 409);
        return JSON.parse(old.result);
      }
      if (!r.body.includes(text(args.evidence, 2000)))
        throw new InputError("设置变更必须引用本轮用户原话");
      if (
        (
          this.store.db
            .prepare("SELECT COUNT(*) n FROM contact_actions WHERE run_id=?")
            .get(runId) as any
        ).n >= 4
      )
        throw new InputError("设置操作预算已用尽", 409);
      const p = this.policy();
      p.mutedTopics = Object.fromEntries(
        Object.entries(p.mutedTopics).filter(
          ([, v]) => v === null || v > this.now(),
        ),
      );
      let patch: any = {};
      if (args.action === "enable")
        patch = { enabled: true, pausedUntil: null };
      else if (args.action === "disable") patch = { enabled: false };
      else if (args.action === "pause_today")
        patch = { pausedUntil: dayStart(this.now()) + 86400000 };
      else if (args.action === "resume")
        patch = { enabled: true, pausedUntil: null };
      else if (args.action === "mute_topic" || args.action === "unmute_topic") {
        if (!TOPICS[args.topic]) throw new InputError("话题无效");
        const mutedTopics = { ...p.mutedTopics };
        if (args.action === "mute_topic")
          mutedTopics[args.topic] = args.until ?? null;
        else delete mutedTopics[args.topic];
        patch = { mutedTopics };
      } else if (args.action === "hours")
        patch = { startHour: args.startHour, endHour: args.endHour };
      else if (args.action === "search")
        patch = { searchEnabled: args.searchEnabled };
      else throw new InputError("操作无效");
      const result = this.update(patch, args.revision);
      if (args.action === "unmute_topic")
        this.topicFeedback(args.topic, "resumed");
      this.store.db
        .prepare("INSERT INTO contact_actions VALUES(?,?,?,?)")
        .run(runId, callId, JSON.stringify(args), JSON.stringify(result));
      return result;
    });
  }
  status() {
    const checks = this.store.db
      .prepare(
        "SELECT c.id,c.trigger,c.status,c.reason,c.created_at,c.finished_at,c.run_id,r.usage,r.web_calls,r.retry_count FROM heartbeat_checks c LEFT JOIN runs r ON r.id=c.run_id ORDER BY c.created_at DESC,c.rowid DESC LIMIT 50",
      )
      .all();
    return {
      policy: this.policy(),
      nextAt: (
        this.store.db
          .prepare("SELECT next_at FROM system_tasks WHERE id='heartbeat'")
          .get() as any
      ).next_at,
      serverTime: this.now(),
      busyWithConversation: !!this.store.db
        .prepare(
          "SELECT id FROM runs WHERE trigger_type='user_message' AND status IN ('running','queued') LIMIT 1",
        )
        .get(),
      checks,
      counts: this.counts(),
      topics: Object.entries(TOPICS).map(([id, label]) => ({
        id,
        label,
        reason: this.topicBlocked(id),
      })),
      gateReason: this.gate(),
      deliveries: this.store.db
        .prepare("SELECT * FROM deliveries ORDER BY created_at")
        .all(),
      links: this.store.db.prepare("SELECT * FROM message_links").all(),
      actions: this.store.db
        .prepare(
          "SELECT run_id,args,result FROM contact_actions ORDER BY rowid",
        )
        .all(),
    };
  }
}
