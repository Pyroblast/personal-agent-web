import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Heartbeat } from "../src/heartbeat.js";
import { Profile } from "../src/profile.js";
import { Work } from "../src/work.js";
import { ContextService } from "../src/context-service.js";
function fixture() {
  const s = new Store(":memory:");
  const h = new Heartbeat(s);
  new Profile(s);
  const w = new Work(s, h),
    c = new ContextService(s);
  let i = 0;
  const goal = (title = "旅行", autonomous = false) =>
    w.command(
      "goal_manage",
      {
        action: "create",
        title,
        autonomous,
        completion_criteria: "用户确认结束",
      },
      null,
      "g" + ++i,
    ).goal_id;
  const user = (body: string) => {
    const m = s.enqueue(body, "m" + ++i, true) as any;
    const r = s.next();
    s.startRun(r.id, "s" + i);
    return { ...r, message_id: m.id, session: "s" + i };
  };
  const done = (r: any, body = "收到") => s.finish(r.id, body, {});
  return { s, h, w, c, goal, user, done };
}
test("record-only goal has no task or wake and links working state", () => {
  const f = fixture(),
    g = f.goal();
  assert.equal(f.w.goal(g).execution_policy, "record_only");
  assert.equal(f.w.tasks(g).length, 0);
  assert.equal(
    f.s.db.prepare("SELECT * FROM system_tasks WHERE id=?").get("goal:" + g),
    undefined,
  );
  assert.equal(f.c.build(g).matters[0].notificationMode, "silent");
  f.s.close();
});
test("long history retrieval ranks scoped user evidence beyond recent window", () => {
  const f = fixture(),
    g = f.goal("北京艺术区出行"),
    r = f.user("北京主要在798艺术区活动");
  f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: r.body,
      evidence: r.body,
    },
    r.id,
    "fact",
  );
  f.done(r);
  for (let i = 0; i < 60; i++) {
    const r = f.user("其他话题" + i);
    f.done(r);
  }
  assert(
    f.c.search("北京活动区域", g).matches.some((x) => x.text.includes("798")),
  );
  assert(f.c.build(g).userTurns.some((x) => x.text.includes("798")));
  f.s.close();
});
test("correction filters old current evidence but preserves explicit historical record", () => {
  const f = fixture(),
    g = f.goal("北京出行"),
    r = f.user("北京活动在甲区");
  const first = f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: r.body,
      evidence: r.body,
    },
    r.id,
    "f",
  );
  f.done(r);
  const next = f.user("改在乙区活动");
  f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: next.body,
      evidence: next.body,
      progress_mode: "correct",
      fact_id: first.fact.id,
    },
    next.id,
    "f",
  );
  f.done(next);
  assert(!JSON.stringify(f.c.search("北京活动", g)).includes("甲区"));
  assert(
    JSON.stringify(f.c.search("北京活动", g, true).history).includes("甲区"),
  );
  assert(!JSON.stringify(f.c.build(g)).includes("甲区"));
  f.s.close();
});
test("forget filters raw history and derived text without hiding unrelated goals", () => {
  const f = fixture(),
    g = f.goal("北京出行");
  const r = f.user("我通常晚饭后练习吉他");
  const m = f.s.saveMemory({
    content: r.body,
    kind: "preference",
    sourceMessageId: r.message_id,
  }) as any;
  f.done(r);
  f.s.forget(m.id, m.revision);
  assert.equal(f.c.search("吉他").matches.length, 0);
  assert.equal(f.c.build(g).matters.length, 1);
  assert(!f.c.readable(r.message_id, r.body, Date.now() - 1));
  f.s.close();
});
test("natural acceptance binds delivered unique proposal, no fixed authorization phrase", () => {
  const f = fixture(),
    g = f.goal("日本音乐旅行"),
    r = f.user("就计划去日本吧");
  const offer = f.w.offer(r.id, {
    goal_id: g,
    goal_revision: f.w.goal(g).revision,
    evidence: r.body,
    scope: "我可以持续整理这趟行程，有进展再告诉你，直到你确认结束。",
    allow_search: true,
  });
  f.done(r, offer.scope);
  const reply = f.user("可以，就按这个来");
  f.w.command(
    "goal_manage",
    {
      action: "upgrade",
      id: g,
      revision: f.w.goal(g).revision,
      autonomous: true,
      allow_search: true,
      proposal_id: offer.id,
      evidence: reply.body,
    },
    reply.id,
    "accept",
  );
  assert.equal(f.w.goal(g).support_enabled, true);
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM delegation_proposals WHERE id=?")
      .get(offer.id)?.status,
    "accepted",
  );
  f.s.close();
});
test("undelivered offer, changed goal, denial and ambiguity do not grant authority", () => {
  for (const kind of ["undelivered", "changed", "denial", "multiple"]) {
    const f = fixture(),
      g = f.goal(),
      r = f.user("帮我考虑一下");
    const offer = f.w.offer(r.id, {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      evidence: r.body,
      scope: "持续跟进到你确认结束，有进展联系。",
      allow_search: false,
    });
    f.done(r, kind === "undelivered" ? "收到" : offer.scope);
    if (kind === "changed")
      f.w.command(
        "goal_manage",
        {
          action: "notification",
          id: g,
          revision: f.w.goal(g).revision,
          notification_mode: "silent",
        },
        null,
        "n",
      );
    if (kind === "multiple") {
      const other = f.goal("学习"),
        u = f.user("也考虑学习");
      const o = f.w.offer(u.id, {
        goal_id: other,
        goal_revision: f.w.goal(other).revision,
        evidence: u.body,
        scope: "持续跟进学习，有进展联系。",
      });
      f.done(u, o.scope);
    }
    const u = f.user(kind === "denial" ? "不，就先记着" : "可以");
    assert.throws(() =>
      f.w.command(
        "goal_manage",
        {
          action: "upgrade",
          id: g,
          revision: f.w.goal(g).revision,
          autonomous: true,
          allow_search: false,
          proposal_id: offer.id,
          evidence: u.body,
        },
        u.id,
        "a",
      ),
    );
    assert(!f.w.goal(g).support_enabled);
    f.s.close();
  }
});
test("lightweight matter becomes goal without duplicate plan and user selection is not execution", () => {
  const f = fixture(),
    r = f.user("我想比较两个方案，先选方案A");
  const a = f.c.action(r.id, {
    action: "matter",
    title: "方案比较",
    evidence: r.body,
    operation_id: "m",
  });
  const m = f.c.action(r.id, {
    action: "item",
    matter_id: a.matter.id,
    revision: a.matter.revision,
    label: "先选方案A",
    decision: "selected",
    owner: "user",
    evidence: r.body,
    operation_id: "item",
  });
  const g = f.w.command(
    "goal_manage",
    {
      action: "create",
      title: "方案比较",
      autonomous: false,
      matter_id: m.matter.id,
      evidence: r.body,
    },
    r.id,
    "g",
  );
  const view = f.c.build(g.goal_id).working[0];
  assert.equal(view.id, m.matter.id);
  assert.equal(view.items[0].executionState, "not_verified");
  assert.equal(f.w.tasks(g.goal_id).length, 0);
  f.s.close();
});
test("shared question only delivered once, answered and paused stay closed", () => {
  const f = fixture(),
    g = f.goal(),
    q = f.c.question(g, "住宿", "酒店选好了吗？");
  assert(f.c.questionAllowed(q.id, g));
  f.c.deliveredQuestion(q.id);
  assert(!f.c.questionAllowed(q.id, g));
  assert.equal(f.c.question(g, "住宿", "住宿定了吗？").id, q.id);
  const r = f.user("住宿已经安排好了"),
    m = f.c.matter(g);
  f.c.action(r.id, {
    action: "answer",
    goal_id: g,
    revision: m.revision,
    id: q.id,
    evidence: r.body,
    operation_id: "answer",
  });
  assert(!f.c.questionAllowed(q.id, g));
  assert.equal(f.c.view(f.c.matter(g)).questions[0].status, "answered");
  f.s.close();
});
test("execution and commit guards reject newly received input before extraction", () => {
  const f = fixture(),
    g = f.goal();
  f.c.capture("run", g);
  assert(f.c.check("run", "execution"));
  f.user("改成下周");
  assert(!f.c.check("run", "execution"));
  assert(!f.c.check("run", "commit"));
  f.s.close();
});
test("delayed candidate is suppressed after answer, deterministic reminder survives unrelated epoch", () => {
  const f = fixture(),
    g = f.goal("出行", true);
  f.w.candidate(
    g,
    null,
    null,
    "goal",
    "event",
    "discretionary",
    "decision",
    "住哪？",
    { quiet: "exact_time" },
  );
  const r = f.user("住处安排好了");
  f.done(r);
  f.w.deliver();
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM delivery_candidates WHERE event_id=?")
      .get("event")?.status,
    "suppressed",
  );
  const t = f.w.command(
    "task_manage",
    {
      action: "create",
      kind: "reminder",
      title: "喝水",
      due_at: Date.now() + 60000,
    },
    null,
    "task",
  );
  f.w.candidate(
    t.goal_id,
    f.w.task(t.task_id),
    null,
    "task",
    "reminder",
    "committed",
    "reminder",
    "喝水",
    { quiet: "exact_time" },
  );
  f.s.invalidateContext(Date.now());
  f.w.deliver();
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM delivery_candidates WHERE event_id=?")
      .get("reminder")?.status,
    "delivered",
  );
  f.s.close();
});

