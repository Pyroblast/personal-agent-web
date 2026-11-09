import { createHash, randomUUID } from "node:crypto";
import { Store, InputError, text } from "./store.js";
const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const parse = (x: any, fallback: any = []) => {
  try {
    return JSON.parse(x);
  } catch {
    return fallback;
  }
};
const terms = (s: string) => [
  ...new Set(
    (s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]+/g) || []).flatMap(
      (x) =>
        /^[a-z0-9]/.test(x)
          ? [x]
          : Array.from({ length: Math.max(0, x.length - 1) }, (_, i) =>
              x.slice(i, i + 2),
            ),
    ),
  ),
];
export function migrateContext(s: Store) {
  s.db
    .exec(`CREATE TABLE IF NOT EXISTS evidence_exclusions(source_id TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_fragments(source_id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(source_id,signature));
    CREATE TABLE IF NOT EXISTS evidence_tombstones(id TEXT PRIMARY KEY,signatures TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS matters(id TEXT PRIMARY KEY,goal_id TEXT UNIQUE,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,source_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plan_items(id TEXT PRIMARY KEY,matter_id TEXT NOT NULL REFERENCES matters(id),label TEXT NOT NULL,owner TEXT NOT NULL,decision TEXT NOT NULL,source_id TEXT NOT NULL,dependencies TEXT NOT NULL DEFAULT '[]',next_action TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS open_questions(id TEXT PRIMARY KEY,matter_id TEXT NOT NULL REFERENCES matters(id),semantic_key TEXT NOT NULL,question TEXT NOT NULL,status TEXT NOT NULL,source_id TEXT NOT NULL,answer_source TEXT,revision INTEGER NOT NULL DEFAULT 1,delivered_at INTEGER,UNIQUE(matter_id,semantic_key));
    CREATE TABLE IF NOT EXISTS delegation_proposals(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,goal_revision INTEGER NOT NULL,run_id TEXT NOT NULL,scope TEXT NOT NULL,allow_search INTEGER NOT NULL,support_until INTEGER,status TEXT NOT NULL,expires_at INTEGER NOT NULL,accepted_source TEXT);
    CREATE TABLE IF NOT EXISTS context_actions(run_id TEXT NOT NULL,operation_id TEXT NOT NULL,args TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,operation_id));
    CREATE TABLE IF NOT EXISTS task_fact_dependencies(task_id TEXT PRIMARY KEY,fact_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_skills(run_id TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(run_id,name));
    CREATE TABLE IF NOT EXISTS context_reads(run_id TEXT PRIMARY KEY,scope TEXT,stamp TEXT NOT NULL,coverage TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS context_audit(id TEXT PRIMARY KEY,run_id TEXT,gate TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_history(id TEXT PRIMARY KEY,scope TEXT NOT NULL,source_id TEXT NOT NULL,body TEXT NOT NULL,disposition TEXT NOT NULL,replaced_by TEXT,created_at INTEGER NOT NULL);`);
  for (const [column, type] of [
    ["branch", "TEXT NOT NULL DEFAULT ''"],
    ["deadline", "INTEGER"],
    ["task_id", "TEXT"],
  ]) {
    if (
      !(s.db.prepare("PRAGMA table_info(plan_items)").all() as any[]).some(
        (c) => c.name === column,
      )
    )
      s.db.exec(`ALTER TABLE plan_items ADD COLUMN ${column} ${type}`);
  }
  s.db.exec(
    "CREATE TABLE IF NOT EXISTS goal_contact_limits(goal_id TEXT PRIMARY KEY,count INTEGER NOT NULL,days INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1)",
  );
  s.db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(message_id UNINDEXED,terms,tokenize='unicode61')",
  );
  if (s.getMeta("context31_floor") === undefined)
    s.setMeta("context31_floor", s.getMeta("context_epoch") || "0");
  s.setMeta("context_schema_version", "3.1");
}
export class ContextService {
  constructor(
    public store: Store,
    public now = () => Date.now(),
  ) {}
  get db() {
    return this.store.db;
  }
  has(name: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }
  exclude(source: string | null, reason: string) {
    if (source)
      this.db
        .prepare("INSERT OR REPLACE INTO evidence_exclusions VALUES(?,?,?)")
        .run(source, reason, this.now());
  }
  retireMemory(m: any, reason: string) {
    this.exclude(m.source_message_id, reason);
    for (const x of this.db
      .prepare("SELECT source_message_id FROM memory_sources WHERE memory_id=?")
      .all(m.id) as any[])
      this.exclude(x.source_message_id, reason);
    // Hashed lexical signatures are a conservative fallback for mixed derived snippets; never store forgotten plaintext.
    if (m.content)
      this.db
        .prepare("INSERT INTO evidence_tombstones VALUES(?,?,?)")
        .run(
          randomUUID(),
          JSON.stringify(terms(m.content).map(digest)),
          this.now(),
        );
  }
  readable(
    source: string | null,
    body: string,
    at = this.now(),
    historical = false,
    derived = false,
  ) {
    if (at <= Number(this.store.getMeta("context31_floor") || 0)) return false;
    const exclusion =
      source &&
      (this.db
        .prepare("SELECT reason FROM evidence_exclusions WHERE source_id=?")
        .get(source) as any);
    if (
      exclusion &&
      !(
        exclusion.reason === "superseded_goal_fact" &&
        (historical ||
          !!this.db
            .prepare(
              "SELECT 1 FROM evidence_fragments WHERE source_id=? AND signature=?",
            )
            .get(source, digest(body)))
      )
    )
      return false;
    const set = new Set(terms(body).map(digest));
    for (const t of this.db
      .prepare("SELECT signatures,created_at FROM evidence_tombstones")
      .all() as any[]) {
      if (!derived && at > t.created_at) continue; // explicit newly supplied facts are new evidence
      const xs = parse(t.signatures);
      if (
        xs.length &&
        xs.filter((x: string) => set.has(x)).length >= Math.min(3, xs.length)
      )
        return false;
    }
    return true;
  }
  goalView(g: any) {
    const valid = this.readable(
      g.authority_ref,
      [
        g.title,
        g.completion_criteria,
        g.next_action,
        g.wait_condition,
        JSON.stringify(g.plan),
      ].join(" "),
      g.updated_at,
      false,
      true,
    );
    return {
      ...g,
      facts: this.facts(g),
      ...(valid
        ? {}
        : {
            title: "已保存的事项",
            completion_criteria: "依据已更新，等待核对",
            next_action: "按有效信息重新评估",
            wait_condition: "",
            plan: [],
          }),
    };
  }
  facts(g: any) {
    return (typeof g.facts === "string" ? parse(g.facts) : g.facts).filter(
      (f: any) => this.readable(f.source, f.content, f.updated_at),
    );
  }
  source(id: string) {
    const m = this.db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(id) as any;
    return m && this.readable(id, m.body, m.created_at) ? m : null;
  }
  matter(goalId: string, title?: string, source?: string) {
    let m = this.db
      .prepare("SELECT * FROM matters WHERE goal_id=?")
      .get(goalId) as any;
    if (!m) {
      const g = this.has("goals")
        ? (this.db.prepare("SELECT * FROM goals WHERE id=?").get(goalId) as any)
        : null;
      if (!g && !title) throw new InputError("事项不存在", 404);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO matters VALUES(?,?,?,1,?,?,?)")
        .run(
          id,
          goalId,
          title || g.title,
          source || g.authority_ref,
          this.now(),
          this.now(),
        );
      m = this.db.prepare("SELECT * FROM matters WHERE id=?").get(id);
    }
    return m;
  }
  view(m: any) {
    const rawGoal =
      m.goal_id && this.has("goals")
        ? (this.db
            .prepare("SELECT * FROM goals WHERE id=?")
            .get(m.goal_id) as any)
        : null;
    const g = rawGoal ? this.goalView(rawGoal) : null;
    const items = (
      this.db
        .prepare(
          "SELECT * FROM plan_items WHERE matter_id=? ORDER BY rowid DESC LIMIT 16",
        )
        .all(m.id) as any[]
    )
      .filter((x) => this.readable(x.source_id, x.label, x.updated_at))
      .map((x) => ({
        ...x,
        dependencies: parse(x.dependencies),
        evidenceState: "user_reported",
        executionState: x.task_id
          ? (
              this.db
                .prepare("SELECT status FROM tasks WHERE id=?")
                .get(x.task_id) as any
            )?.status || "unknown"
          : x.decision === "reported_done"
            ? "user_reported"
            : "not_verified",
      }));
    const questions = (
      this.db
        .prepare(
          "SELECT * FROM open_questions WHERE matter_id=? ORDER BY rowid DESC LIMIT 16",
        )
        .all(m.id) as any[]
    ).filter(
      (x) =>
        String(x.source_id).startsWith("ui:") || !!this.source(x.source_id),
    );
    return {
      ...m,
      title: this.readable(m.source_id, m.title, m.updated_at)
        ? m.title
        : "已保存的事项",
      items,
      questions,
      goalRevision: g?.revision,
      factsRevision: g?.facts_revision,
      facts: g
        ? this.facts(g)
            .slice(-12)
            .map((f: any) => ({ ...f, content: f.content.slice(0, 800) }))
        : [],
      nextAction: g?.next_action || "",
      waitingFor: g?.wait_condition || "",
      tasks: g
        ? this.db
            .prepare(
              "SELECT id,title,owner,status,substr(reason,1,300) reason FROM tasks WHERE goal_id=? ORDER BY rowid DESC LIMIT 16",
            )
            .all(g.id)
        : [],
      authority: g
        ? {
            policy: g.execution_policy,
            enabled: !!g.support_enabled,
            until: g.support_until,
          }
        : null,
    };
  }
  indexPending(limit = 128) {
    const cursor = Number(this.store.getMeta("context_index_cursor") || 0);
    const rows = this.db
      .prepare(
        "SELECT rowid,id,body,created_at FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(cursor, limit) as any[];
    this.store.transaction(() => {
      for (const m of rows) {
        this.db
          .prepare("DELETE FROM message_search WHERE message_id=?")
          .run(m.id);
        if (this.readable(m.id, m.body, m.created_at))
          this.db
            .prepare("INSERT INTO message_search(message_id,terms) VALUES(?,?)")
            .run(
              m.id,
              terms(m.body)
                .map((x) => "t" + digest(x))
                .join(" "),
            );
      }
      if (rows.length)
        this.store.setMeta("context_index_cursor", String(rows.at(-1).rowid));
    });
  }
  search(query: string, goalId: string | null = null, historical = false) {
    const keys = terms(query).slice(0, 80);
    let rows = this.db
      .prepare(
        "SELECT id,role,body,created_at FROM messages WHERE role='user' AND status='completed' AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 2000",
      )
      .all(Number(this.store.getMeta("context31_floor") || 0)) as any[];
    const expression = keys.map((x) => "t" + digest(x)).join(" OR ");
    if (expression) {
      const indexed = this.db
        .prepare(
          "SELECT m.id,m.role,m.body,m.created_at FROM message_search f JOIN messages m ON m.id=f.message_id WHERE message_search MATCH ? AND m.role='user' AND m.status='completed' ORDER BY rank LIMIT 100",
        )
        .all(expression) as any[];
      rows = [...new Map([...indexed, ...rows].map((x) => [x.id, x])).values()];
    }
    const related = new Set<string>();
    if (goalId && this.has("goals")) {
      const g = this.db
        .prepare("SELECT * FROM goals WHERE id=?")
        .get(goalId) as any;
      if (g) {
        for (const f of this.facts(g)) related.add(f.source);
        keys.push(...terms(g.title));
      }
    }
    const selected = rows
      .filter((x) => this.readable(x.id, x.body, x.created_at))
      .map((x, i) => ({
        x,
        score:
          (related.has(x.id) ? 100 : 0) +
          keys.filter((k) => x.body.toLowerCase().includes(k)).length * 5 -
          i / 10000,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16)
      .map(({ x }) => ({
        ...x,
        text: x.body.slice(0, 1200),
        body: undefined,
        disposition: "current",
        assertionType: "user_statement",
        authorization: false,
      }));
    const history =
      historical && goalId
        ? (
            this.db
              .prepare(
                "SELECT * FROM evidence_history WHERE scope=? ORDER BY created_at DESC LIMIT 16",
              )
              .all(goalId) as any[]
          )
            .filter((x) =>
              this.readable(x.source_id, x.body, x.created_at, true),
            )
            .map((x) => ({ ...x, authorization: false }))
        : [];
    return {
      matches: selected,
      history,
      coverage: {
        scanned: rows.length,
        indexCursor: Number(this.store.getMeta("context_index_cursor") || 0),
        indexPending: !!this.db
          .prepare("SELECT 1 FROM messages WHERE rowid>? LIMIT 1")
          .get(Number(this.store.getMeta("context_index_cursor") || 0)),
        selected: selected.length,
        truncated: rows.length >= 2000 || selected.length === 16,
        method: "fts5-hashed-chinese-bigrams-with-bounded-fallback",
        absenceIsNotUnknown: true,
      },
    };
  }
  build(goalId: string | null = null, query = "") {
    const goals = this.has("goals")
      ? (
          this.db
            .prepare(
              "SELECT * FROM goals WHERE (? IS NULL OR id=?) AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC,id LIMIT 40",
            )
            .all(goalId, goalId) as any[]
        ).map((g) => this.goalView(g))
      : [];
    const matters = goals.map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      revision: g.revision,
      notificationMode:
        g.execution_policy === "record_only" || !g.support_enabled
          ? "silent"
          : g.notification_mode === "inherit"
            ? (
                this.db
                  .prepare(
                    "SELECT goal_mode FROM notification_defaults WHERE id=1",
                  )
                  .get() as any
              ).goal_mode
            : g.notification_mode,
      userFacts: this.facts(g)
        .slice(-16)
        .map((f: any) => ({
          id: f.id,
          source: f.source,
          at: f.updated_at,
          text: f.content.slice(0, 1000),
        })),
      waitingFor: g.wait_condition,
      arrangements: this.db
        .prepare(
          "SELECT id,title,kind,owner,status FROM tasks WHERE goal_id=? AND status NOT IN ('completed','cancelled') ORDER BY rowid DESC LIMIT 8",
        )
        .all(g.id),
    }));
    const retrieval = this.search(
      query || goals.map((g) => g.title).join(" "),
      goalId,
    );
    const contacts =
      this.has("deliveries") &&
      this.store.getMeta("work_schema_version") === "3"
        ? (
            this.db
              .prepare(
                "SELECT d.source,d.goal_id,d.task_id,d.message_id,m.body AS text,d.created_at,d.replied_at FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE (? IS NULL OR d.goal_id=?) ORDER BY d.created_at DESC LIMIT 24",
              )
              .all(goalId, goalId) as any[]
          )
            .filter((x) => this.readable(x.message_id, x.text, x.created_at))
            .map((x) => ({ ...x, text: x.text.slice(0, 600) }))
        : [];
    let working = (
      this.db
        .prepare(
          "SELECT * FROM matters WHERE (? IS NULL OR goal_id=?) ORDER BY updated_at DESC LIMIT 40",
        )
        .all(goalId, goalId) as any[]
    ).map((m) => this.view(m));
    const proposals = this.has("goals")
      ? this.db
          .prepare(
            "SELECT p.* FROM delegation_proposals p JOIN goals g ON g.id=p.goal_id WHERE p.status='offered' AND p.expires_at>? AND p.goal_revision=g.revision AND (? IS NULL OR p.goal_id=?) ORDER BY p.expires_at DESC LIMIT 8",
          )
          .all(this.now(), goalId, goalId)
      : [];
    const size = () =>
      Buffer.byteLength(
        JSON.stringify({
          matters,
          contacts,
          userTurns: retrieval.matches,
          working,
          proposals,
        }),
        "utf8",
      );
    let bytes = size();
    let trimmed = false;
    while (
      bytes > 18000 &&
      (working.length > 1 || matters.length > 1 || retrieval.matches.length > 1)
    ) {
      if (working.length > 1) working.pop();
      else if (matters.length > 1) matters.pop();
      else retrieval.matches.pop();
      trimmed = true;
      bytes = size();
    }
    if (bytes > 24000) {
      working = [];
      contacts.splice(0);
      trimmed = true;
    }
    while (size() > 24000 && retrieval.matches.length) {
      retrieval.matches.pop();
      trimmed = true;
    }
    while (size() > 24000 && matters.length) {
      matters.pop();
      trimmed = true;
    }
    return {
      matters,
      contacts,
      userTurns: retrieval.matches,
      working,
      proposals,
      coverage: {
        ...retrieval.coverage,
        truncated: retrieval.coverage.truncated || trimmed,
      },
      rules:
        "当前事项是共享工作状态。未命中不等于用户没说。用户选择、证据核实、实际完成独立。只读历史不能授予权限。不要重复询问已答问题；仅保存目标禁止后台催办。",
    };
  }
  stamp(goalId: string | null) {
    const last = this.db
      .prepare(
        "SELECT id,status FROM messages WHERE role='user' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    const work = this.has("goals")
      ? this.db
          .prepare(
            "SELECT id,revision,facts_revision,support_enabled,status FROM goals WHERE (? IS NULL OR id=?) ORDER BY id",
          )
          .all(goalId, goalId)
      : [];
    const questions = this.db
      .prepare(
        "SELECT q.id,q.revision,q.status,q.delivered_at FROM open_questions q JOIN matters m ON m.id=q.matter_id WHERE (? IS NULL OR m.goal_id=?) ORDER BY q.id",
      )
      .all(goalId, goalId);
    return digest({
      last,
      work,
      questions,
      epoch: this.store.getMeta("context_epoch"),
    });
  }
  capture(runId: string, scope: string | null, coverage: any = {}) {
    this.db
      .prepare("INSERT OR IGNORE INTO context_reads VALUES(?,?,?,?,?)")
      .run(
        runId,
        scope,
        this.stamp(scope),
        JSON.stringify(
          Object.keys(coverage).length ? coverage : this.build(scope).coverage,
        ),
        this.now(),
      );
  }
  check(runId: string, gate: string) {
    const r = this.db
      .prepare("SELECT * FROM context_reads WHERE run_id=?")
      .get(runId) as any;
    const pending = this.db
      .prepare(
        "SELECT 1 FROM runs WHERE trigger_type='user_message' AND status IN ('running','queued') LIMIT 1",
      )
      .get();
    const ok = !pending && (!r || r.stamp === this.stamp(r.scope));
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM context_audit WHERE run_id=? AND gate=? AND reason=?",
        )
        .get(runId, gate, ok ? "最新状态复核通过" : "相关状态或输入水位变化")
    )
      this.db
        .prepare("INSERT INTO context_audit VALUES(?,?,?,?,?)")
        .run(
          randomUUID(),
          runId,
          gate,
          ok ? "最新状态复核通过" : "相关状态或输入水位变化",
          this.now(),
        );
    return ok;
  }
  contactLimit(goalId: string) {
    const limit = this.db
      .prepare("SELECT * FROM goal_contact_limits WHERE goal_id=?")
      .get(goalId) as any;
    if (!limit || !this.has("deliveries")) return null;
    const n = this.db
      .prepare(
        "SELECT COUNT(*) n FROM deliveries WHERE goal_id=? AND obligation='discretionary' AND created_at>?",
      )
      .get(goalId, this.now() - limit.days * 86400000) as any;
    return n.n >= limit.count ? "已达到这个目标的联系上限" : null;
  }
  pendingReminder(goalId: string, title: string) {
    const pending = this.db
      .prepare(
        "SELECT m.body,r.created_at FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.trigger_type='user_message' AND r.status IN ('queued','running')",
      )
      .all() as any[];
    return pending.find(
      (r) =>
        /取消|改期|改成|改到|暂停|别再|不要提醒|不提醒/.test(r.body) &&
        (r.body.includes(title) || !/提醒/.test(title) || r.body.length < 40),
    );
  }
  question(goalId: string, key: string, body: string) {
    const m = this.matter(goalId),
      semantic = text(key, 120);
    let q = this.db
      .prepare(
        "SELECT * FROM open_questions WHERE matter_id=? AND semantic_key=?",
      )
      .get(m.id, semantic) as any;
    if (!q) {
      this.db
        .prepare("INSERT INTO open_questions VALUES(?,?,?,?,?,?,NULL,1,NULL)")
        .run(
          randomUUID(),
          m.id,
          semantic,
          text(body, 500),
          "open",
          m.source_id,
        );
      q = this.db
        .prepare(
          "SELECT * FROM open_questions WHERE matter_id=? AND semantic_key=?",
        )
        .get(m.id, semantic);
    }
    return q;
  }
  questionAllowed(id: string, goalId: string) {
    const q = this.db
      .prepare(
        "SELECT q.* FROM open_questions q JOIN matters m ON m.id=q.matter_id WHERE q.id=? AND m.goal_id=?",
      )
      .get(id, goalId) as any;
    return q?.status === "open" && !q.delivered_at;
  }
  deliveredQuestion(id: string) {
    this.db
      .prepare(
        "UPDATE open_questions SET delivered_at=?,revision=revision+1 WHERE id=? AND status='open' AND delivered_at IS NULL",
      )
      .run(this.now(), id);
  }
  action(runId: string, args: any) {
    return this.store.transaction(() => {
      const r = this.db
        .prepare(
          "SELECT r.*,m.body FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.status='running' AND r.trigger_type='user_message'",
        )
        .get(runId) as any;
      if (!r) throw new InputError("只有当前用户对话可以更新事项", 403);
      const key = text(args.operation_id, 100),
        old = this.db
          .prepare(
            "SELECT * FROM context_actions WHERE run_id=? AND operation_id=?",
          )
          .get(runId, key) as any;
      if (old) {
        if (old.args !== JSON.stringify(args))
          throw new InputError("操作标识不能复用", 409);
        return parse(old.result, {});
      }
      if (
        (
          this.db
            .prepare("SELECT COUNT(*) n FROM context_actions WHERE run_id=?")
            .get(runId) as any
        ).n >= 8
      )
        throw new InputError("事项更新预算已用尽", 409);
      const quote = text(args.evidence, 2000);
      if (!r.body.includes(quote)) throw new InputError("须引用本轮用户原话");
      let m: any;
      if (args.goal_id) {
        const g = this.db
          .prepare("SELECT * FROM goals WHERE id=?")
          .get(args.goal_id) as any;
        if (!g) throw new InputError("目标不存在");
        m = this.matter(g.id);
      } else if (args.matter_id)
        m = this.db
          .prepare("SELECT * FROM matters WHERE id=?")
          .get(args.matter_id);
      else if (args.action === "matter") {
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO matters VALUES(?,NULL,?,1,?,?,?)")
          .run(id, text(args.title, 120), r.message_id, this.now(), this.now());
        m = this.db.prepare("SELECT * FROM matters WHERE id=?").get(id);
      }
      if (!m) throw new InputError("需要明确事项");
      if (args.action !== "matter" && args.revision !== m.revision)
        throw new InputError("事项版本已变化", 409);
      let summary = "已更新这件事的工作状态。";
      if (args.action === "item") {
        const owner = args.owner || "user",
          decision = args.decision || "proposed";
        if (
          !["agent", "user", "external"].includes(owner) ||
          !["proposed", "selected", "rejected", "reported_done"].includes(
            decision,
          )
        )
          throw new InputError("计划状态无效");
        const label = text(args.label, 500);
        if (!r.body.includes(label))
          throw new InputError("决定和进度须摘录用户原话");
        const deps = args.dependencies || [];
        if (
          !Array.isArray(deps) ||
          deps.length > 8 ||
          deps.some(
            (id: any) =>
              !this.db
                .prepare("SELECT 1 FROM plan_items WHERE id=? AND matter_id=?")
                .get(id, m.id) || id === args.id,
          )
        )
          throw new InputError("依赖必须是同事项已有步骤");
        if (
          args.task_id &&
          (!m.goal_id ||
            !this.has("tasks") ||
            !this.db
              .prepare("SELECT 1 FROM tasks WHERE id=? AND goal_id=?")
              .get(args.task_id, m.goal_id))
        )
          throw new InputError("执行回执须来自本目标任务");
        if (
          args.deadline != null &&
          (!Number.isSafeInteger(args.deadline) || args.deadline < this.now())
        )
          throw new InputError("期限须为未来时间");
        if (args.id) {
          const reaches = (id: string, seen = new Set<string>()): boolean => {
            if (id === args.id) return true;
            if (seen.has(id)) return false;
            seen.add(id);
            const row = this.db
              .prepare(
                "SELECT dependencies FROM plan_items WHERE id=? AND matter_id=?",
              )
              .get(id, m.id) as any;
            return parse(row?.dependencies).some((x: string) =>
              reaches(x, seen),
            );
          };
          if (deps.some((id: string) => reaches(id)))
            throw new InputError("计划依赖不能形成循环");
        }
        const prior = args.id
          ? (this.db
              .prepare("SELECT * FROM plan_items WHERE id=? AND matter_id=?")
              .get(args.id, m.id) as any)
          : null;
        if (args.id && !prior) throw new InputError("计划项归属不符");
        const itemId = prior?.id || randomUUID();
        this.db
          .prepare(
            "INSERT INTO plan_items(id,matter_id,label,owner,decision,source_id,dependencies,next_action,revision,updated_at) VALUES(?,?,?,?,?,?,?, ?,1,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,owner=excluded.owner,decision=excluded.decision,source_id=excluded.source_id,next_action=excluded.next_action,revision=plan_items.revision+1,updated_at=excluded.updated_at",
          )
          .run(
            itemId,
            m.id,
            label,
            owner,
            decision,
            r.message_id,
            JSON.stringify(deps),
            String(args.next_action || "").slice(0, 500),
            this.now(),
          );
        this.db
          .prepare(
            "UPDATE plan_items SET dependencies=?,branch=?,deadline=?,task_id=? WHERE id=?",
          )
          .run(
            JSON.stringify(deps),
            String(args.branch || prior?.branch || "").slice(0, 120),
            args.deadline ?? prior?.deadline ?? null,
            args.task_id ?? prior?.task_id ?? null,
            itemId,
          );
      } else if (args.action === "question") {
        const semantic = text(args.semantic_key, 120),
          q = this.db
            .prepare(
              "SELECT * FROM open_questions WHERE matter_id=? AND semantic_key=?",
            )
            .get(m.id, semantic) as any;
        if (q && ["answered", "paused"].includes(q.status))
          throw new InputError("该问题已回答或暂缓，不自动重开", 409);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO open_questions VALUES(?,?,?,?,?,?,NULL,1,NULL)",
          )
          .run(
            randomUUID(),
            m.id,
            semantic,
            text(args.question, 500),
            "open",
            r.message_id,
          );
      } else if (args.action === "answer" || args.action === "pause_question") {
        const q = this.db
          .prepare("SELECT * FROM open_questions WHERE id=? AND matter_id=?")
          .get(args.id, m.id) as any;
        if (!q) throw new InputError("问题归属不符");
        this.db
          .prepare(
            "UPDATE open_questions SET status=?,answer_source=?,revision=revision+1 WHERE id=?",
          )
          .run(
            args.action === "answer" ? "answered" : "paused",
            r.message_id,
            q.id,
          );
      } else if (args.action !== "matter") throw new InputError("事项操作无效");
      this.db
        .prepare(
          "UPDATE matters SET revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(this.now(), m.id);
      const result = {
        goal_id: m.goal_id,
        summary,
        matter: this.view(
          this.db.prepare("SELECT * FROM matters WHERE id=?").get(m.id),
        ),
      };
      this.db
        .prepare("INSERT INTO context_actions VALUES(?,?,?,?)")
        .run(runId, key, JSON.stringify(args), JSON.stringify(result));
      return result;
    });
  }
}
