import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Heartbeat } from "../src/heartbeat.js";
import { Profile } from "../src/profile.js";
import { Work } from "../src/work.js";
import { DAY, MINUTE } from "../src/work-schema.js";
function fixture() {
  const s = new Store(":memory:");
  let now = Date.parse("2026-11-10T10:00:00+08:00");
  const h = new Heartbeat(s, () => now);
  new Profile(s);
  const w = new Work(s, h, () => now);
  let n = 0;
  const command = (name: string, a: any, key?: string) =>
    w.command(name, a, null, key || "op" + ++n);
  const reminder = (extra: any = {}) =>
    command("task_manage", {
      action: "create",
      kind: "reminder",
      title: "喝水",
      expected_result: "到喝水时间了。",
      due_at: now + MINUTE,
      ...extra,
    });
  const goal = () =>
    command("goal_manage", {
      action: "create",
      title: "杭州北京往返",
      completion_criteria: "用户确认返回杭州",
      autonomous: true,
      allow_search: true,
    });
  const start = () => {
    const r = w.claim();
    assert(r);
    s.startRun(r.id, "s-" + r.id);
    return r;
  };
  const draft = (r: any, body = "真实保存的检查清单") =>
    w.stage(r.id, { title: "出行清单", body, source_urls: [] });
  const proposal = (extra: any = {}) =>
    JSON.stringify({
      status: "done",
      summary: "已整理准备清单",
      phase: "准备",
      next_action: "等待你提供起飞时间",
      wait_condition: "请提供起飞时间",
      task_changes: [],
      notify: { event: "milestone", message: "准备清单已经整理好。" },
      ...extra,
    });
  return {
    s,
    h,
    w,
    command,
    reminder,
    goal,
    start,
    draft,
    proposal,
    tick: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}
test("atomic reminder creates exactly one parent, idempotency and payload conflict", () => {
  const f = fixture();
  const a = {
    action: "create",
    kind: "reminder",
    title: "喝水",
    due_at: f.now + MINUTE,
  };
  const r = f.command("task_manage", a, "same");
  assert.equal(f.command("task_manage", a, "same").task_id, r.task_id);
  assert.throws(
    () => f.command("task_manage", { ...a, title: "不同" }, "same"),
    /不能/,
  );
  assert.equal(f.w.state().goals.length, 1);
  assert.equal(f.w.state().tasks.length, 1);
  f.s.close();
});
test("invalid task rolls back outer goal and rejects invalid foreign keys", () => {
  const f = fixture();
  assert.throws(() => f.reminder({ due_at: f.now - 1 }));
  assert.equal(f.w.state().goals.length, 0);
  const r = f.reminder();
  assert.throws(() =>
    f.s.db.prepare("UPDATE tasks SET goal_id=NULL WHERE id=?").run(r.task_id),
  );
  assert.throws(() =>
    f.s.db
      .prepare("UPDATE tasks SET goal_id='absent' WHERE id=?")
      .run(r.task_id),
  );
  f.s.close();
});
test("model-free once reminder publishes exactly once and closes without duplicate goal message", () => {
  const f = fixture(),
    r = f.reminder();
  f.w.modelAvailable = false;
  f.tick(MINUTE);
  f.w.tick();
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.s.state().runs.length, 0);
  assert.equal(f.w.task(r.task_id).status, "completed");
  assert.equal(f.w.goal(r.goal_id).status, "completed");
  assert.equal(f.h.counts().contacts, 0);
  f.s.close();
});
test("reschedule retains IDs, removes old due time and checks CAS", () => {
  const f = fixture(),
    r = f.reminder();
  f.command("task_manage", {
    action: "reschedule",
    id: r.task_id,
    revision: 1,
    due_at: f.now + 2 * MINUTE,
  });
  assert.throws(
    () =>
      f.command("task_manage", { action: "pause", id: r.task_id, revision: 1 }),
    /变化/,
  );
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 0);
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.state().goals.length, 1);
  f.s.close();
});
test("daily reminder coalesces misses and stays active with stable local clock", () => {
  const f = fixture(),
    r = f.reminder({ recurrence: "daily" });
  f.tick(3 * DAY + MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 0);
  assert.equal(f.w.goal(r.goal_id).status, "active");
  assert.equal(
    f.w.task(r.task_id).next_run_at,
    Date.parse("2026-11-14T10:01:00+08:00"),
  );
  f.tick(DAY);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.goal(r.goal_id).status, "active");
  f.s.close();
});
test("late one-off expires instead of claiming success", () => {
  const f = fixture(),
    r = f.reminder();
  f.tick(4 * 60 * MINUTE);
  f.w.tick();
  assert.equal(f.w.task(r.task_id).status, "failed");
  assert.equal(f.w.goal(r.goal_id).status, "waiting");
  assert.equal(f.s.state().messages.length, 0);
  f.s.close();
});
test("quiet-hour opt-in defers reminder and exact-time reminder bypasses heartbeat off", () => {
  const f = fixture();
  f.h.update({ startHour: 15, endHour: 22 }, 1);
  const a = f.reminder({
      quiet_behavior: "respect_window",
      late_window: 7 * 60 * MINUTE,
    }),
    b = f.reminder();
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.task(a.task_id).status, "scheduled");
  assert.equal(f.w.goal(b.goal_id).status, "completed");
  f.tick(5 * 60 * MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 2);
  f.s.close();
});
test("goal pause isolates another goal and preserves user-owned pause provenance", () => {
  const f = fixture(),
    g = f.goal();
  const r = f.reminder({
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
  });
  const independent = f.reminder();
  f.command("task_manage", { action: "pause", id: r.task_id, revision: 1 });
  f.command("goal_manage", {
    action: "pause",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  f.command("goal_manage", {
    action: "resume",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  assert.equal(f.w.task(r.task_id).status, "paused");
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.w.goal(independent.goal_id).status, "completed");
  f.s.close();
});
test("support pause retains user reminder; whole goal completion terminates future work", () => {
  const f = fixture(),
    g = f.goal();
  const r = f.reminder({
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
  });
  f.command("goal_manage", {
    action: "pause_support",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.w.task(r.task_id).status, "completed");
  assert.notEqual(f.w.goal(g.goal_id).status, "completed");
  f.command("goal_manage", {
    action: "complete",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  assert.equal(
    f.s.db
      .prepare("SELECT * FROM system_tasks WHERE id=?")
      .get("goal:" + g.goal_id),
    undefined,
  );
  f.s.close();
});
test("outcome may have zero tasks and waits without polling or invented progress", () => {
  const f = fixture(),
    g = f.goal();
  assert.equal(f.w.tasks(g.goal_id).length, 0);
  f.tick(MINUTE);
  const r = f.start();
  f.w.settle(
    r.id,
    f.proposal({
      status: "waiting",
      notify: { event: "decision", message: "机票订好了吗？" },
    }),
  );
  assert.equal(f.w.goal(g.goal_id).status, "waiting");
  assert.equal(f.w.tasks(g.goal_id).length, 0);
  assert.equal(f.w.claim(), null);
  assert.equal(f.s.state().messages.length, 1);
  f.s.close();
});
test("draft and later follow-up publish distinct versions with durable successor", () => {
  const f = fixture(),
    g = f.goal();
  f.tick(MINUTE);
  let r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal({ next_check_at: f.now + MINUTE }));
  assert.equal(f.w.state().artifacts.length, 1);
  assert.equal(
    f.s.db
      .prepare("SELECT next_at FROM system_tasks WHERE id=?")
      .get("goal:" + g.goal_id)?.next_at,
    f.now + 60 * MINUTE,
  );
  f.tick(60 * MINUTE);
  r = f.start();
  const a = f.w.state().artifacts[0] as any;
  f.w.stage(r.id, {
    artifact_id: a.id,
    expected_version: 1,
    title: "清单",
    body: "新的出发检查成果",
    source_urls: [],
  });
  f.w.settle(
    r.id,
    f.proposal({
      summary: "新的出发检查已保存",
      notify: { event: "milestone", message: "出发检查已更新" },
    }),
  );
  assert.equal((f.w.state().artifacts[0] as any).version, 2);
  assert.equal(f.w.state().reviews.length, 2);
  f.s.close();
});
test("goal creates N bounded tasks, does not get permission to change user tasks", () => {
  const f = fixture(),
    g = f.goal();
  const r0 = f.reminder({
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    due_at: f.now + DAY,
  });
  f.tick(MINUTE);
  let r = f.start();
  f.draft(r);
  f.w.settle(
    r.id,
    f.proposal({
      task_changes: [1, 2].map((i) => ({
        action: "create",
        task: {
          title: "准备" + i,
          kind: "goal_step",
          expected_result: "清单",
          due_at: f.now + i * 60 * MINUTE,
        },
      })),
    }),
  );
  assert.equal(f.w.tasks(g.goal_id).length, 3);
  f.w.wake(g.goal_id);
  f.tick(MINUTE);
  r = f.start();
  f.w.settle(
    r.id,
    f.proposal({
      task_changes: [{ action: "cancel", id: r0.task_id, revision: 1 }],
    }),
  );
  assert.equal(f.w.task(r0.task_id).status, "scheduled");
  assert.equal(
    (f.s.db.prepare("SELECT status FROM runs WHERE id=?").get(r.id) as any)
      .status,
    "failed",
  );
  f.s.close();
});
test("new facts fence old result, cancel only internal plans and retain user reminders", () => {
  const f = fixture(),
    g = f.goal(),
    rem = f.reminder({
      goal_id: g.goal_id,
      goal_revision: f.w.goal(g.goal_id).revision,
      due_at: f.now + DAY,
    });
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.command("goal_progress", {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    fact: "去程改为周六上午",
  });
  f.w.settle(r.id, f.proposal());
  assert.equal(f.w.state().artifacts.length, 0);
  assert.equal(f.w.task(rem.task_id).status, "scheduled");
  assert.equal(f.w.goal(g.goal_id).facts.length, 1);
  f.s.close();
});
test("goal notification silent continues artifacts and does not affect reminders", () => {
  const f = fixture(),
    g = f.goal(),
    rem = f.reminder();
  f.command("goal_manage", {
    action: "notification",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
    notification_mode: "silent",
  });
  f.tick(MINUTE);
  f.w.tick();
  const r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal());
  assert.equal(f.w.state().artifacts.length, 1);
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.goal(rem.goal_id).status, "completed");
  f.s.close();
});
test("shared ordinary quota delays progress while promised work bypasses it", () => {
  const f = fixture();
  f.h.update({ dailyLimit: 1 }, 1);
  for (let i = 0; i < 2; i++) {
    const g = f.goal();
    f.tick(MINUTE);
    const r = f.start();
    f.draft(r, "清单" + i);
    f.w.settle(r.id, f.proposal());
  }
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(
    f.w.state().deliveries.filter((x: any) => x.status === "pending").length,
    1,
  );
  f.reminder();
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 2);
  f.s.close();
});
test("notification defaults do not rewrite existing task contracts; reminder silent rejected", () => {
  const f = fixture(),
    r = f.reminder();
  f.w.notificationUpdate({
    revision: 1,
    reminder_quiet: "respect_window",
    task_mode: "silent",
  });
  assert.equal(f.w.task(r.task_id).delivery_contract.quiet, "exact_time");
  assert.throws(
    () =>
      f.command("task_manage", {
        action: "delivery",
        id: r.task_id,
        revision: 1,
        delivery_mode: "silent",
      }),
    /暂停/,
  );
  assert.throws(() => f.w.notificationUpdate({ revision: 1 }), /变化/);
  f.s.close();
});
test("research stores artifact then waits for promised delivery before closing", () => {
  const f = fixture();
  const x = f.command("task_manage", {
    action: "create",
    kind: "research",
    title: "整理清单",
    due_at: f.now + MINUTE,
    deliver_at: f.now + 60 * MINUTE,
  });
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal({ notify: { event: "none" } }));
  assert.equal(f.w.task(x.task_id).status, "completed");
  assert.equal(f.w.goal(x.goal_id).status, "active");
  assert.equal(f.s.state().messages.length, 0);
  f.tick(60 * MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.goal(x.goal_id).status, "completed");
  f.s.close();
});
test("research with search permission cannot claim success without real sources", () => {
  const f = fixture();
  f.command("task_manage", {
    action: "create",
    kind: "research",
    title: "搜索新闻",
    allow_search: true,
  });
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal());
  assert.equal(f.w.state().artifacts.length, 0);
  assert.equal(
    (f.s.db.prepare("SELECT status FROM runs WHERE id=?").get(r.id) as any)
      .status,
    "failed",
  );
  f.s.close();
});
test("recurring research completes occurrence but goal and local schedule continue", () => {
  const f = fixture();
  const x = f.command("task_manage", {
    action: "create",
    kind: "research",
    title: "每日简报",
    recurrence: "daily",
    due_at: f.now + MINUTE,
  });
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal({ notify: { event: "none" } }));
  assert.equal(f.w.goal(x.goal_id).status, "active");
  assert.equal(f.w.task(x.task_id).status, "scheduled");
  assert.equal(f.w.task(x.task_id).next_run_at, f.now + DAY);
  f.s.close();
});
test("unknown interrupted work is not replayed and does not block independent reminder", () => {
  const f = fixture();
  f.goal();
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.w.recover();
  assert.equal(
    (
      f.s.db
        .prepare("SELECT status FROM work_runs WHERE run_id=?")
        .get(r.id) as any
    ).status,
    "unknown",
  );
  assert.equal(f.w.claim(), null);
  f.reminder();
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  assert.equal(f.w.state().artifacts.length, 0);
  f.s.close();
});
test("memory revision invalidates worker and stale derived artifact cannot be re-injected", () => {
  const f = fixture();
  const m: any = f.s.saveMemory({ content: "喜欢飞机", kind: "preference" });
  f.goal();
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.s.forget(m.id, 1);
  assert.throws(() => f.w.context(r.id), /失效/);
  f.w.settle(r.id, f.proposal());
  assert.equal(f.w.state().artifacts.length, 0);
  f.s.close();
});
test("task and background run tool boundaries reject unauthorized commands and foreign artifacts", () => {
  const f = fixture();
  const g = f.goal();
  f.tick(MINUTE);
  const r = f.start();
  assert.throws(
    () => f.w.command("goal_manage", { action: "create" }, r.id, "bad"),
    /前台/,
  );
  assert.throws(
    () =>
      f.w.stage(r.id, {
        title: "x",
        body: "x",
        source_urls: ["https://fake.invalid"],
      }),
    /来源/,
  );
  assert.throws(
    () =>
      f.w.stage(r.id, { title: "x", body: "x", source_urls: [], extra: true }),
    /契约/,
  );
  assert.equal(f.w.goal(g.goal_id).status, "active");
  f.s.close();
});
test("goal task dependency scope is enforced and failed predecessor does not execute dependent", () => {
  const f = fixture();
  const a = f.reminder(),
    b = f.goal();
  assert.throws(
    () =>
      f.w.makeTask(
        f.w.goal(b.goal_id),
        {
          title: "依赖",
          kind: "goal_step",
          due_at: f.now + MINUTE,
          dependency_id: a.task_id,
        },
        "goal",
        "test",
      ),
    /依赖/,
  );
  f.s.close();
});
test("cumulative versus increment and correction preserve explicit fact provenance", () => {
  const f = fixture(),
    g = f.goal();
  let r = f.command("goal_progress", {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    fact: "已完成两项",
    progress_mode: "cumulative",
    value: 2,
  });
  f.command("goal_progress", {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    fact: "又完成一项",
    fact_id: r.fact.id,
    progress_mode: "increment",
    value: 1,
  });
  assert.equal(f.w.goal(g.goal_id).facts[0].value, 3);
  assert.throws(() =>
    f.command("goal_progress", {
      goal_id: "unknown",
      goal_revision: 1,
      fact: "完成了",
    }),
  );
  f.s.close();
});