test("contact limit counts goal and care together, committed reminders exempt", () => {
  const f = fixture(),
    g = f.goal("学习", true);
  f.w.command(
    "goal_manage",
    {
      action: "notification",
      id: g,
      revision: f.w.goal(g).revision,
      notification_mode: "milestones_and_decisions",
      contact_limit: { count: 1, days: 7 },
    },
    null,
    "limit",
  );
  assert.equal(f.c.contactLimit(g), null);
  f.w.publish(
    "progress",
    "新的进度",
    "goal",
    g,
    null,
    null,
    "discretionary",
    "实际进度",
  );
  assert(f.c.contactLimit(g));
  f.w.publish(
    "reminder",
    "明确提醒",
    "task",
    g,
    "synthetic-task",
    null,
    "committed",
    "用户约定",
  );
  assert.equal(f.s.state().messages.length, 2);
  f.s.close();
});
test("queued cancellation fences due reminder before its direct publish path", () => {
  const f = fixture();
  const t = f.w.command(
    "task_manage",
    {
      action: "create",
      kind: "reminder",
      title: "喝水",
      due_at: Date.now() + 60000,
    },
    null,
    "r",
  );
  f.user("取消喝水提醒");
  f.w.now = () => Date.now() + 61000;
  f.w.tick();
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM deliveries").get()?.n, 0);
  assert.equal(f.w.task(t.task_id).status, "scheduled");
  f.s.close();
});
test("plan branches preserve unrelated decisions and task evidence cannot cross goals", () => {
  const f = fixture(),
    g = f.goal("旅行"),
    other = f.goal("学习");
  const r = f.user("选方案A，方案B待定"),
    m = f.c.matter(g);
  const a = f.c.action(r.id, {
    action: "item",
    goal_id: g,
    revision: m.revision,
    label: "选方案A",
    decision: "selected",
    branch: "A",
    evidence: r.body,
    operation_id: "a",
  });
  const b = f.c.action(r.id, {
    action: "item",
    goal_id: g,
    revision: a.matter.revision,
    label: "方案B待定",
    decision: "proposed",
    branch: "B",
    evidence: r.body,
    operation_id: "b",
  });
  assert.equal(b.matter.items.length, 2);
  assert.equal(
    b.matter.items.find((x) => x.branch === "A")?.decision,
    "selected",
  );
  assert.throws(() =>
    f.c.action(r.id, {
      action: "item",
      goal_id: g,
      revision: b.matter.revision,
      label: "选方案A",
      task_id: "absent",
      evidence: r.body,
      operation_id: "wrong",
    }),
  );
  f.s.close();
});

