import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function text(value: unknown, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new InputError("内容为空或超过长度限制");
  return value.trim();
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('conversation_id','main');
      INSERT OR IGNORE INTO meta VALUES('context_epoch','0');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,message_id TEXT UNIQUE NOT NULL REFERENCES messages(id),status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,kind TEXT NOT NULL,source_message_id TEXT REFERENCES messages(id),status TEXT NOT NULL,expires_at INTEGER,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
    for (const [column, type] of [
      ["session_id", "TEXT"],
      ["inbox_id", "TEXT"],
      ["preview", "TEXT NOT NULL DEFAULT ''"],
      ["steps", "INTEGER NOT NULL DEFAULT 0"],
      ["web_calls", "INTEGER NOT NULL DEFAULT 0"],
      ["started_at", "INTEGER NOT NULL DEFAULT 0"],
      ["trigger_type", "TEXT NOT NULL DEFAULT 'user_message'"],
      ["trigger_id", "TEXT"],
      ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
      ["usage", "TEXT NOT NULL DEFAULT '{}'"],
      ["result", "TEXT NOT NULL DEFAULT '{}'"],
      ["context_epoch", "INTEGER NOT NULL DEFAULT 0"],
      ["profile_revision", "INTEGER NOT NULL DEFAULT 1"],
    ]) {
      const columns = this.db.prepare("PRAGMA table_info(runs)").all() as any[];
      if (!columns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`);
    }
    const runColumns = this.db
      .prepare("PRAGMA table_info(runs)")
      .all() as any[];
    if (runColumns.find((c) => c.name === "message_id")?.notnull) {
      const ddl = (
        this.db
          .prepare("SELECT sql FROM sqlite_master WHERE name='runs'")
          .get() as any
      ).sql
        .replace("CREATE TABLE runs", "CREATE TABLE runs_v2")
        .replace("message_id TEXT UNIQUE NOT NULL", "message_id TEXT UNIQUE");
      this.transaction(() => {
        this.db.exec(ddl);
        this.db.exec(
          "INSERT INTO runs_v2 SELECT * FROM runs; DROP TABLE runs; ALTER TABLE runs_v2 RENAME TO runs;",
        );
      });
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS actions(run_id TEXT NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,args TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,call_id));
      CREATE TABLE IF NOT EXISTS memory_sources(memory_id TEXT NOT NULL,source_message_id TEXT NOT NULL,PRIMARY KEY(memory_id,source_message_id));
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,snippet TEXT NOT NULL,published_at TEXT, fetched_at INTEGER NOT NULL,UNIQUE(run_id,url));`);
  }
  close() {
    this.db.close();
  }
  getMeta(key: string) {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  private inTransaction = false;
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  state() {
    return {
      conversationId: "main",
      messages: this.db
        .prepare("SELECT * FROM messages ORDER BY created_at,rowid")
        .all(),
      runs: this.db
        .prepare("SELECT * FROM runs ORDER BY created_at,rowid")
        .all(),
      memories: this.db
        .prepare(
          "SELECT *, CASE WHEN expires_at IS NOT NULL AND expires_at<=? THEN 1 ELSE 0 END AS expired FROM memories WHERE status='active' ORDER BY updated_at DESC",
        )
        .all(Date.now()),
      memorySources: this.db.prepare("SELECT * FROM memory_sources").all(),
      sources: this.db.prepare("SELECT * FROM sources ORDER BY rowid").all(),
      actions: this.db
        .prepare("SELECT run_id,name,result FROM actions ORDER BY rowid")
        .all(),
    };
  }
  enqueue(body: unknown, key: unknown, ready = false) {
    const content = text(body),
      requestKey = text(key, 100);
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM messages WHERE request_key=?")
        .get(requestKey) as any;
      if (old) {
        if (old.body !== content)
          throw new InputError("同一请求不能变更内容", 409);
        return old;
      }
      const id = randomUUID(),
        now = Date.now();
      this.db
        .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)")
        .run(
          id,
          requestKey,
          "user",
          content,
          ready ? "queued" : "blocked",
          now,
        );
      this.db
        .prepare(
          "INSERT INTO runs(id,message_id,status,reason,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          ready ? "queued" : "blocked",
          ready ? "等待执行" : "DSH 尚未接入，未发送到模型。",
          now,
        );
      return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    });
  }
  cancel(id: string) {
    return this.transaction(() => {
      const r = this.db
        .prepare(
          "UPDATE messages SET status='cancelled' WHERE id=? AND status IN ('blocked','queued')",
        )
        .run(id);
      if (!r.changes) throw new InputError("消息不存在或不能取消", 409);
      this.db
        .prepare(
          "UPDATE runs SET status='cancelled',reason='用户取消待执行输入' WHERE message_id=?",
        )
        .run(id);
    });
  }
  saveMemory(input: any) {
    const content = text(input.content, 2000);
    if (!["preference", "fact", "temporary"].includes(input.kind))
      throw new InputError("记忆类型无效");
    const expires = input.expiresAt ?? null;
    if (
      expires !== null &&
      (!Number.isSafeInteger(expires) || expires <= Date.now())
    )
      throw new InputError("有效期必须是未来时间");
    if (input.kind === "temporary" && expires === null)
      throw new InputError("临时约束必须设置有效期");
    if (
      input.sourceMessageId &&
      !this.db
        .prepare("SELECT id FROM messages WHERE id=? AND role='user'")
        .get(input.sourceMessageId)
    )
      throw new InputError("来源消息不存在");
    return this.transaction(() => {
      const now = Date.now(),
        id = input.id || randomUUID();
      const old = this.db
        .prepare("SELECT * FROM memories WHERE id=?")
        .get(id) as any;
      if (
        input.id &&
        (!old || old.status !== "active" || old.revision !== input.revision)
      )
        throw new InputError("记忆已变化，请刷新后重试", 409);
      if (old) {
        this.db.prepare("DELETE FROM memory_sources WHERE memory_id=?").run(id);
        this.db
          .prepare(
            "UPDATE memories SET content=?,kind=?,expires_at=?,source_message_id=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(
            content,
            input.kind,
            expires,
            input.sourceMessageId ?? null,
            now,
            id,
          );
        this.invalidateContext(now);
      } else
        this.db
          .prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            content,
            input.kind,
            input.sourceMessageId ?? null,
            "active",
            expires,
            1,
            now,
            now,
          );
      this.db
        .prepare("INSERT INTO memory_events VALUES(?,?,?,?,?)")
        .run(
          randomUUID(),
          id,
          old ? "correct" : "create",
          old ? old.revision + 1 : 1,
          now,
        );
      return this.db.prepare("SELECT * FROM memories WHERE id=?").get(id);
    });
  }
  forget(id: string, revision: unknown) {
    if (!Number.isSafeInteger(revision)) throw new InputError("记忆版本无效");
    return this.transaction(() => {
      const r = this.db
        .prepare(
          "UPDATE memories SET status='forgotten',content='',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='active'",
        )
        .run(Date.now(), id, revision as number);
      if (!r.changes) throw new InputError("记忆已变化，请刷新后重试", 409);
      this.db.prepare("DELETE FROM memory_sources WHERE memory_id=?").run(id);
      this.invalidateContext(Date.now());
      this.db
        .prepare("INSERT INTO memory_events VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, "forget", Number(revision) + 1, Date.now());
    });
  }
  invalidateContext(now: number) {
    now = Math.max(now, Number(this.getMeta("context_epoch") || 0) + 1);
    this.db
      .prepare("UPDATE meta SET value=? WHERE key='context_epoch'")
      .run(String(now));
  }
  context(now = Date.now()) {
    const epoch = Number(
      (
        this.db
          .prepare("SELECT value FROM meta WHERE key='context_epoch'")
          .get() as any
      ).value,
    );
    return {
      now,
      contextEpoch: epoch,
      memories: this.db
        .prepare(
          "SELECT * FROM memories WHERE status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 100",
        )
        .all(now),
      recent: this.db
        .prepare(
          "SELECT role,body FROM messages WHERE status='completed' AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 12",
        )
        .all(epoch)
        .reverse(),
    };
  }

  next() {
    return this.db
      .prepare(
        "SELECT r.*,m.body FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.status='queued' AND r.trigger_type='user_message' ORDER BY r.created_at,r.rowid LIMIT 1",
      )
      .get() as any;
  }
  startRun(id: string, session: string) {
    this.transaction(() => {
      if (
        !this.db
          .prepare(
            "UPDATE runs SET status='running',session_id=?,context_epoch=?,started_at=? WHERE id=? AND status='queued'",
          )
          .run(
            session,
            Number(this.getMeta("context_epoch") || 0),
            Date.now(),
            id,
          ).changes
      )
        throw new InputError("执行已变化", 409);
      this.db
        .prepare(
          "UPDATE messages SET status='running' WHERE id=(SELECT message_id FROM runs WHERE id=?)",
        )
        .run(id);
    });
  }
  active(session: string) {
    const r = this.db
      .prepare(
        "SELECT r.*,COALESCE(m.body,'') AS body FROM runs r LEFT JOIN messages m ON m.id=r.message_id WHERE r.session_id=? AND r.status='running'",
      )
      .get(session) as any;
    if (!r) throw new InputError("执行授权已失效", 409);
    return r;
  }
  finish(id: string, body: string, result: any) {
    this.transaction(() => {
      const r = this.db
        .prepare("SELECT * FROM runs WHERE id=? AND status='running'")
        .get(id) as any;
      if (!r) return;
      if (!body.trim()) throw new InputError("模型未产生可交付回复");
      this.db
        .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)")
        .run(
          "reply-" + id,
          "reply-" + id,
          "assistant",
          body,
          "completed",
          Date.now(),
        );
      this.db
        .prepare(
          "UPDATE runs SET status='succeeded',reason='',preview='',result=? WHERE id=?",
        )
        .run(JSON.stringify(result), id);
      this.db
        .prepare("UPDATE messages SET status='completed' WHERE id=?")
        .run(r.message_id);
      // A forget acknowledgement can itself repeat the removed fact: exclude that turn too.
      if (
        this.db
          .prepare(
            "SELECT 1 FROM actions WHERE run_id=? AND name='memory_forget'",
          )
          .get(id)
      )
        this.invalidateContext(Date.now());
    });
  }
  fail(id: string, reason: string, status = "failed") {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE messages SET status=? WHERE id=(SELECT message_id FROM runs WHERE id=?) AND status='running'",
        )
        .run(status, id);
      this.db
        .prepare(
          "UPDATE runs SET status=?,reason=?,preview='' WHERE id=? AND status='running'",
        )
        .run(status, reason, id);
    });
  }
  recover() {
    const pending = this.db
      .prepare("SELECT id,trigger_type FROM runs WHERE status='running'")
      .all() as any[];
    for (const r of pending)
      this.fail(
        r.id,
        "上次执行中断；已完成的记忆动作保留，请查看回执。不会自动重复执行。",
        "interrupted",
      );
    if (pending.some((r) => r.trigger_type === "user_message"))
      this.setMeta("session_id", "");
  }
  runtimeContext(session: string) {
    const r = this.active(session);
    const c = this.context();
    // Bounded lexical retrieval; explicit memory_list remains the inspect-all tool.
    const query = r.body.toLowerCase(),
      terms = new Set(query.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) || []);
    const ranked = (c.memories as any[])
      .map((m, i) => ({
        m,
        score:
          [...terms].filter((t) => m.content.toLowerCase().includes(t)).length *
            10 +
          (m.kind === "temporary" ? 2 : 0) -
          i / 1000,
      }))
      .sort((a, b) => b.score - a.score);
    let remaining = 8000;
    const memories = ranked
      .slice(0, 12)
      .map((x) => x.m)
      .filter((m) => {
        remaining -= m.content.length;
        return remaining >= 0;
      });
    let recentBudget = 10000;
    const recent =
      this.getMeta("session_id") === session
        ? []
        : c.recent
            .slice()
            .reverse()
            .filter((m: any) => {
              recentBudget -= m.body.length;
              return recentBudget >= 0;
            })
            .reverse();
    return {
      ...c,
      memories,
      recent,
      currentInput: r.body,
      sourceMessageId: r.message_id,
      timezone: "Asia/Shanghai",
      localTime: new Date().toLocaleString("sv-SE", {
        timeZone: "Asia/Shanghai",
      }),
      runId: r.id,
    };
  }
  step(session: string, tools: string[]) {
    const r = this.active(session);
    if (r.steps >= 12) throw new InputError("已达到本轮模型步骤上限", 409);
    this.db.prepare("UPDATE runs SET steps=steps+1 WHERE id=?").run(r.id);
    this.setMeta("verified_tools", JSON.stringify(tools));
  }
  memoryAction(session: string, callId: string, name: string, args: any) {
    return this.transaction(() => {
      const r = this.active(session);
      const old = this.db
        .prepare("SELECT * FROM actions WHERE run_id=? AND call_id=?")
        .get(r.id, callId) as any;
      if (old) {
        if (old.name !== name || old.args !== JSON.stringify(args))
          throw new InputError("动作重放不一致", 409);
        return JSON.parse(old.result);
      }
      const count = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM actions WHERE run_id=?")
          .get(r.id) as any
      ).n;
      if (count >= 8) throw new InputError("本轮写入预算已用尽", 409);
      const quote = text(args.evidence, 2000);
      if (!r.body.includes(quote))
        throw new InputError("记忆必须引用本轮用户原话");
      let result: any;
      if (name === "memory_forget") {
        this.forget(args.id, args.revision);
        result = { forgotten: true, historyRetained: true };
      } else {
        const duplicate =
          !args.id &&
          this.db
            .prepare(
              "SELECT * FROM memories WHERE status='active' AND content=? AND kind=? AND expires_at IS ?",
            )
            .get(args.content, args.kind, args.expiresAt ?? null);
        result =
          duplicate ||
          this.saveMemory({ ...args, sourceMessageId: r.message_id });
      }
      this.db
        .prepare("INSERT INTO actions VALUES(?,?,?,?,?)")
        .run(r.id, callId, name, JSON.stringify(args), JSON.stringify(result));
      return result;
    });
  }
  recordSources(session: string, sources: any[]) {
    const r = this.active(session);
    for (const x of sources.slice(0, 8)) {
      let u: URL;
      try {
        u = new URL(x.url);
      } catch {
        continue;
      }
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        continue;
      this.db
        .prepare("INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?,?,?)")
        .run(
          createHash("sha256")
            .update(r.id + u.href)
            .digest("hex"),
          r.id,
          u.href,
          String(x.title || u.hostname).slice(0, 500),
          String(x.snippet || x.summary || "").slice(0, 1000),
          x.publishedAt || null,
          Date.now(),
        );
    }
  }
  expireContext(now = Date.now()) {
    const latest = (
      this.db
        .prepare(
          "SELECT MAX(expires_at) AS t FROM memories WHERE status='active' AND expires_at<=?",
        )
        .get(now) as any
    ).t;
    if (latest && latest > Number(this.getMeta("expiry_checked") || 0)) {
      this.invalidateContext(now);
      this.setMeta("expiry_checked", String(latest));
    }
  }
}
