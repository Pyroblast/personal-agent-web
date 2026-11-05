import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Heartbeat } from "../src/heartbeat.js";
test("MVP1 database migration preserves existing message/run IDs and supports nullable heartbeat triggers", () => {
  const dir = mkdtempSync(join(tmpdir(), "mvp-migration-")),
    path = join(dir, "db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE runs(id TEXT PRIMARY KEY,message_id TEXT UNIQUE NOT NULL REFERENCES messages(id),status TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
 INSERT INTO messages VALUES('m','k','user','历史合成消息','completed',1); INSERT INTO runs VALUES('r','m','succeeded','',1);`);
  old.close();
  const s = new Store(path);
  try {
    assert.equal((s.state().messages[0] as any).body, "历史合成消息");
    assert.equal((s.state().runs[0] as any).message_id, "m");
    const h = new Heartbeat(s);
    s.saveMemory({ content: "用户想练琴", kind: "preference" });
    h.update({ enabled: true, startHour: 0, endHour: 24 }, 1);
    assert((h.claim(true) as any).id);
    assert.equal(s.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});

test("MVP2 delivery migration preserves IDs, seen/reply flags, policy, profile and memory", async () => {
  const { Profile } = await import("../src/profile.js");
  const { Work } = await import("../src/work.js");
  const s = new Store(":memory:");
  let h = new Heartbeat(s);
  const profile = new Profile(s);
  s.saveMemory({ content: "合成旧记忆", kind: "preference" });
  h.update({ enabled: true, startHour: 9 }, 1);
  s.db
    .exec(`DROP TABLE deliveries; CREATE TABLE deliveries(id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL,check_id TEXT UNIQUE NOT NULL,message_id TEXT UNIQUE NOT NULL,topic TEXT NOT NULL,body_hash TEXT NOT NULL,created_at INTEGER NOT NULL,replied_at INTEGER,seen_at INTEGER,reason TEXT NOT NULL,memory_refs TEXT NOT NULL,feedback_at INTEGER,feedback TEXT);
 INSERT INTO deliveries VALUES('d','r','c','m','daily_life','hash',1,2,3,'原因','[]',4,'kept');`);
  const before = {
    policy: h.policy(),
    profile: profile.get(),
    memories: s.state().memories,
  };
  h = new Heartbeat(s);
  new Work(s, h);
  const d: any = s.db.prepare("SELECT * FROM deliveries WHERE id=?").get("d");
  assert.equal(d.message_id, "m");
  assert.equal(d.run_id, "r");
  assert.equal(d.seen_at, 3);
  assert.equal(d.replied_at, 2);
  assert.equal(d.feedback, "kept");
  assert.equal(d.source, "heartbeat");
  assert.equal(d.obligation, "discretionary");
  assert.deepEqual(
    {
      policy: h.policy(),
      profile: profile.get(),
      memories: s.state().memories,
    },
    before,
  );
  assert.equal(s.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  s.close();
});