test("indexed Chinese history survives beyond fallback window and excludes forgotten evidence", () => {
  const f = fixture();
  const r = f.user("我在798艺术区附近活动");
  f.done(r);
  for (let i = 0; i < 2100; i++)
    f.s.db
      .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)")
      .run(
        "bulk" + i,
        "bulk" + i,
        "user",
        "无关消息" + i,
        "completed",
        Date.now() + i + 1,
      );
  while (f.c.search("798").coverage.indexPending) f.c.indexPending(128);
  assert(f.c.search("798艺术区").matches.some((x) => x.text === r.body));
  f.c.exclude(r.message_id, "forgotten");
  assert(!f.c.search("798艺术区").matches.some((x) => x.text === r.body));
  f.s.close();
});
test("expired memory retires original history source, not unrelated facts", () => {
  const f = fixture(),
    r = f.user("临时取件码是7788");
  f.s.saveMemory({
    kind: "fact",
    content: r.body,
    sourceMessageId: r.message_id,
    expiresAt: Date.now() + 1000,
  });
  f.done(r);
  f.s.expireContext(Date.now() + 2000);
  assert.equal(f.c.search("取件码7788").matches.length, 0);
  f.s.close();
});
test("actually displayed front question is shared as already delivered", () => {
  const f = fixture(),
    g = f.goal("北京行程"),
    r = f.user("帮我确认北京住宿还有什么缺口");
  const result = f.c.action(r.id, {
    operation_id: "q",
    action: "question",
    goal_id: g,
    revision: f.c.matter(g).revision,
    semantic_key: "hotel",
    question: "北京住宿安排好了吗？",
    evidence: r.body,
  });
  const q = result.matter.questions[0];
  f.done(r, "北京住宿安排好了吗？");
  assert(!f.c.questionAllowed(q.id, g));
  f.s.close();
});

