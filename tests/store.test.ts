import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
test("accepted input survives restart; request replay cannot duplicate or change it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-mvp-test-")),
    path = join(dir, "db.sqlite");
  let s = new Store(path);
  try {
    const a = s.enqueue("合成测试输入", "request-1") as any;
    s.close();
    s = new Store(path);
    assert.equal((s.enqueue("合成测试输入", "request-1") as any).id, a.id);
    assert.equal(s.state().messages.length, 1);
    assert.equal(s.state().runs.length, 1);
    assert.throws(() => s.enqueue("不同输入", "request-1"), /不能变更/);
    s.cancel(a.id);
    assert.equal((s.state().runs[0] as any).status, "cancelled");
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});
test("memory corrections reject stale writes and forgetting invalidates old context", () => {
  const s = new Store(":memory:");
  try {
    s.enqueue("晚饭后练琴", "m1");
    const a = s.saveMemory({
      content: "晚饭后练琴",
      kind: "preference",
    }) as any;
    const b = s.saveMemory({
      id: a.id,
      revision: 1,
      content: "早晨练琴",
      kind: "preference",
    }) as any;
    assert.equal(b.revision, 2);
    assert.throws(
      () =>
        s.saveMemory({
          id: a.id,
          revision: 1,
          content: "旧内容",
          kind: "preference",
        }),
      /已变化/,
    );
    assert.equal(s.context().recent.length, 0);
    assert.equal((s.context().memories[0] as any).content, "早晨练琴");
    s.forget(a.id, 2);
    assert.equal(s.context().memories.length, 0);
    assert.equal(s.state().messages.length, 1);
    assert.throws(() => s.forget(a.id, 2), /已变化/);
  } finally {
    s.close();
  }
});
test("temporary memories require future expiry, and expired facts do not enter context", () => {
  const s = new Store(":memory:");
  try {
    assert.throws(
      () => s.saveMemory({ content: "本周加班", kind: "temporary" }),
      /有效期/,
    );
    const expires = Date.now() + 60000;
    s.saveMemory({
      content: "本周加班",
      kind: "temporary",
      expiresAt: expires,
    });
    assert.equal(s.context().memories.length, 1);
    assert.equal(s.context(expires + 1).memories.length, 0);
    assert.throws(
      () =>
        s.saveMemory({
          content: "来源错误",
          kind: "fact",
          sourceMessageId: "missing",
        }),
      /来源/,
    );
  } finally {
    s.close();
  }
});
