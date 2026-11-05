import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Heartbeat, INTERVAL, dayStart } from "../src/heartbeat.js";
import { Engine } from "../src/engine.js";
function fixture() {
  const store = new Store(":memory:");
  let now = Date.now();
  const h = new Heartbeat(store, () => now);
  const m: any = store.saveMemory({
    content: "用户希望空闲时收到十分钟练琴建议",
    kind: "preference",
  });
  h.update({ enabled: true, startHour: 0, endHour: 24 }, 1);
  const start = () => {
    const r: any = h.claim(true);
    assert(r?.id);
    store.startRun(r.id, "hb-" + r.id);
    return r;
  };
  const contact = (r: any, message = "可以拿起吉他轻轻练十分钟。") =>
    h.settle(
      r.id,
      JSON.stringify({
        decision: "contact",
        topic: "music_practice",
        memoryIds: [m.id],
        reason: "用户希望收到练习建议",
        message,
      }),
    );
  return {
    store,
    h,
    m,
    start,
    contact,
    tick: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}
test("30 minute durable occurrence, missed checks coalesce, atomic delivery and no replay", () => {
  const f = fixture();
  assert.equal(f.h.claim(), null);
  f.tick(INTERVAL * 5);
  const r: any = f.h.claim();
  assert(r.id);
  assert.equal(f.h.status().nextAt, f.now + INTERVAL);
  f.store.startRun(r.id, "s");
  f.contact(r);
  f.contact(r);
  assert.equal(f.h.status().deliveries.length, 1);
  assert.equal(f.store.state().messages.length, 1);
  assert.equal(f.h.claim(), null);
  f.store.close();
});
test("recent conversation, quiet hours, no memories and daily budgets skip before model", () => {
  const f = fixture();
  f.store.enqueue("今天不想聊", "user", true);
  assert.equal((f.h.claim(true) as any).skipped, true);
  assert.equal(f.h.status().counts.models, 0);
  f.tick(11 * 60000);
  f.h.update({ pausedUntil: f.now + 3600000 }, f.h.policy().revision);
  assert.match(f.h.gate()!, /暂停/);
  f.tick(3600001);
  assert.doesNotThrow(() =>
    f.h.update({ dailyLimit: 2 }, f.h.policy().revision),
  );
  f.store.forget(f.m.id, 1);
  assert.match(f.h.gate()!, /记忆/);
  f.store.close();
});
for (const change of ["policy", "memory", "user", "expired"])
  test("late proposal is fenced after " + change, () => {
    const f = fixture();
    const r = f.start();
    if (change === "policy")
      f.h.update({ enabled: false }, f.h.policy().revision);
    if (change === "memory")
      f.store.saveMemory({
        id: f.m.id,
        revision: 1,
        content: "今天不练琴",
        kind: "preference",
      });
    if (change === "user") f.store.enqueue("今晚不练", "new", true);
    if (change === "expired")
      f.store.db.prepare("UPDATE memories SET expires_at=?").run(f.now - 1);
    f.contact(r);
    assert.equal(f.h.status().deliveries.length, 0);
    assert.equal(f.h.status().checks[0].status, "cancelled");
    f.store.close();
  });
test("unanswered topic is not re-prompted even after cooldown; reply links and mute remain authoritative", () => {
  const f = fixture();
  f.contact(f.start());
  const d: any = f.h.status().deliveries[0];
  f.tick(25 * 3600000);
  assert.match(f.h.topicBlocked("music_practice")!, /反馈/);
  const user: any = f.store.enqueue("今天不练，暂停练琴话题", "reply", true);
  f.h.link(user.id, d.message_id);
  assert.equal(f.h.topicBlocked("music_practice"), null);
  assert.equal((f.h.chatContext(user.id).replyTo as any).id, d.message_id);
  f.h.update({ mutedTopics: { music_practice: null } }, f.h.policy().revision);
  assert.match(f.h.topicBlocked("music_practice")!, /暂停/);
  f.store.close();
});
test("invalid source, malformed proposal and failed search never masquerade as delivered or model silence", () => {
  for (const kind of ["source", "json", "search"]) {
    const f = fixture();
    const r = f.start();
    if (kind === "search")
      f.store.db
        .prepare("UPDATE heartbeat_checks SET search_failed=1 WHERE run_id=?")
        .run(r.id);
    if (kind === "json") f.h.settle(r.id, "not json");
    else
      f.contact(
        r,
        kind === "source"
          ? "看 https://unverified.example/test"
          : "建议休息一下",
      );
    assert.equal(f.h.status().checks[0].status, "failed");
    assert.equal(f.h.status().deliveries.length, 0);
    f.store.close();
  }
});
test("foreground session survives interrupted background, interrupted run cannot publish on restart", () => {
  const f = fixture();
  f.store.setMeta("session_id", "foreground");
  const r = f.start();
  f.store.recover();
  const after = new Heartbeat(f.store, () => f.now);
  assert.equal(f.store.getMeta("session_id"), "foreground");
  after.settle(r.id, "{}");
  assert.equal(after.status().checks[0].status, "interrupted");
  assert.equal(after.status().deliveries.length, 0);
  f.store.close();
});
test("background tool authority is read-only with explicit search opt-in and step limits", () => {
  const f = fixture();
  const r = f.start();
  const e = Object.create(Engine.prototype) as Engine;
  e.store = f.store;
  e.heartbeat = f.h;
  e.active = f.store.active("hb-" + r.id);
  e.webKinds = {};
  e.searchCalls = 0;
  assert.deepEqual(e.toolsForRun(), ["memory_list"]);
  assert.throws(() =>
    e.internal("authorize", {
      session: e.active.session_id,
      name: "memory_save",
    }),
  );
  assert.throws(() =>
    e.internal("memory", { session: e.active.session_id, name: "memory_save" }),
  );
  assert.throws(() =>
    e.internal("care-policy", {
      session: e.active.session_id,
      args: {},
      callId: "x",
    }),
  );
  for (let i = 0; i < 3; i++)
    e.internal("step", {
      session: e.active.session_id,
      tools: ["memory_list"],
    });
  assert.throws(() =>
    e.internal("step", {
      session: e.active.session_id,
      tools: ["memory_list"],
    }),
  );
  f.store.close();
});
test("manual checks obey contact and model budgets and rate limiting", () => {
  const f = fixture();
  const r = f.start();
  f.h.settle(
    r.id,
    JSON.stringify({ decision: "silent", reason: "现在不必联系" }),
  );
  assert.throws(() => f.h.claim(true));
  f.tick(61000);
  f.h.update({ modelDailyLimit: 1 }, f.h.policy().revision);
  assert.equal((f.h.claim(true) as any).skipped, true);
  assert.equal(f.h.status().counts.models, 1);
  f.store.close();
});
test("chat policy actions require current user evidence, are idempotent and enforce revision", () => {
  const f = fixture();
  const m: any = f.store.enqueue("今天别主动联系我", "pause", true);
  const r: any = f.store.next();
  f.store.startRun(r.id, "chat");
  const args = {
    action: "pause_today",
    evidence: "今天别主动联系我",
    revision: f.h.policy().revision,
  };
  const result = f.h.action(r.id, "call", args);
  assert.equal(result.pausedUntil, dayStart(f.now) + 86400000);
  assert.deepEqual(f.h.action(r.id, "call", args), result);
  assert.throws(() =>
    f.h.action(r.id, "another", { ...args, evidence: "开启" }),
  );
  assert.throws(() => f.h.action(r.id, "stale", args));
  f.store.close();
});

test("topic grouping does not classify every kind of practice as music", async () => {
  const { topicFor } = await import("../src/heartbeat.js");
  assert.equal(topicFor("用户希望得到摄影练习"), "daily_life");
  assert.equal(topicFor("用户想做烹饪练习"), "daily_life");
  assert.equal(topicFor("用户愿意练电吉他"), "music_practice");
});

test("queued heartbeat interrupted between claim and worker start never remains pending on restart", () => {
  const f = fixture();
  const r: any = f.h.claim(true);
  assert(r.id);
  const restored = new Heartbeat(f.store, () => f.now);
  assert.equal(restored.status().checks[0].status, "interrupted");
  assert.equal(
    (f.store.db.prepare("SELECT status FROM runs WHERE id=?").get(r.id) as any)
      .status,
    "interrupted",
  );
  f.store.close();
});

test("viewing a proactive message does not count as replying or clear unanswered suppression", () => {
  const f = fixture();
  f.contact(f.start());
  const d: any = f.h.status().deliveries[0];
  f.h.seen([d.message_id]);
  f.tick(25 * 3600000);
  const viewed: any = f.h.status().deliveries[0];
  assert(viewed.seen_at);
  assert.equal(viewed.replied_at, null);
  assert.match(f.h.topicBlocked("music_practice")!, /反馈/);
  f.store.close();
});

test("topic pause and resume are explicit feedback without pretending a chat reply or a read", () => {
  const f = fixture();
  f.contact(f.start());
  f.h.update({ mutedTopics: { music_practice: null } }, f.h.policy().revision);
  f.tick(25 * 3600000);
  assert.match(f.h.topicBlocked("music_practice")!, /暂停/);
  f.h.update({ mutedTopics: {} }, f.h.policy().revision);
  assert.equal(f.h.topicBlocked("music_practice"), null);
  const d: any = f.h.status().deliveries[0];
  assert.equal(d.replied_at, null);
  assert.equal(d.seen_at, null);
  assert.equal(d.feedback, "resumed");
  f.store.close();
});

test("heartbeat expires old conversation context before taking its bounded dated snapshot", () => {
  const f = fixture();
  const tmp: any = f.store.saveMemory({
    content: "今天不能练琴",
    kind: "temporary",
    expiresAt: Date.now() + 30000,
  });
  const m: any = f.store.enqueue("今天不能练琴", "old", false);
  f.store.db
    .prepare("UPDATE messages SET status='completed',created_at=? WHERE id=?")
    .run(f.now - 1200000, m.id);
  f.tick(11 * 60000);
  const r: any = f.h.claim(true);
  assert(r?.id);
  const c = f.h.context(r.id);
  assert(!c.memories.some((x: any) => x.id === tmp.id));
  assert.equal(c.recent.length, 0);
  f.store.close();
});

test("service shutdown waits for an already-started worker reap", async () => {
  const { EventEmitter } = await import("node:events");
  const f = fixture();
  let stopped = false,
    sends = 0;
  const child: any = new EventEmitter();
  child.pid = 99999999;
  child.exitCode = null;
  child.send = () => {
    sends++;
    setTimeout(() => {
      stopped = true;
      child.exitCode = 0;
      child.emit("exit", 0);
    }, 20);
  };
  const e = Object.create(Engine.prototype) as Engine;
  e.store = f.store;
  e.heartbeat = f.h;
  e.child = child;
  const stopping = e.stopWorker();
  await e.close();
  assert(
    stopped,
    "close must not return while previous worker shutdown is pending",
  );
  await stopping;
  assert.equal(sends, 1);
  assert.equal(e.child, undefined);
  f.store.close();
});

test("exhausted background search budget is a policy skip, never a model no-news silence", () => {
  const f = fixture();
  f.h.update(
    { searchEnabled: true, searchDailyLimit: 0 },
    f.h.policy().revision,
  );
  const r = f.start();
  const e = Object.create(Engine.prototype) as Engine;
  e.store = f.store;
  e.heartbeat = f.h;
  e.active = f.store.active("hb-" + r.id);
  e.webKinds = {};
  e.searchCalls = 0;
  assert.throws(
    () =>
      e.internal("authorize", {
        session: e.active.session_id,
        name: "web_search",
      }),
    /预算/,
  );
  f.h.settle(
    r.id,
    JSON.stringify({ decision: "silent", reason: "没有新消息" }),
  );
  assert.equal(f.h.status().checks[0].status, "skipped");
  assert.match(f.h.status().checks[0].reason, /预算/);
  assert.equal(f.h.status().counts.searches, 0);
  f.store.close();
});

test('simulated two-day schedule respects daily reset and never repeats unanswered topics',()=>{
 const s=new Store(':memory:');let now=dayStart(Date.now())+86400000;const h=new Heartbeat(s,()=>now);
 for(const content of ['用户希望收到练吉他的建议','用户希望收到音乐欣赏建议','用户希望得到工作休息建议','用户希望得到出行准备建议','用户希望得到绘画建议'])s.saveMemory({content,kind:'preference'});
 h.update({enabled:true,startHour:8,endHour:22},1);
 const dailyContacts:number[]=[];
 for(let day=0;day<2;day++){
  for(let tick=0;tick<48;tick++){
   const r:any=h.claim();
   if(r?.id){s.startRun(r.id,'sim-'+r.id);const context=h.context(r.id);const topic=context.topics.find((t:any)=>t.memoryIds.length&&!t.blocked);assert(topic);h.settle(r.id,JSON.stringify({decision:'contact',topic:topic.id,memoryIds:[topic.memoryIds[0]],reason:'合成测试中的明确意愿',message:'合成提案 '+topic.id}));}
   const count=h.counts();assert(count.contacts<=3);assert(count.models<=28);assert.equal(count.searches,0);
   if(tick===47)dailyContacts.push(count.contacts);
   now+=INTERVAL;
  }
 }
 assert.deepEqual(dailyContacts,[3,2]);assert.equal(h.status().deliveries.length,5);assert.equal(new Set((h.status().deliveries as any[]).map(d=>d.topic)).size,5);
 assert.equal((s.db.prepare('SELECT COUNT(*) n FROM heartbeat_checks').get() as any).n,95);s.close();
});