test("correcting one fact preserves unrelated internal task and explicit reminders", () => {
  const f = fixture(),
    g = f.goal("北京旅行", true);
  const a = f.w.command(
    "goal_progress",
    { goal_id: g, goal_revision: f.w.goal(g).revision, fact: "方案A住甲区" },
    null,
    "a",
  ).fact;
  const b = f.w.command(
    "goal_progress",
    { goal_id: g, goal_revision: f.w.goal(g).revision, fact: "方案B看展" },
    null,
    "b",
  ).fact;
  const tA = f.w.makeTask(
    f.w.goal(g),
    {
      title: "甲区研究",
      kind: "research",
      due_at: Date.now() + 60000,
      fact_ids: [a.id],
    },
    "goal",
    "ui:test",
  );
  const tB = f.w.makeTask(
    f.w.goal(g),
    {
      title: "展览研究",
      kind: "research",
      due_at: Date.now() + 60000,
      fact_ids: [b.id],
    },
    "goal",
    "ui:test",
  );
  f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: "方案A改住乙区",
      progress_mode: "correct",
      fact_id: a.id,
    },
    null,
    "correct",
  );
  assert.equal(f.w.task(tA.id).status, "cancelled");
  assert.equal(f.w.task(tB.id).status, "scheduled");
  f.s.close();
});
test("plan dependency cycle is rejected without mutation", () => {
  const f = fixture(),
    g = f.goal(),
    r = f.user("第一步 第二步");
  const add = (args: any) =>
    f.c.action(r.id, {
      action: "item",
      goal_id: g,
      revision: f.c.matter(g).revision,
      evidence: r.body,
      ...args,
    });
  const one = add({ operation_id: "1", label: "第一步" }).matter.items[0];
  const two = add({
    operation_id: "2",
    label: "第二步",
    dependencies: [one.id],
  }).matter.items.find((x: any) => x.label === "第二步");
  assert.throws(
    () =>
      add({
        operation_id: "3",
        id: one.id,
        label: "第一步",
        dependencies: [two.id],
      }),
    /循环/,
  );
  f.s.close();
});

test("derived goal plan cannot revive a forgotten fact after unrelated state updates", () => {
  const f = fixture(),
    g = f.goal("周末行程");
  const r = f.user("我的临时住址是海港艺术村778号");
  const mem = f.s.saveMemory({
    kind: "fact",
    content: r.body,
    sourceMessageId: r.message_id,
  });
  f.done(r);
  f.w.updateGoal(g, { next_action: "到海港艺术村778号取包裹" });
  f.s.forget(mem.id, mem.revision);
  f.w.updateGoal(g, { wait_condition: "等待用户决定" });
  assert(!JSON.stringify(f.c.build(g)).includes("海港艺术村778号"));
  f.s.close();
});

