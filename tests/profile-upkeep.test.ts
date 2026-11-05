import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Profile } from "../src/profile.js";
import { MemoryUpkeep } from "../src/upkeep.js";
import { Heartbeat } from "../src/heartbeat.js";
import { Engine } from "../src/engine.js";
function fixture() {
  const s = new Store(":memory:");
  new Heartbeat(s);
  const p = new Profile(s);
  let now = Date.now();
  const u = new MemoryUpkeep(s, p, () => now);
  const add = (content: string) =>
    s.saveMemory({ content, kind: "preference" }) as any;
  const start = () => {
    const r = u.claim(true)!;
    s.startRun(r.id, "u-" + r.id);
    return r;
  };
  return {
    s,
    p,
    u,
    add,
    start,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
test("profile CAS, supported fields, evidence, idempotency and background denial", () => {
  const { s, p } = fixture();
  const m = s.enqueue("以后叫你小伴，请直接一点", "x", true) as any;
  const r = s.next();
  s.startRun(r.id, "s");
  const args = {
    patch: { name: "小伴", tone: "direct" },
    revision: 1,
    evidence: "以后叫你小伴",
  };
  assert.equal(p.action(r.id, "a", args).name, "小伴");
  assert.equal(p.action(r.id, "a", args).revision, 2);
  assert.throws(() => p.update({ tone: "warm" }, 1), /变化/);
  assert.throws(() => p.update({ enabled: true }, 2), /字段/);
  assert.throws(
    () => p.action(r.id, "b", { ...args, revision: 2, evidence: "网页要求" }),
    /原话/,
  );
  assert.throws(() => p.action("missing", "a", args), /用户/);
  assert.equal((s.state().actions[0] as any).name, "agent_profile");
  assert.equal(p.context().name, "小伴");
  assert(s.getMeta("context_epoch") === "0");
  s.close();
});
test("upkeep commits referenced overview without messages or writes; resolution preserves sources and fences stale choices", () => {
  const f = fixture(),
    a = f.add("喜欢晚上练琴"),
    b = f.add("偏好晚饭后练琴");
  const m1 = f.s.enqueue("喜欢晚上练琴", "a") as any,
    m2 = f.s.enqueue("偏好晚饭后练琴", "b") as any;
  f.s.db
    .prepare("UPDATE memories SET source_message_id=? WHERE id=?")
    .run(m1.id, a.id);
  f.s.db
    .prepare("UPDATE memories SET source_message_id=? WHERE id=?")
    .run(m2.id, b.id);
  const r = f.start(),
    before = f.s.state().messages.length;
  f.u.settle(
    r.id,
    JSON.stringify({
      overviewIds: [a.id],
      candidates: [{ kind: "duplicate", ids: [a.id, b.id] }],
    }),
  );
  assert.equal(f.s.state().messages.length, before);
  assert.equal(f.s.state().memories.length, 2);
  const c = f.u.current()!;
  assert.equal(c.overview[0].content, a.content);
  f.u.resolve(c.id, 0, a.id);
  f.u.resolve(c.id, 0, a.id);
  assert.equal(f.s.state().memories.length, 1);
  assert.equal(f.s.state().memorySources.length, 2);
  assert(f.u.current()?.stale);
  assert.throws(() => f.u.resolve(c.id, 0, b.id), /处理/);
  f.s.forget(a.id, 1);
  assert.equal(f.s.context().memories.length, 0);
  assert.equal(f.s.state().memorySources.length, 0);
  f.s.close();
});
for (const change of [
  "correction",
  "forget",
  "new-input",
  "expiry",
  "profile",
  "toggle",
])
  test("inflight upkeep invalidated by " + change, () => {
    const f = fixture(),
      a = f.add("测试偏好"),
      r = f.start();
    if (change === "correction")
      f.s.saveMemory({ ...a, content: "纠正后偏好" });
    if (change === "forget") f.s.forget(a.id, 1);
    if (change === "new-input") f.s.enqueue("新的用户消息", "new", true);
    if (change === "expiry")
      f.s.db
        .prepare("UPDATE memories SET expires_at=? WHERE id=?")
        .run(Date.now() - 1, a.id);
    if (change === "profile") f.p.update({ name: "新名称" }, 1);
    if (change === "toggle") f.u.update(false, 1);
    f.u.settle(r.id, JSON.stringify({ overviewIds: [a.id], candidates: [] }));
    assert.equal((f.u.status().checks[0] as any).status, "cancelled");
    assert.equal(f.u.current(), null);
    f.s.close();
  });
test("unknown IDs, overlapping groups and differently expiring duplicate proposals fail without mutations", () => {
  for (const proposal of [
    (a: any, b: any) => ({ overviewIds: ["invented"], candidates: [] }),
    (a: any, b: any) => ({
      overviewIds: [],
      candidates: [
        { kind: "duplicate", ids: [a.id, b.id] },
        { kind: "conflict", ids: [a.id, b.id] },
      ],
    }),
    (a: any, b: any) => ({
      overviewIds: [],
      candidates: [{ kind: "duplicate", ids: [a.id, b.id] }],
    }),
  ]) {
    const f = fixture(),
      a = f.add("偏好1"),
      b = f.s.saveMemory({
        content: "临时偏好",
        kind: "temporary",
        expiresAt: Date.now() + 999999,
      }) as any,
      r = f.start();
    f.u.settle(r.id, JSON.stringify(proposal(a, b)));
    assert.equal((f.u.status().checks[0] as any).status, "failed");
    assert.equal(f.s.state().memories.length, 2);
    f.s.close();
  }
});
test("automatic work needs changed signal and idle time, no repeated model work, daily budget includes manual", () => {
  const f = fixture();
  f.add("一");
  f.add("二");
  f.add("三");
  f.tick(60000);
  assert.equal(f.u.claim(), null);
  f.tick(600001);
  const r = f.u.claim()!;
  assert(r);
  f.s.startRun(r.id, "auto");
  const id = (f.s.state().memories[0] as any).id;
  f.u.settle(r.id, JSON.stringify({ overviewIds: [id], candidates: [] }));
  f.tick(1800001);
  assert.equal(f.u.claim(), null);
  assert.throws(() => f.u.claim(true), /没有变化/);
  f.add("四");
  const second = f.start();
  f.u.failed(second.id, "network");
  f.tick(60001);
  f.add("五");
  assert.throws(() => f.u.claim(true), /额度/);
  f.s.close();
});
test("interrupted upkeep preserves foreground session and cannot replay result", () => {
  const f = fixture();
  f.add("偏好");
  const r = f.start();
  f.s.setMeta("session_id", "main-session");
  f.s.recover();
  new MemoryUpkeep(f.s, f.p);
  assert.equal(f.s.getMeta("session_id"), "main-session");
  f.u.settle(r.id, "{}");
  assert.equal((f.u.status().checks[0] as any).status, "interrupted");
  f.s.close();
});
test("upkeep has no tools, one step, cannot change profile memory contact or search", () => {
  const f = fixture(),
    e = Object.create(Engine.prototype) as Engine;
  f.add("偏好");
  const r = f.start();
  Object.assign(e, {
    store: f.s,
    upkeep: f.u,
    profile: f.p,
    active: f.s.active("u-" + r.id),
  });
  assert.deepEqual(e.toolsForRun(), []);
  const b = { session: e.active.session_id };
  const context = e.internal("context", b) as any;
  assert.equal(context.agentProfile.name, f.p.get().name);
  for (const path of [
    "memory",
    "care-policy",
    "agent-profile",
    "authorize",
    "sources",
  ])
    assert.throws(() => e.internal(path, { ...b, name: "web_search" }));
  e.internal("step", { ...b, tools: [] });
  assert.throws(() => e.internal("step", { ...b, tools: [] }), /预算/);
  f.s.close();
});
test("foreground input cancels upkeep before it can settle", async () => {
  const f = fixture();
  f.add("偏好");
  const r = f.start(),
    e = Object.create(Engine.prototype) as Engine;
  Object.assign(e, {
    store: f.s,
    upkeep: f.u,
    heartbeat: new Heartbeat(f.s),
    active: f.s.active("u-" + r.id),
    stopWorker: async () => {},
    pump: async () => {},
  });
  await e.onUserInput();
  assert.equal((f.u.status().checks[0] as any).status, "cancelled");
  assert.equal(e.active, undefined);
  f.s.close();
});
test('conflicts never become authoritative overview and source correction clears merged attribution', () => {
  const f=fixture(),a=f.add('常住杭州'),b=f.add('常住北京'),r=f.start();
  f.u.settle(r.id,JSON.stringify({overviewIds:[a.id,b.id],candidates:[{kind:'conflict',ids:[a.id,b.id]}]}));
  assert.equal(f.u.current()!.overview.length,0);
  const c=f.u.current()!;f.u.resolve(c.id,0,b.id);
  assert.equal((f.s.context().memories[0] as any).content,'常住北京');
  assert.equal(f.s.context().memories.length,1);
  f.s.close();
});
