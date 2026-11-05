import { randomUUID, createHash } from "node:crypto";
import { Store, InputError } from "./store.js";
import { Profile } from "./profile.js";
import { dayStart } from "./heartbeat.js";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export class MemoryUpkeep {
  modelAvailable = true;
  constructor(
    public store: Store,
    public profile: Profile,
    public now = () => Date.now(),
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS upkeep_checks(id TEXT PRIMARY KEY,run_id TEXT UNIQUE,status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,snapshot TEXT NOT NULL,result TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS memory_sources(memory_id TEXT NOT NULL,source_message_id TEXT NOT NULL,PRIMARY KEY(memory_id,source_message_id));
      CREATE TABLE IF NOT EXISTS upkeep_resolutions(check_id TEXT NOT NULL,candidate_index INTEGER NOT NULL,choice TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(check_id,candidate_index));`);
    if (!store.getMeta("upkeep_policy"))
      store.setMeta(
        "upkeep_policy",
        JSON.stringify({ enabled: true, revision: 1 }),
      );
    if (!store.getMeta("upkeep_baseline"))
      store.setMeta("upkeep_baseline", JSON.stringify(this.signals()));
    store.db
      .prepare(
        "INSERT OR IGNORE INTO system_tasks VALUES('memory_upkeep','memory_upkeep',?)",
      )
      .run(this.now() + 60000);
    store.db
      .prepare(
        "UPDATE upkeep_checks SET status='interrupted',reason='服务中断，旧整理不自动重放',finished_at=? WHERE status='running'",
      )
      .run(this.now());
    store.db
      .prepare(
        "UPDATE runs SET status='interrupted',reason='整理中断，不自动重放' WHERE trigger_type='memory_upkeep' AND status IN ('running','queued')",
      )
      .run();
  }
  policy() {
    return JSON.parse(this.store.getMeta("upkeep_policy"));
  }
  signals() {
    return {
      events: (
        this.store.db
          .prepare("SELECT COUNT(*) n FROM memory_events")
          .get() as any
      ).n,
      users: (
        this.store.db
          .prepare(
            "SELECT COUNT(*) n FROM messages WHERE role='user' AND status='completed'",
          )
          .get() as any
      ).n,
    };
  }
  snapshot() {
    const all = this.store.db
      .prepare(
        "SELECT * FROM memories WHERE status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id",
      )
      .all(this.now()) as any[];
    let budget = 8000;
    const memories = all
      .slice(0, 24)
      .filter((m) => (budget -= m.content.length) >= 0);
    const latest = this.store.db
      .prepare(
        "SELECT id FROM messages WHERE role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as any;
    return {
      memories,
      fingerprint: hash(all.map((m) => [m.id, m.revision, m.expires_at])),
      epoch: this.store.getMeta("context_epoch"),
      latestUser: latest?.id || null,
      profileRevision: this.profile.get().revision,
      policyRevision: this.policy().revision,
      signals: this.signals(),
      now: this.now(),
      total: all.length,
    };
  }
  count() {
    return (
      this.store.db
        .prepare("SELECT COUNT(*) n FROM upkeep_checks WHERE created_at>=?")
        .get(dayStart(this.now())) as any
    ).n;
  }
  update(enabled: boolean, revision: number) {
    if (typeof enabled !== "boolean") throw new InputError("整理开关无效");
    if (revision !== this.policy().revision)
      throw new InputError("整理设置已变化", 409);
    this.store.setMeta(
      "upkeep_policy",
      JSON.stringify({ enabled, revision: revision + 1 }),
    );
    this.invalidate("整理设置已改变");
    return this.policy();
  }
  claim(manual = false) {
    return this.store.transaction(() => {
      const now = this.now(),
        task = this.store.db
          .prepare("SELECT next_at FROM system_tasks WHERE id='memory_upkeep'")
          .get() as any;
      if (!manual && task.next_at > now) return null;
      const reject = (reason: string) => {
        if (manual) throw new InputError(reason, 409);
        return null;
      };
      if (!this.policy().enabled) return reject("记忆整理已关闭");
      if (!manual)
        this.store.db
          .prepare("UPDATE system_tasks SET next_at=? WHERE id='memory_upkeep'")
          .run(now + 60000);
      if (!this.modelAvailable) return reject("未配置 DeepSeek，无法整理");
      if (
        this.store.db
          .prepare("SELECT id FROM upkeep_checks WHERE status='running'")
          .get()
      )
        return reject("正在整理");
      if (this.count() >= 2)
        return reject("今日整理额度已用尽（每天最多 2 次）");
      const last = this.store.db
        .prepare(
          "SELECT * FROM upkeep_checks ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get() as any;
      if (last && now - last.created_at < (manual ? 60000 : 1800000))
        return reject(manual ? "请至少间隔一分钟再整理" : "整理冷却中");
      this.store.expireContext(now);
      const snap = this.snapshot();
      if (!snap.memories.length) return reject("没有有效记忆可整理");
      if (
        snap.fingerprint === this.store.getMeta("upkeep_attempted") &&
        !(
          manual &&
          last &&
          ["failed", "interrupted", "cancelled"].includes(last.status)
        )
      )
        return reject("记忆没有变化，无需重复整理");
      if (!manual) {
        const latest = this.store.db
          .prepare("SELECT MAX(created_at) t FROM messages WHERE role='user'")
          .get() as any;
        const event = this.store.db
          .prepare("SELECT MAX(created_at) t FROM memory_events")
          .get() as any;
        if (now - Math.max(latest.t || 0, event.t || 0) < 600000) return null;
        const base = JSON.parse(this.store.getMeta("upkeep_baseline"));
        if (
          snap.signals.events - base.events < 3 &&
          !(
            snap.signals.users - base.users >= 6 &&
            snap.signals.events > base.events
          )
        )
          return null;
      }
      const id = randomUUID(),
        runId = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO upkeep_checks(id,run_id,status,reason,created_at,snapshot) VALUES(?,?,'running','正在整理',?,?)",
        )
        .run(id, runId, now, JSON.stringify(snap));
      this.store.db
        .prepare(
          "INSERT INTO runs(id,message_id,status,reason,created_at,trigger_type,trigger_id) VALUES(?,NULL,'queued','记忆整理',?,'memory_upkeep',?)",
        )
        .run(runId, now, id);
      this.store.setMeta("upkeep_attempted", snap.fingerprint);
      this.store.setMeta("upkeep_baseline", JSON.stringify(snap.signals));
      return {
        id: runId,
        trigger_type: "memory_upkeep",
        body: "请仅依据上下文 memories 生成约定的记忆整理 JSON。不得改写事实或调用工具。",
      };
    });
  }
  context(runId: string) {
    const c = this.store.db
      .prepare(
        "SELECT * FROM upkeep_checks WHERE run_id=? AND status='running'",
      )
      .get(runId) as any;
    if (!c) throw new InputError("整理授权已失效", 409);
    return { ...JSON.parse(c.snapshot), mode: "memory_upkeep" };
  }
  valid(s: any) {
    const n = this.snapshot();
    return (
      s.fingerprint === n.fingerprint &&
      s.epoch === n.epoch &&
      s.latestUser === n.latestUser &&
      s.profileRevision === n.profileRevision &&
      s.policyRevision === n.policyRevision
    );
  }
  settle(runId: string, raw: string) {
    return this.store.transaction(() => {
      const c = this.store.db
        .prepare(
          "SELECT * FROM upkeep_checks WHERE run_id=? AND status='running'",
        )
        .get(runId) as any;
      if (!c) return;
      const r = this.store.db
        .prepare("SELECT status FROM runs WHERE id=?")
        .get(runId) as any;
      if (r?.status !== "running")
        return this.failed(runId, "执行已失效", "cancelled");
      const s = JSON.parse(c.snapshot);
      if (!this.valid(s))
        return this.failed(
          runId,
          "记忆、设置或用户输入已变化，旧整理已取消",
          "cancelled",
        );
      try {
        const p = JSON.parse(
          raw
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, ""),
        );
        const ids = new Set(s.memories.map((m: any) => m.id));
        if (
          !Array.isArray(p.overviewIds) ||
          p.overviewIds.length > 8 ||
          !Array.isArray(p.candidates) ||
          p.candidates.length > 6
        )
          throw Error();
        if (
          p.overviewIds.some(
            (id: any) => typeof id !== "string" || !ids.has(id),
          ) ||
          new Set(p.overviewIds).size !== p.overviewIds.length
        )
          throw Error();
        const used = new Set<string>();
        const candidates = p.candidates.map((g: any) => {
          if (
            !["duplicate", "conflict"].includes(g.kind) ||
            !Array.isArray(g.ids) ||
            g.ids.length < 2 ||
            g.ids.length > 4 ||
            new Set(g.ids).size !== g.ids.length ||
            g.ids.some(
              (id: any) =>
                typeof id !== "string" || !ids.has(id) || used.has(id),
            )
          )
            throw Error();
          for (const id of g.ids) used.add(id);
          // Temporary facts with different expiry are not safely interchangeable.
          if (
            g.kind === "duplicate" &&
            new Set(
              s.memories
                .filter((m: any) => g.ids.includes(m.id))
                .map((m: any) => JSON.stringify([m.kind, m.expires_at])),
            ).size !== 1
          )
            throw Error();
          return { kind: g.kind, ids: g.ids };
        });
        const conflicts = new Set(
          candidates
            .filter((g: any) => g.kind === "conflict")
            .flatMap((g: any) => g.ids),
        );
        const result = {
          overviewIds: p.overviewIds.filter((id: string) => !conflicts.has(id)),
          candidates,
        };
        this.store.db
          .prepare(
            "UPDATE upkeep_checks SET status='succeeded',reason='整理完成；事实取舍等待你的确认',finished_at=?,result=? WHERE id=?",
          )
          .run(this.now(), JSON.stringify(result), c.id);
        this.store.db
          .prepare(
            "UPDATE runs SET status='succeeded',reason='记忆整理完成，未发送聊天',result=?,preview='' WHERE id=?",
          )
          .run(JSON.stringify(result), runId);
      } catch {
        this.failed(runId, "模型提案格式或来源不符合约定，未修改记忆");
      }
    });
  }
  failed(runId: string, reason: string, status = "failed") {
    const n = this.store.db
      .prepare(
        "UPDATE upkeep_checks SET status=?,reason=?,finished_at=? WHERE run_id=? AND status='running'",
      )
      .run(status, reason, this.now(), runId);
    if (n.changes)
      this.store.db
        .prepare(
          "UPDATE runs SET status=?,reason=?,preview='' WHERE id=? AND status IN ('queued','running')",
        )
        .run(status, reason, runId);
  }
  invalidate(reason: string) {
    for (const r of this.store.db
      .prepare("SELECT run_id FROM upkeep_checks WHERE status='running'")
      .all() as any[])
      this.failed(r.run_id, reason, "cancelled");
  }
  current() {
    const c = this.store.db
      .prepare(
        "SELECT * FROM upkeep_checks WHERE status='succeeded' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as any;
    if (!c) return null;
    const s = JSON.parse(c.snapshot),
      p = JSON.parse(c.result),
      current = this.snapshot();
    // A new chat alone does not invalidate an already committed overview.
    if (s.fingerprint !== current.fingerprint || s.epoch !== current.epoch)
      return { id: c.id, stale: true, overview: [], candidates: [] };
    const byId = new Map(s.memories.map((m: any) => [m.id, m]));
    const resolutions = this.store.db
      .prepare(
        "SELECT candidate_index FROM upkeep_resolutions WHERE check_id=?",
      )
      .all(c.id) as any[];
    return {
      id: c.id,
      stale: false,
      overview: p.overviewIds.map((id: string) => byId.get(id)),
      candidates: p.candidates
        .map((g: any, index: number) => ({
          ...g,
          index,
          memories: g.ids.map((id: string) => byId.get(id)),
        }))
        .filter(
          (g: any) => !resolutions.some((r) => r.candidate_index === g.index),
        ),
    };
  }
  resolve(checkId: string, index: number, keepId: string | null) {
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare(
          "SELECT choice FROM upkeep_resolutions WHERE check_id=? AND candidate_index=?",
        )
        .get(checkId, index) as any;
      if (old) {
        if (old.choice !== (keepId || "all"))
          throw new InputError("该建议已处理", 409);
        return { ok: true };
      }
      const c = this.current();
      if (!c || c.id !== checkId || c.stale)
        throw new InputError("记忆已变化，请重新整理", 409);
      const g = c.candidates.find((g: any) => g.index === index);
      if (!g || (keepId !== null && !g.ids.includes(keepId)))
        throw new InputError("候选选择无效");
      if (keepId) {
        for (const m of g.memories) {
          if (
            m.source_message_id &&
            (g.kind === "duplicate" || m.id === keepId)
          )
            this.store.db
              .prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?)")
              .run(keepId, m.source_message_id);
          if (g.kind === "duplicate")
            this.store.db
              .prepare(
                "INSERT OR IGNORE INTO memory_sources SELECT ?,source_message_id FROM memory_sources WHERE memory_id=?",
              )
              .run(keepId, m.id);
          if (m.id !== keepId) {
            this.store.db
              .prepare(
                "UPDATE memories SET status='superseded',revision=revision+1,updated_at=? WHERE id=?",
              )
              .run(this.now(), m.id);
            this.store.db
              .prepare("INSERT INTO memory_events VALUES(?,?,?,?,?)")
              .run(
                randomUUID(),
                m.id,
                g.kind === "duplicate" ? "merge" : "resolve",
                m.revision + 1,
                this.now(),
              );
          }
        }
        this.store.invalidateContext(this.now());
      }
      this.store.db
        .prepare("INSERT INTO upkeep_resolutions VALUES(?,?,?,?)")
        .run(checkId, index, keepId || "all", this.now());
      return { ok: true };
    });
  }
  status() {
    const latest = this.store.db
      .prepare(
        "SELECT c.id,c.status,c.reason,c.created_at,c.finished_at,c.run_id,r.usage FROM upkeep_checks c LEFT JOIN runs r ON r.id=c.run_id ORDER BY c.created_at DESC,c.rowid DESC LIMIT 8",
      )
      .all();
    const next = (
      this.store.db
        .prepare("SELECT next_at FROM system_tasks WHERE id='memory_upkeep'")
        .get() as any
    ).next_at;
    return {
      policy: this.policy(),
      nextAt: next,
      usedToday: this.count(),
      dailyLimit: 2,
      checks: latest,
      current: this.current(),
      expiredCount: (
        this.store.db
          .prepare(
            "SELECT COUNT(*) n FROM memories WHERE status='active' AND expires_at<=?",
          )
          .get(this.now()) as any
      ).n,
    };
  }
}