test("front facts must be exact user evidence; model-authored checklists are rejected", () => {
  const f = fixture(),
    g = f.goal();
  const m: any = f.s.enqueue("北京去程票已经订好。", "user-fact", true);
  const r: any = f.s.next();
  f.s.startRun(r.id, "front");
  const args = {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    operation_id: "fact",
    evidence: "北京去程票已经订好。",
    fact: "出发清单：身份证、行李、机场交通已确认",
  };
  assert.throws(
    () => f.w.command("goal_progress", args, r.id, "fact"),
    /原样摘录/,
  );
  assert.equal(f.w.goal(g.goal_id).facts.length, 0);
  f.w.command("goal_progress", { ...args, fact: m.body }, r.id, "fact");
  assert.equal(f.w.goal(g.goal_id).facts[0].source, m.id);
  f.s.close();
});
test("changing a sibling task does not discard a promised pending result", () => {
  const f = fixture(),
    g = f.goal();
  const a = f.command("task_manage", {
    action: "create",
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    kind: "research",
    title: "清单",
    deliver_at: f.now + 5 * MINUTE,
  });
  const b = f.reminder({
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    due_at: f.now + 10 * MINUTE,
  });
  // Directly stage an already completed result candidate to isolate delivery fencing.
  f.w.candidate(
    g.goal_id,
    f.w.task(a.task_id),
    null,
    "task",
    "saved-result",
    "committed",
    "result",
    "已保存清单",
    f.w.task(a.task_id).delivery_contract,
  );
  f.command("task_manage", {
    action: "reschedule",
    id: b.task_id,
    revision: 1,
    due_at: f.now + 20 * MINUTE,
  });
  f.tick(5 * MINUTE);
  f.w.deliver();
  assert.equal(f.s.state().messages.length, 1);
  f.s.close();
});
test("unknown requires explicit reevaluation or task reschedule; history remains unknown", () => {
  const f = fixture(),
    g = f.goal();
  f.tick(MINUTE);
  const r = f.start();
  f.w.recover();
  assert.equal(f.w.claim(), null);
  f.command("goal_manage", {
    action: "reevaluate",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  f.tick(MINUTE);
  assert(f.w.claim());
  assert.equal(
    (f.s.db.prepare("SELECT status FROM runs WHERE id=?").get(r.id) as any)
      .status,
    "unknown",
  );
  f.s.close();
});
test("unsupported schema version refuses startup without destructive changes", () => {
  const f = fixture();
  f.s.setMeta("work_schema_version", "99");
  assert.throws(() => new Work(f.s, f.h), /停止启动/);
  assert.equal(f.s.getMeta("work_schema_version"), "99");
  f.s.close();
});

test("finite daily contract closes only after its final delivered occurrence", () => {
  const f = fixture(),
    r = f.reminder({ recurrence: "daily", ends_at: f.now + MINUTE + DAY });
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.w.goal(r.goal_id).status, "active");
  f.tick(DAY);
  f.w.tick();
  assert.equal(f.w.goal(r.goal_id).status, "completed");
  assert.equal(f.s.state().messages.length, 2);
  f.tick(DAY);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 2);
  f.s.close();
});
test("changed goal facts mark old artifacts historical and exclude them from next context", () => {
  const f = fixture(),
    g = f.goal();
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r);
  f.w.settle(r.id, f.proposal());
  const a = f.w.state().artifacts[0] as any;
  assert.equal(f.w.artifact(a.id).historicalContext, false);
  f.command("goal_progress", {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    fact: "返程改到周一",
  });
  assert.equal(f.w.artifact(a.id).historicalContext, true);
  f.tick(MINUTE);
  const r2 = f.start();
  assert.equal(f.w.context(r2.id).artifact, null);
  f.s.close();
});

