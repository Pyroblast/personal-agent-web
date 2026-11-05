import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Engine, ALLOWED } from "../src/engine.js";
function fixture() {
  const s = new Store(":memory:");
  const m = s.enqueue("我喜欢早晨练琴；请记住。", "new", true) as any;
  const r = s.next();
  s.startRun(r.id, "s1");
  const e = Object.create(Engine.prototype) as Engine;
  Object.assign(e, { store: s, active: s.active("s1"), searchCalls: 0 });
  return { s, e, r, m };
}
test("running authority, exact source quote, idempotent memory and cancelled fencing", () => {
  const { s, e, r, m } = fixture();
  try {
    const args = {
      content: "喜欢早晨练琴",
      kind: "preference",
      evidence: "我喜欢早晨练琴",
    };
    const a = e.internal("memory", {
      session: "s1",
      callId: "1",
      name: "memory_save",
      args,
    }) as any;
    assert.equal(a.source_message_id, m.id);
    assert.equal(
      (
        e.internal("memory", {
          session: "s1",
          callId: "1",
          name: "memory_save",
          args,
        }) as any
      ).id,
      a.id,
    );
    assert.equal(s.state().memories.length, 1);
    assert.throws(
      () =>
        e.internal("memory", {
          session: "s1",
          callId: "2",
          name: "memory_save",
          args: { ...args, evidence: "网页说的内容" },
        }),
      /原话/,
    );
    s.fail(r.id, "cancel");
    assert.throws(
      () =>
        e.internal("memory", {
          session: "s1",
          callId: "3",
          name: "memory_save",
          args,
        }),
      /失效/,
    );
  } finally {
    s.close();
  }
});
test("tool allowlist, budget, URL provenance and local network exclusion", () => {
  const { s, e } = fixture();
  try {
    assert.throws(
      () => e.internal("step", { session: "s1", tools: [...ALLOWED, "bash"] }),
      /工具集合/,
    );
    e.internal("step", { session: "s1", tools: ALLOWED });
    assert.throws(
      () => e.internal("authorize", { session: "s1", name: "bash" }),
      /未授权/,
    );
    assert.throws(
      () =>
        e.internal("fetch-authorize", {
          session: "s1",
          url: "http://127.0.0.1:1234/",
        }),
      /公开网页/,
    );
    assert.throws(
      () =>
        e.internal("fetch-authorize", {
          session: "s1",
          url: "https://example.com/",
        }),
      /本轮/,
    );
    e.internal("sources", {
      session: "s1",
      sources: [{ url: "https://example.com/", title: "synthetic" }],
    });
    e.internal("fetch-authorize", {
      session: "s1",
      url: "https://example.com/",
    });
    for (let i = 0; i < 8; i++)
      e.internal("authorize", { session: "s1", name: "web_search" });
    assert.throws(
      () => e.internal("authorize", { session: "s1", name: "web_search" }),
      /预算/,
    );
  } finally {
    s.close();
  }
});
test("atomic completion publishes once, interrupted runs never replay, queued inputs survive", () => {
  const { s, r } = fixture();
  try {
    s.finish(r.id, "收到", { synthetic: true });
    s.finish(r.id, "重复", {});
    assert.equal(s.state().messages.length, 2);
    s.enqueue("第二条", "two", true);
    s.recover();
    assert.equal(s.next().body, "第二条");
    s.startRun(s.next().id, "s2");
    s.recover();
    assert.equal(s.next(), undefined);
    assert.equal((s.state().runs.at(-1) as any).status, "interrupted");
  } finally {
    s.close();
  }
});
test("context is bounded and prefers relevant memories, expired context rotates", () => {
  const { s } = fixture();
  try {
    for (let i = 0; i < 20; i++)
      s.saveMemory({ content: "合成出行偏好" + i, kind: "preference" });
    s.saveMemory({ content: "喜欢早晨练琴", kind: "preference" });
    const c = s.runtimeContext("s1");
    assert.equal(c.memories.length, 12);
    assert.ok(c.memories.some((m) => m.content === "喜欢早晨练琴"));
    const m = s.saveMemory({
      content: "临时会议",
      kind: "temporary",
      expiresAt: Date.now() + 60000,
    }) as any;
    s.db
      .prepare("UPDATE memories SET expires_at=? WHERE id=?")
      .run(Date.now() - 1, m.id);
    s.expireContext();
    assert.ok(Number(s.getMeta("context_epoch")) > 0);
    assert.ok(
      !s.runtimeContext("s1").memories.some((item) => item.id === m.id),
    );
  } finally {
    s.close();
  }
});
test("forget completion excludes an acknowledgement that repeats the removed fact", () => {
  const { s, r } = fixture();
  try {
    const mem = s.saveMemory({
      content: "早晨练琴",
      kind: "preference",
    }) as any;
    s.memoryAction("s1", "forget", "memory_forget", {
      id: mem.id,
      revision: mem.revision,
      evidence: "我喜欢早晨练琴",
    });
    s.finish(r.id, "已经忘记早晨练琴。", {});
    assert.equal(s.context().recent.length, 0);
    assert.equal(s.context().memories.length, 0);
  } finally {
    s.close();
  }
});
test("wall-clock deadline fences writes after a long pause", async () => {
  const { s, e, r } = fixture();
  try {
    s.db
      .prepare("UPDATE runs SET started_at=? WHERE id=?")
      .run(Date.now() - 180001, r.id);
    assert.throws(
      () =>
        e.internal("memory", {
          session: "s1",
          callId: "late",
          name: "memory_save",
          args: {
            content: "早晨练琴",
            kind: "preference",
            evidence: "我喜欢早晨练琴",
          },
        }),
      /期限/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.state().memories.length, 0);
    assert.equal((s.state().runs[0] as any).status, "failed");
  } finally {
    s.close();
  }
});