test("goal creation explicitly preserves or separates an existing discussion matter", () => {
  const f = fixture(),
    r = f.user("讨论东京旅行，先保留这个事项");
  const m = f.c.action(r.id, {
    action: "matter",
    operation_id: "matter",
    evidence: r.body,
    title: "东京旅行",
  }).matter;
  f.done(r);
  const next = f.user("把东京旅行记成目标，沿用刚才讨论");
  const args = {
    action: "create",
    title: "东京旅行",
    autonomous: false,
    completion_criteria: "用户确认结束",
    evidence: next.body,
  };
  assert.throws(
    () => f.w.command("goal_manage", args, next.id, "create"),
    /未关联/,
  );
  assert.equal(f.w.state().goals.length, 0);
  const out = f.w.command(
    "goal_manage",
    { ...args, matter_id: m.id },
    next.id,
    "create",
  );
  assert.equal(f.c.matter(out.goal_id).id, m.id);
  f.s.close();
});

test("goal tool identity aliases bind to the same target and reject conflicts", () => {
  const f = fixture(),
    g = f.goal("旅行");
  f.w.command(
    "goal_manage",
    { action: "pause", goal_id: g, goal_revision: f.w.goal(g).revision },
    null,
    "pause",
  );
  assert.equal(f.w.goal(g).status, "paused");
  assert.throws(
    () =>
      f.w.command(
        "goal_manage",
        {
          action: "resume",
          id: g,
          goal_id: "other",
          revision: f.w.goal(g).revision,
        },
        null,
        "bad",
      ),
    /标识冲突/,
  );
  assert.throws(
    () =>
      f.w.command(
        "goal_manage",
        { action: "resume", id: g, revision: 1, goal_revision: 2 },
        null,
        "bad2",
      ),
    /版本冲突/,
  );
  f.s.close();
});

test("partial correction preserves untouched original evidence without reviving superseded history", () => {
  const f = fixture(),
    g = f.goal("北京行程"),
    r = f.user("北京主要在798活动，周五去、周日回。");
  const old = f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: r.body,
      evidence: r.body,
    },
    r.id,
    "old",
  ).fact;
  f.done(r);
  const u = f.user("返程改周一晚");
  assert.throws(
    () =>
      f.w.command(
        "goal_progress",
        {
          goal_id: g,
          goal_revision: f.w.goal(g).revision,
          fact: u.body,
          evidence: u.body,
          fact_id: old.id,
          progress_mode: "correct",
        },
        u.id,
        "bad",
      ),
    /replace_span/,
  );
  assert.equal(f.w.goal(g).facts[0].content, r.body);
  const x = f.w.command(
    "goal_progress",
    {
      goal_id: g,
      goal_revision: f.w.goal(g).revision,
      fact: u.body,
      evidence: u.body,
      fact_id: old.id,
      progress_mode: "correct",
      replace_span: "周日回",
    },
    u.id,
    "good",
  );
  const facts = f.c.facts(f.w.goal(g));
  assert.equal(facts.length, 2);
  assert(
    facts.some((x) => x.content.includes("798") && x.content.includes("周五")),
  );
  assert(!facts.some((x) => x.content.includes("周日回")));
  assert.equal(x.retained_fact.source, r.message_id);
  assert.equal(x.retained_fact.updated_at, old.updated_at);
  assert.equal(f.c.source(r.message_id), null); // raw obsolete compound cannot leak back via search
  f.c.exclude(r.message_id, "forgotten");
  assert.equal(f.c.facts(f.w.goal(g)).length, 1);
  assert.throws(
    () =>
      f.w.command(
        "goal_progress",
        {
          goal_id: g,
          goal_revision: f.w.goal(g).revision,
          fact: u.body,
          evidence: u.body,
          fact_id: x.retained_fact.id,
          replace_span: "798",
        },
        u.id,
        "revive",
      ),
    /已失效/,
  );
  f.s.close();
});