test("ambiguous recent-task reference is rejected server-side with zero mutations", () => {
  const f = fixture(),
    a = f.reminder({ title: "带护照" }),
    b = f.reminder({ title: "带充电器" });
  f.s.enqueue("把那个提醒改到十一点。", "ambiguous", true);
  const r: any = f.s.next();
  f.s.startRun(r.id, "s");
  assert.throws(
    () =>
      f.w.command(
        "task_manage",
        {
          action: "reschedule",
          operation_id: "change",
          evidence: "把那个提醒改到十一点。",
          id: b.task_id,
          revision: 1,
          due_at: f.now + 2 * MINUTE,
        },
        r.id,
        "change",
      ),
    /多个可能/,
  );
  assert.equal(f.w.task(b.task_id).revision, 1);
  assert.equal(f.w.task(a.task_id).revision, 1);
  assert.equal(
    f.s.db.prepare("SELECT 1 FROM work_actions WHERE run_id=?").get(r.id),
    undefined,
  );
  f.s.close();
});

test("bounded goal authority expires without cancelling explicitly arranged user reminders", () => {
  const f = fixture();
  const g = f.command("goal_manage", {
    action: "create",
    title: "限时整理",
    autonomous: true,
    support_until: f.now + 2 * MINUTE,
  });
  const u = f.reminder({
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    due_at: f.now + 3 * MINUTE,
  });
  f.tick(2 * MINUTE);
  f.w.tick();
  assert.equal(f.w.goal(g.goal_id).support_enabled, false);
  assert.notEqual(f.w.goal(g.goal_id).status, "completed");
  assert.equal(f.w.task(u.task_id).status, "scheduled");
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 1);
  f.command("goal_manage", {
    action: "resume_support",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
  });
  assert.equal(f.w.goal(g.goal_id).support_enabled, true);
  assert.equal(f.w.goal(g.goal_id).support_until, null);
  f.s.close();
});

