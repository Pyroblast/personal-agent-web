import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
test("local API authenticates, rejects cross-origin mutations and persists honest blocked input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-mvp-http-")),
    app = createApp(dir);
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const port = (app.server.address() as any).port,
      url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(url + "/api/state")).status, 401);
    const headers = {
      authorization: `Bearer ${app.token}`,
      "content-type": "application/json",
    };
    assert.equal(
      (
        await fetch(url + "/api/messages", {
          method: "POST",
          headers: { ...headers, origin: "https://example.com" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ text: "合成接口测试", requestKey: "http-1" }),
        })
      ).status,
      201,
    );
    const state = (await (
      await fetch(url + "/api/state", { headers })
    ).json()) as any;
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].status, "blocked");
    assert.equal(state.runtime.mode, "not-connected");
    assert.equal(state.runtime.search, false);
  } finally {
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true });
  }
});

test("one scheduler per data directory; heartbeat settings persist, CAS and reply rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-mvp-hb-api-"));
  let app = createApp(dir);
  try {
    assert.throws(() => createApp(dir), /第二个调度器/);
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    let url = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const request = (path: string, b: any) =>
      fetch(url + "/api/" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(b),
      });
    assert.equal(
      (await request("heartbeat", { patch: { enabled: true }, revision: 1 }))
        .status,
      200,
    );
    assert.equal(
      (await request("heartbeat", { patch: { enabled: false }, revision: 1 }))
        .status,
      409,
    );
    assert.equal((await request("heartbeat/check", {})).status, 200);
    assert.equal((await request("heartbeat/check", {})).status, 409);
    assert.equal(
      (
        await request("messages", {
          text: "回复不存在的主动消息",
          requestKey: "invalid-reply",
          replyTo: "no-such-id",
        })
      ).status,
      400,
    );
    assert.equal(app.store.state().messages.length, 0);
    const next = app.engine.heartbeat.status().nextAt;
    await app.engine.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    app = createApp(dir);
    assert.equal(app.engine.heartbeat.policy().enabled, true);
    assert.equal(app.engine.heartbeat.status().nextAt, next);
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  } finally {
    await app.engine.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true });
  }
});

test("MVP3 API authenticates work actions, preserves atomicity and CAS; reminders run while model busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-mvp-work-api-")),
    app = createApp(dir);
  try {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const headers = {
      authorization: "Bearer " + app.token,
      "content-type": "application/json",
    };
    const post = (args: any, key = "work-1", extra: any = {}) =>
      fetch(url + "/api/work", {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify({ name: "task_manage", args, requestKey: key }),
      });
    const args = {
      action: "create",
      kind: "reminder",
      title: "合成提醒",
      due_at: Date.now() + 60000,
    };
    assert.equal(
      (await post(args, "cross", { origin: "https://example.com" })).status,
      403,
    );
    assert.equal((await post({ ...args, due_at: 1 })).status, 400);
    assert.equal(app.engine.work.state().goals.length, 0);
    const response = await post(args);
    assert.equal(response.status, 200);
    const x: any = await response.json();
    assert.equal((await post(args)).status, 200);
    assert.equal(app.engine.work.state().tasks.length, 1);
    assert.equal(
      (await post({ action: "pause", id: x.task_id, revision: 99 }, "cas"))
        .status,
      409,
    );
    app.engine.work.now = () => args.due_at + 1;
    app.engine.active = { trigger_type: "user_message" };
    await app.engine.pump();
    app.engine.active = undefined;
    assert.equal(app.store.state().messages.length, 1);
    assert.equal(app.store.state().runs.length, 0);
    assert.equal(app.engine.work.goal(x.goal_id).status, "completed");
    assert.equal(
      (await fetch(url + "/api/artifact?id=missing", { headers })).status,
      404,
    );
  } finally {
    await app.engine.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true });
  }
});

test("MVP3 restart retains task IDs, browser token and reminder executes once without model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-mvp3-restart-"));
  let app = createApp(dir);
  let listening = false;
  try {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    listening = true;
    const token = app.token,
      at = Date.now() + 60000;
    const x = app.engine.work.command(
      "task_manage",
      { action: "create", kind: "reminder", title: "重启提醒", due_at: at },
      null,
      "restart-case",
    );
    await app.engine.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    listening = false;
    app.store.close();
    app = createApp(dir);
    assert.equal(app.token, token);
    assert.equal(app.engine.work.task(x.task_id).goal_id, x.goal_id);
    app.engine.work.now = () => at + 1;
    app.engine.work.tick();
    app.engine.work.tick();
    assert.equal(app.store.state().messages.length, 1);
    assert.equal(app.store.state().runs.length, 0);
    assert.equal(app.engine.work.goal(x.goal_id).status, "completed");
  } finally {
    await app.engine.close();
    if (listening) await new Promise<void>((r) => app.server.close(() => r()));
    else app.server.emit("close");
    app.store.close();
    rmSync(dir, { recursive: true });
  }
});
