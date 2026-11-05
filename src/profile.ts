import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, InputError, text } from "./store.js";
export const SOUL = readFileSync(resolve("runtime/SOUL.md"), "utf8").trim();
export const PROFILE_DEFAULT = {
  name: "Personal Agent",
  verbosity: "concise",
  tone: "warm",
  challenge: "balanced",
  revision: 1,
};
const choices: Record<string, string[]> = {
  verbosity: ["concise", "balanced", "detailed"],
  tone: ["warm", "direct"],
  challenge: ["balanced", "candid"],
};
export class Profile {
  constructor(public store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_profile(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS profile_events(id INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,source_message_id TEXT,created_at INTEGER NOT NULL);",
    );
    store.db
      .prepare("INSERT OR IGNORE INTO agent_profile VALUES(1,?)")
      .run(JSON.stringify(PROFILE_DEFAULT));
  }
  get() {
    return JSON.parse(
      (
        this.store.db
          .prepare("SELECT body FROM agent_profile WHERE id=1")
          .get() as any
      ).body,
    );
  }
  context() {
    return {
      ...this.get(),
      principles: SOUL,
      vocabulary: {
        verbosity: { concise: "简短", balanced: "适中", detailed: "详细" },
        tone: { warm: "温和自然", direct: "直接清楚" },
        challenge: {
          balanced: "有必要时提出不同意见",
          candid: "主动指出问题，坦诚给出不同意见",
        },
      },
    };
  }
  update(patch: any, revision: number, sourceMessageId: string | null = null) {
    return this.store.transaction(() => {
      const old = this.get();
      if (old.revision !== revision)
        throw new InputError("助理设置已变化，请刷新重试", 409);
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        !Object.keys(patch).length ||
        Object.keys(patch).some(
          (k) => !["name", ...Object.keys(choices)].includes(k),
        )
      )
        throw new InputError("助理设置字段无效");
      const next = { ...old, ...patch, revision: old.revision + 1 };
      next.name = text(next.name, 40);
      if (/[\r\n<>]/.test(next.name))
        throw new InputError("名称只支持单行文字");
      for (const k of Object.keys(choices))
        if (!choices[k].includes(next[k]))
          throw new InputError("助理设置值无效");
      this.store.db
        .prepare("UPDATE agent_profile SET body=? WHERE id=1")
        .run(JSON.stringify(next));
      this.store.db
        .prepare(
          "INSERT INTO profile_events(revision,source_message_id,created_at) VALUES(?,?,?)",
        )
        .run(next.revision, sourceMessageId, Date.now());
      return next;
    });
  }
  action(runId: string, callId: string, args: any) {
    return this.store.transaction(() => {
      const r = this.store.db
        .prepare(
          "SELECT r.*,m.body FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.status='running' AND r.trigger_type='user_message'",
        )
        .get(runId) as any;
      if (!r) throw new InputError("只有本轮用户可以修改助理设置", 403);
      const old = this.store.db
        .prepare("SELECT * FROM actions WHERE run_id=? AND call_id=?")
        .get(runId, callId) as any;
      if (old) {
        if (old.name !== "agent_profile" || old.args !== JSON.stringify(args))
          throw new InputError("动作重放不一致", 409);
        return JSON.parse(old.result);
      }
      if (
        (
          this.store.db
            .prepare("SELECT COUNT(*) n FROM actions WHERE run_id=?")
            .get(runId) as any
        ).n >= 8
      )
        throw new InputError("本轮写入预算已用尽", 409);
      if (!r.body.includes(text(args.evidence, 2000)))
        throw new InputError("设置须引用本轮原话");
      const result = this.update(args.patch, args.revision, r.message_id);
      this.store.db
        .prepare("UPDATE runs SET profile_revision=? WHERE id=?")
        .run(result.revision, runId);
      this.store.db
        .prepare("INSERT INTO actions VALUES(?,?,?,?,?)")
        .run(
          runId,
          callId,
          "agent_profile",
          JSON.stringify(args),
          JSON.stringify(result),
        );
      return result;
    });
  }
}