test("missed research coalesces recurrence without spending model budget on obsolete news", () => {
  const f = fixture();
  const r = f.command("task_manage", {
    action: "create",
    kind: "research",
    title: "每日科技简报",
    due_at: f.now + MINUTE,
    deliver_at: f.now + 2 * MINUTE,
    recurrence: "daily",
    allow_search: true,
  });
  f.tick(3 * DAY + 4 * 60 * MINUTE);
  assert.equal(f.w.claim(), null);
  assert.equal(f.s.state().runs.length, 0);
  assert(f.w.task(r.task_id).next_run_at > f.now);
  assert.equal(f.w.goal(r.goal_id).status, "active");
  f.w.deliver();
  assert.equal(f.s.state().messages.length, 1);
  f.s.close();
});

test("server resolves local calendar or relative minutes rather than asking model for epoch math", () => {
  const f = fixture();
  const a = f.command("task_manage", {
    action: "create",
    title: "相对提醒",
    kind: "reminder",
    delay_minutes: 2,
  });
  assert.equal(f.w.task(a.task_id).next_run_at, f.now + 2 * MINUTE);
  const b = f.command("task_manage", {
    action: "create",
    title: "本地时刻",
    kind: "reminder",
    due_local: "2026-11-11T09:00",
  });
  assert.equal(
    f.w.task(b.task_id).next_run_at,
    Date.parse("2026-11-11T09:00:00+08:00"),
  );
  assert.throws(
    () =>
      f.command("task_manage", {
        action: "create",
        title: "无效日期",
        kind: "reminder",
        due_local: "2027-02-30T09:00",
      }),
    /无效/,
  );
  f.s.close();
});

test("task completion wake does not postpone an earlier existing goal checkpoint", () => {
  const f = fixture(),
    g = f.goal();
  f.w.unschedule("goal:" + g.goal_id);
  f.w.wake(g.goal_id, f.now + 20 * MINUTE);
  f.w.wake(g.goal_id, f.now + 60 * MINUTE);
  assert.equal(
    (
      f.s.db
        .prepare("SELECT next_at FROM system_tasks WHERE id=?")
        .get("goal:" + g.goal_id) as any
    ).next_at,
    f.now + 20 * MINUTE,
  );
  f.s.close();
});

test("agent-created reminders cannot promote themselves into committed notifications", () => {
  const f = fixture(),
    g = f.goal();
  f.command("goal_manage", {
    action: "notification",
    id: g.goal_id,
    revision: f.w.goal(g.goal_id).revision,
    notification_mode: "silent",
  });
  f.w.makeTask(
    f.w.goal(g.goal_id),
    {
      title: "内部行前检查",
      kind: "reminder",
      due_at: f.now + MINUTE,
      delivery_mode: "result_and_failure",
    },
    "goal",
    "goal-authority",
  );
  f.tick(MINUTE);
  f.w.tick();
  assert.equal(f.s.state().messages.length, 0);
  const c: any = f.s.db.prepare("SELECT * FROM delivery_candidates").get();
  assert.equal(c.obligation, "discretionary");
  assert.equal(c.source, "goal");
  assert.equal(c.status, "suppressed");
  assert.equal(f.w.tasks(g.goal_id)[0].status, "completed");
  f.s.close();
});

test("successive goal drafts share a versioned artifact even when model omits the artifact ID", () => {
  const f = fixture(),
    g = f.goal();
  f.tick(MINUTE);
  const r = f.start();
  f.draft(r, "周日返程的准备清单");
  f.w.settle(r.id, f.proposal());
  f.command("goal_progress", {
    goal_id: g.goal_id,
    goal_revision: f.w.goal(g.goal_id).revision,
    fact: "返程改到周一",
  });
  f.tick(MINUTE);
  const r2 = f.start();
  f.draft(r2, "周一返程的准备清单");
  f.w.settle(r2.id, f.proposal());
  const all = f.w.state().artifacts as any[];
  assert.equal(all.length, 1);
  assert.equal(all[0].version, 2);
  assert.equal(f.w.artifact(all[0].id, 1).historicalContext, true);
  assert.equal(f.w.artifact(all[0].id, 2).historicalContext, false);
  f.s.close();
});
