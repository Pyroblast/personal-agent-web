import { randomUUID, createHash } from "node:crypto";
import { Store, InputError, text } from "./store.js";
import { Heartbeat, dayStart } from "./heartbeat.js";
import {
  migrateWork,
  MINUTE,
  DAY,
  GOAL_MODES,
  WORK_MODES,
  json,
  parse,
  object,
  choice,
  future,
  nextOccurrence,
  localTime,
  localFuture,
  dueTime,
} from "./work-schema.js";

const hash = (v: any) => createHash("sha256").update(json(v)).digest("hex");
const closed = (s: string) => ["completed", "cancelled"].includes(s);
export class Work {
  modelAvailable = true;
  constructor(
    public store: Store,
    public heartbeat: Heartbeat,
    public now = () => Date.now(),
  ) {
    migrateWork(store);
    this.recover();
  }
  get db() {
    return this.store.db;
  }
  goal(id: string) {
    const g = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as any;
    if (!g) throw new InputError("目标不存在", 404);
    return {
      ...g,
      facts: parse(g.facts),
      plan: parse(g.plan),
      support_enabled: !!g.support_enabled,
      allow_search: !!g.allow_search,
    };
  }
  task(id: string) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    if (!t) throw new InputError("执行安排不存在", 404);
    return {
      ...t,
      delivery_contract: parse(t.delivery_contract),
      allow_search: !!t.allow_search,
    };
  }
  tasks(id: string) {
    return (
      this.db
        .prepare(
          "SELECT id FROM tasks WHERE goal_id=? ORDER BY created_at,rowid",
        )
        .all(id) as any[]
    ).map((t) => this.task(t.id));
  }
  defaults() {
    return this.db
      .prepare("SELECT * FROM notification_defaults WHERE id=1")
      .get() as any;
  }
  state() {
    return {
      goals: (
        this.db
          .prepare("SELECT id FROM goals ORDER BY updated_at DESC,rowid DESC")
          .all() as any[]
      ).map((x) => ({
        ...this.goal(x.id),
        nextCheckAt:
          (
            this.db
              .prepare("SELECT next_at FROM system_tasks WHERE id=?")
              .get("goal:" + x.id) as any
          )?.next_at ?? null,
      })),
      tasks: (
        this.db
          .prepare("SELECT id FROM tasks ORDER BY created_at,rowid")
          .all() as any[]
      ).map((t) => this.task(t.id)),
      events: this.db
        .prepare("SELECT * FROM goal_events ORDER BY created_at DESC LIMIT 300")
        .all(),
      artifacts: this.db
        .prepare(
          "SELECT a.*,v.created_at,v.context_epoch,json_extract(w.snapshot,'$.factsRevision') AS facts_revision FROM artifacts a LEFT JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.version LEFT JOIN work_runs w ON w.run_id=v.run_id ORDER BY v.created_at DESC",
        )
        .all(),
      reviews: this.db
        .prepare(
          "SELECT * FROM goal_reviews ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
      occurrences: this.db
        .prepare(
          "SELECT * FROM task_occurrences ORDER BY scheduled_for DESC LIMIT 200",
        )
        .all(),
      deliveries: this.db
        .prepare(
          "SELECT id,goal_id,task_id,source,status,decision_reason,eligible_at,created_at FROM delivery_candidates ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
      defaults: this.defaults(),
      contactPolicy: this.heartbeat.policy(),
      contextEpoch: Number(this.store.getMeta("context_epoch") || 0),
      actions: this.db
        .prepare("SELECT run_id,name,result FROM work_actions ORDER BY rowid")
        .all(),
    };
  }
  artifact(id: string, version?: number) {
    const row = this.db
      .prepare(
        "SELECT a.goal_id,a.title,v.* FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id WHERE a.id=? AND v.version=COALESCE(?,a.version)",
      )
      .get(id, version ?? null) as any;
    if (!row) throw new InputError("成果尚未保存", 404);
    return {
      ...row,
      sources: parse(row.sources),
      historicalContext:
        row.context_epoch !==
          Number(this.store.getMeta("context_epoch") || 0) ||
        parse(
          (
            this.db
              .prepare("SELECT snapshot FROM work_runs WHERE run_id=?")
              .get(row.run_id) as any
          )?.snapshot || "{}",
        ).factsRevision !== this.goal(row.goal_id).facts_revision,
    };
  }
  event(id: string, kind: string, body: string, source?: string) {
    this.db
      .prepare("INSERT INTO goal_events VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), id, kind, body, source ?? null, this.now());
  }
  schedule(id: string, kind: string, at: number) {
    this.db
      .prepare(
        "INSERT INTO system_tasks(id,kind,next_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,next_at=excluded.next_at",
      )
      .run(id, kind, at);
  }
  unschedule(id: string) {
    this.db.prepare("DELETE FROM system_tasks WHERE id=?").run(id);
  }
  revision(row: any, expected: any) {
    if (!Number.isSafeInteger(expected) || row.revision !== expected)
      throw new InputError("内容已变化，请刷新后重试", 409);
  }
  assertOpen(g: any) {
    if (closed(g.status))
      throw new InputError("这个目标已经结束；若要重新开启，请明确说明", 409);
  }
  makeGoal(a: any, authority: string, kind: string) {
    const id = randomUUID(),
      now = this.now(),
      autonomous = kind === "outcome";
    this.db
      .prepare(
        "INSERT INTO goals(id,title,kind,status,execution_policy,support_enabled,authority_ref,completion_criteria,allow_search,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        text(a.title, 120),
        kind,
        autonomous ? "autonomous" : "contract_only",
        autonomous ? 1 : 0,
        authority,
        text(
          a.completion_criteria ||
            (a.recurrence && a.recurrence !== "once"
              ? a.ends_at
                ? `按约定重复至 ${localTime(a.ends_at)}，最后一次交付后结束`
                : "按约定重复，直到用户明确结束"
              : a.kind === "reminder"
                ? "提醒送达后结束；不推断用户已完成现实行为"
                : "约定成果保存并完成交付后结束"),
          2000,
        ),
        a.allow_search ? 1 : 0,
        now,
        now,
      );
    const until = future(a.support_until, now, true);
    if (until)
      this.db
        .prepare("UPDATE goals SET support_until=? WHERE id=?")
        .run(until, id);
    this.event(
      id,
      "created",
      "已接住这件事",
      authority.startsWith("ui:") ? undefined : authority,
    );
    if (autonomous) this.schedule("goal:" + id, "goal_evaluate", now + MINUTE);
    return this.goal(id);
  }
  makeTask(g: any, a: any, owner: string, authority: string) {
    object(a, [
      "title",
      "kind",
      "expected_result",
      "due_at",
      "due_local",
      "delay_minutes",
      "deliver_at",
      "deliver_local",
      "recurrence",
      "dependency_id",
      "allow_search",
      "delivery_mode",
      "quiet_behavior",
      "late_window",
      "ends_at",
    ]);
    this.assertOpen(g);
    if (
      owner === "goal" &&
      (!g.support_enabled || g.execution_policy !== "autonomous")
    )
      throw new InputError("目标没有自主推进授权", 403);
    const kind = choice(a.kind, ["reminder", "research", "goal_step"]),
      recurrence = choice(a.recurrence, ["once", "daily", "weekly"], "once");
    const due = dueTime(a, this.now(), kind !== "reminder");
    const end = future(a.ends_at, this.now(), true);
    if (end && (recurrence === "once" || end < due))
      throw new InputError(
        "重复安排的结束时间必须覆盖首次执行；单次无需设置重复终点",
      );
    const deliver =
      a.deliver_local !== undefined
        ? localFuture(a.deliver_local, this.now())
        : future(a.deliver_at, this.now(), true);
    if (deliver && deliver < due)
      throw new InputError("交付时间不能早于开始执行时间");
    if (owner === "goal" && recurrence !== "once")
      throw new InputError("内部安排只能是有界单次任务");
    const dep = a.dependency_id ? this.task(a.dependency_id) : null;
    if (dep && (dep.goal_id !== g.id || dep.dependency_id))
      throw new InputError("依赖必须是同目标中的单层任务");
    const mode = choice(
      a.delivery_mode,
      ["result_and_failure", "failure_only", "silent"],
      owner === "goal" ? "silent" : this.defaults().task_mode,
    );
    if (
      kind === "reminder" &&
      a.delivery_mode &&
      a.delivery_mode !== "result_and_failure"
    )
      throw new InputError("提醒不能静默，请改用暂停提醒");
    const quiet = choice(
      a.quiet_behavior,
      ["exact_time", "respect_window"],
      this.defaults().reminder_quiet,
    );
    const late = a.late_window ?? 2 * 60 * MINUTE;
    if (!Number.isSafeInteger(late) || late < MINUTE || late > 7 * DAY)
      throw new InputError("补发宽限须在一分钟至七天之间");
    if (
      owner === "goal" &&
      this.tasks(g.id).filter(
        (t) => t.owner === "goal" && !closed(t.status) && t.status !== "failed",
      ).length >= 8
    )
      throw new InputError("目标的待执行工作已达上限");
    const id = randomUUID(),
      now = this.now();
    const contract = {
      mode: kind === "reminder" ? "result_and_failure" : mode,
      quiet,
      promised: owner === "user",
      deliver_at: deliver,
    };
    const initial = g.status === "paused" ? "paused" : "scheduled";
    this.db
      .prepare(
        "INSERT INTO tasks(id,goal_id,owner,kind,title,expected_result,status,authority_ref,recurrence,next_run_at,deliver_at,late_window,dependency_id,delivery_contract,pause_source,allow_search,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        g.id,
        owner,
        kind,
        text(a.title, 120),
        text(a.expected_result || a.title, 4000),
        initial,
        authority,
        recurrence,
        due,
        deliver,
        late,
        dep?.id ?? null,
        json(contract),
        initial === "paused" ? "goal" : null,
        a.allow_search && (owner === "user" || g.allow_search) ? 1 : 0,
        now,
        now,
      );
    if (end)
      this.db.prepare("UPDATE tasks SET ends_at=? WHERE id=?").run(end, id);
    if (initial === "scheduled") this.schedule("task:" + id, "work_task", due);
    return this.task(id);
  }
  advanceClock(t: any, at: number) {
    const deliver = t.deliver_at ? at + (t.deliver_at - t.next_run_at) : null;
    this.db
      .prepare(
        "UPDATE tasks SET next_run_at=?,deliver_at=?,delivery_contract=? WHERE id=?",
      )
      .run(
        at,
        deliver,
        json({ ...t.delivery_contract, deliver_at: deliver }),
        t.id,
      );
  }
  invalidateGoal(
    id: string,
    reason: string,
    taskId?: string,
    preserveCommitted = false,
  ) {
    this.db
      .prepare(
        "UPDATE delivery_candidates SET status='suppressed',decision_reason=? WHERE goal_id=? AND status='pending'" +
          (taskId
            ? " AND (obligation='discretionary' OR task_id=?)"
            : preserveCommitted
              ? " AND obligation='discretionary'"
              : ""),
      )
      .run(reason, id, ...(taskId ? [taskId] : []));
    const runs = this.db
      .prepare(
        "SELECT run_id FROM work_runs WHERE goal_id=? AND status='running'",
      )
      .all(id) as any[];
    for (const r of runs) this.failed(r.run_id, reason, "cancelled", false);
  }
  updateGoal(id: string, patch: Record<string, any>) {
    const allowed = [
      "title",
      "status",
      "execution_policy",
      "support_enabled",
      "kind",
      "authority_ref",
      "facts",
      "plan",
      "phase",
      "next_action",
      "wait_condition",
      "notification_mode",
      "allow_search",
      "support_until",
    ];
    if (Object.keys(patch).some((k) => !allowed.includes(k)))
      throw new InputError("目标字段无效");
    const fields = Object.keys(patch);
    if (!fields.length) return;
    this.db
      .prepare(
        `UPDATE goals SET ${fields.map((k) => `${k}=?`).join(",")},revision=revision+1,updated_at=? WHERE id=?`,
      )
      .run(
        ...fields.map((k) =>
          ["facts", "plan"].includes(k)
            ? json(patch[k])
            : typeof patch[k] === "boolean"
              ? Number(patch[k])
              : patch[k],
        ),
        this.now(),
        id,
      );
  }
  assertScope(actor: any, target: any, kind: "goal" | "task") {
    if (!actor) return;
    const link = this.db
      .prepare(
        "SELECT d.goal_id,d.task_id FROM message_links l JOIN deliveries d ON d.message_id=l.reply_to WHERE l.message_id=?",
      )
      .get(actor.message_id) as any;
    if (link && (kind === "goal" ? link.goal_id : link.task_id) === target.id)
      return;
    const rows = (
      kind === "goal"
        ? this.db
            .prepare(
              "SELECT id,title FROM goals WHERE status NOT IN ('completed','cancelled')",
            )
            .all()
        : this.db
            .prepare(
              "SELECT id,title FROM tasks WHERE status NOT IN ('completed','cancelled')",
            )
            .all()
    ) as any[];
    if (rows.length <= 1) return;
    // Require an actual distinguishing text anchor; recency alone is not authorization.
    const cleaned = target.title.replace(
      /提醒|目标|任务|安排|今天|明天|每天|每日|本周|一次|进行|持续|跟进|完成|取消|暂停|恢复|\d+/g,
      "",
    );
    const anchors = [
      ...cleaned.matchAll(/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/g),
    ].flatMap((x) =>
      /^[A-Za-z]/.test(x[0])
        ? [x[0]]
        : Array.from({ length: x[0].length - 1 }, (_, i) =>
            x[0].slice(i, i + 2),
          ),
    );
    const distinct = anchors.some(
      (a) =>
        actor.body.includes(a) &&
        !rows.some((r) => r.id !== target.id && r.title.includes(a)),
    );
    if (!distinct)
      throw new InputError(
        "有多个可能的事项，本轮不能根据最近记录猜测归属。请先让用户明确说出事项名称，或回复对应的交付消息。",
        409,
      );
  }
  command(name: string, a: any, runId: string | null, operation: string) {
    return this.store.transaction(() => {
      const actor = runId
        ? (this.db
            .prepare(
              "SELECT r.*,m.body FROM runs r JOIN messages m ON m.id=r.message_id WHERE r.id=? AND r.status='running' AND r.trigger_type='user_message'",
            )
            .get(runId) as any)
        : null;
      if (runId && !actor)
        throw new InputError("只有前台用户可以管理目标", 403);
      object(a, [
        "action",
        "operation_id",
        "evidence",
        "id",
        "revision",
        "goal_id",
        "goal_revision",
        "title",
        "kind",
        "expected_result",
        "due_at",
        "due_local",
        "delay_minutes",
        "deliver_at",
        "deliver_local",
        "recurrence",
        "dependency_id",
        "allow_search",
        "delivery_mode",
        "quiet_behavior",
        "late_window",
        "ends_at",
        "completion_criteria",
        "autonomous",
        "fact",
        "fact_id",
        "progress_mode",
        "value",
        "unit",
        "notification_mode",
        "scope",
        "support_until",
      ]);
      if (typeof operation !== "string" || !operation.trim())
        throw new InputError("缺少操作标识");
      const key = text(a.operation_id || operation, 100),
        scope = runId || "ui";
      const old = this.db
        .prepare("SELECT * FROM work_actions WHERE run_id=? AND operation_id=?")
        .get(scope, key) as any;
      if (old) {
        if (old.name !== name || old.args !== json(a))
          throw new InputError("操作已提交，不能用同一标识更换内容", 409);
        return parse(old.result);
      }
      if (actor) {
        if (!actor.body.includes(text(a.evidence, 2000)))
          throw new InputError("操作必须引用本轮用户原话");
        if (
          /^(假设|假如|举个例子|例如|测试一下你的理解)/.test(
            actor.body.trim(),
          ) &&
          !/实际创建|真的创建|正式创建/.test(actor.body)
        )
          throw new InputError("这是场景讨论，请先确认是否真的创建");
        if (
          (
            this.db
              .prepare("SELECT COUNT(*) n FROM work_actions WHERE run_id=?")
              .get(scope) as any
          ).n >= 8
        )
          throw new InputError("本轮工作变更预算已用尽");
      }
      const authority = actor?.message_id || "ui:" + key;
      let g: any,
        t: any,
        summary = "",
        result: any;
      if (name === "task_manage") {
        if (a.action === "create") {
          g = a.goal_id
            ? this.goal(a.goal_id)
            : this.makeGoal(a, authority, "tracking");
          if (a.goal_id) {
            this.assertScope(actor, g, "goal");
            this.revision(g, a.goal_revision);
          }
          const args = Object.fromEntries(
            [
              "title",
              "kind",
              "expected_result",
              "due_at",
              "due_local",
              "delay_minutes",
              "deliver_at",
              "deliver_local",
              "recurrence",
              "dependency_id",
              "allow_search",
              "delivery_mode",
              "quiet_behavior",
              "late_window",
              "ends_at",
            ]
              .filter((k) => a[k] !== undefined)
              .map((k) => [k, a[k]]),
          );
          t = this.makeTask(g, args, "user", authority);
          summary =
            t.kind === "reminder"
              ? `已安排 ${localTime(t.next_run_at)} 提醒：${t.title}（${t.recurrence === "once" ? "仅一次" : t.recurrence === "daily" ? "每天" : "每周"}）。`
              : `已安排「${t.title}」${t.allow_search ? "，可搜索公开资料" : ""}${t.deliver_at ? `，约定 ${localTime(t.deliver_at)} 交付` : ""}。`;
          this.updateGoal(g.id, { next_action: summary });
          this.event(g.id, "task_created", summary, actor?.message_id);
        } else {
          t = this.task(text(a.id, 100));
          g = this.goal(t.goal_id);
          this.assertScope(actor, t, "task");
          this.revision(t, a.revision);
          this.assertOpen(g);
          if (
            !["pause", "resume", "cancel", "reschedule", "delivery"].includes(
              a.action,
            )
          )
            throw new InputError("任务操作无效");
          this.invalidateGoal(g.id, "执行安排已修改", t.id);
          if (a.action === "reschedule") {
            const at = dueTime(a, this.now()),
              deliver =
                a.deliver_local !== undefined
                  ? localFuture(a.deliver_local, this.now())
                  : future(a.deliver_at, this.now(), true);
            if (deliver && deliver < at)
              throw new InputError("交付时间早于执行时间");
            if (closed(t.status))
              throw new InputError("已结束安排不能直接改期");
            this.db
              .prepare(
                "UPDATE work_runs SET status='acknowledged' WHERE task_id=? AND status='unknown'",
              )
              .run(t.id);
            if (t.ends_at && at > t.ends_at)
              throw new InputError(
                "新的执行时间超过原约定终点，请重新确认重复范围",
              );
            const contract = { ...t.delivery_contract, deliver_at: deliver };
            this.db
              .prepare(
                "UPDATE tasks SET next_run_at=?,deliver_at=?,delivery_contract=?,schedule_revision=schedule_revision+1,revision=revision+1,updated_at=? WHERE id=?",
              )
              .run(at, deliver, json(contract), this.now(), t.id);
            if (t.status !== "paused") {
              this.db
                .prepare("UPDATE tasks SET status='scheduled' WHERE id=?")
                .run(t.id);
              this.schedule("task:" + t.id, "work_task", at);
            }
            summary = `已改到 ${localTime(at)}，原安排已替换。`;
          } else if (a.action === "delivery") {
            const mode = choice(
              a.delivery_mode,
              ["result_and_failure", "failure_only", "silent"],
              t.delivery_contract.mode,
            );
            if (t.kind === "reminder" && mode !== "result_and_failure")
              throw new InputError("请暂停提醒，不能关闭通知后继续提醒");
            const quiet = choice(
              a.quiet_behavior,
              ["exact_time", "respect_window"],
              t.delivery_contract.quiet,
            );
            this.db
              .prepare(
                "UPDATE tasks SET delivery_contract=?,revision=revision+1,updated_at=? WHERE id=?",
              )
              .run(
                json({ ...t.delivery_contract, mode, quiet }),
                this.now(),
                t.id,
              );
            summary = "已更新这项安排的交付约定。";
          } else {
            if (closed(t.status)) throw new InputError("该安排已结束");
            if (
              a.action === "resume" &&
              g.status === "paused" &&
              g.kind !== "tracking"
            )
              throw new InputError("请先恢复整个目标");
            let at = t.next_run_at;
            if (a.action === "resume" && at <= this.now()) {
              at = nextOccurrence(at, t.recurrence, this.now(), t.ends_at);
              if (!at)
                throw new InputError("原时间已过，请明确新的执行时间后再恢复");
            }
            const status =
              a.action === "pause"
                ? "paused"
                : a.action === "cancel"
                  ? "cancelled"
                  : "scheduled";
            this.db
              .prepare(
                "UPDATE tasks SET status=?,pause_source=?,next_run_at=?,revision=revision+1,updated_at=? WHERE id=?",
              )
              .run(
                status,
                a.action === "pause" ? "user" : null,
                at,
                this.now(),
                t.id,
              );
            this.unschedule("task:" + t.id);
            if (status === "scheduled")
              this.schedule("task:" + t.id, "work_task", at);
            summary = {
              pause: "已暂停这项安排。",
              resume: "已恢复这项安排。",
              cancel: "已取消这项安排。",
            }[a.action as "pause"];
          }
          this.event(g.id, "task_changed", summary, actor?.message_id);
          this.reconcile(g.id);
          if (g.kind === "outcome" && g.support_enabled) this.wake(g.id);
        }
        result = {
          goal_id: g.id,
          task_id: t.id,
          summary,
          task: this.task(t.id),
        };
      } else if (name === "goal_manage") {
        if (a.action === "create") {
          if (a.autonomous !== true)
            throw new InputError(
              "持续目标需要明确持续推进授权；具体提醒请使用任务工具",
            );
          if (
            actor &&
            !/持续|跟进|推进|照看|直到|全程|帮我安排|帮我完成|制定.*计划/.test(
              a.evidence,
            )
          )
            throw new InputError("请先确认是否授权持续推进");
          g = this.makeGoal(a, authority, "outcome");
          if (actor)
            this.updateGoal(g.id, {
              facts: [
                {
                  id: randomUUID(),
                  content: actor.body,
                  mode: "fact",
                  value: null,
                  unit: null,
                  source: authority,
                  updated_at: this.now(),
                },
              ],
            });
          summary = `已接住「${g.title}」，将在授权范围内持续整理和推进${g.allow_search ? "，允许搜索公开资料" : ""}；预订、付款和对外发送由你决定。`;
          this.updateGoal(g.id, { next_action: "准备首次评估" });
        } else {
          g = this.goal(text(a.id, 100));
          this.assertScope(actor, g, "goal");
          this.revision(g, a.revision);
          if (a.action === "notification") {
            const mode = choice(a.notification_mode, [
              "inherit",
              ...GOAL_MODES,
            ]);
            this.updateGoal(g.id, { notification_mode: mode });
            this.db
              .prepare(
                "UPDATE delivery_candidates SET status='suppressed',decision_reason='通知设置已修改' WHERE goal_id=? AND obligation='discretionary' AND status='pending'",
              )
              .run(g.id);
            summary = "已更新目标进展通知，执行安排不变。";
          } else if (a.action === "reevaluate") {
            this.assertOpen(g);
            if (
              g.execution_policy !== "autonomous" ||
              !g.support_enabled ||
              g.status === "paused"
            )
              throw new InputError("请先恢复自主推进");
            this.invalidateGoal(g.id, "用户要求重新评估", undefined, true);
            this.db
              .prepare(
                "UPDATE work_runs SET status='acknowledged' WHERE goal_id=? AND status='unknown'",
              )
              .run(g.id);
            this.updateGoal(g.id, {
              status: "active",
              wait_condition: "",
              next_action: "已安排重新评估；未确认的原执行不会重放",
            });
            this.wake(g.id);
            summary =
              "已安排按当前状态重新评估。原任务结果不明的记录保留，需要重新执行时请明确改期。";
          } else if (a.action === "upgrade" || a.action === "reopen") {
            if (
              a.autonomous !== true ||
              (actor && !/持续|跟进|推进|重新|恢复/.test(a.evidence))
            )
              throw new InputError("需要新的持续委托");
            this.invalidateGoal(g.id, "授权已更新", undefined, true);
            this.updateGoal(g.id, {
              kind: "outcome",
              support_until: future(a.support_until, this.now(), true),
              execution_policy: "autonomous",
              support_enabled: true,
              status: "active",
              authority_ref: authority,
              allow_search: !!a.allow_search,
              wait_condition: "",
            });
            this.schedule("goal:" + g.id, "goal_evaluate", this.now() + MINUTE);
            summary = "已更新持续跟进范围，原有历史和提醒约定保留。";
          } else {
            this.assertOpen(g);
            if (
              ![
                "pause",
                "resume",
                "complete",
                "cancel",
                "pause_support",
                "resume_support",
              ].includes(a.action)
            )
              throw new InputError("目标操作无效");
            this.invalidateGoal(
              g.id,
              "目标状态已修改",
              undefined,
              a.action.endsWith("support"),
            );
            if (a.action.endsWith("support")) {
              if (g.execution_policy !== "autonomous")
                throw new InputError("该目标仅执行约定安排，没有自主推进");
              const enabled = a.action === "resume_support";
              this.updateGoal(g.id, {
                support_enabled: enabled,
                ...(enabled
                  ? {
                      authority_ref: authority,
                      support_until: future(a.support_until, this.now(), true),
                    }
                  : {}),
              });
              this.unschedule("goal:" + g.id);
              for (const child of this.tasks(g.id).filter(
                (x) => x.owner === "goal" && !closed(x.status),
              ))
                this.toggleChild(child, enabled, "support");
              if (enabled) this.wake(g.id);
              summary = enabled
                ? "已恢复自主推进。"
                : "已暂停自主推进；用户明确安排的提醒仍保留。";
            } else {
              const status = {
                pause: "paused",
                resume: "active",
                complete: "completed",
                cancel: "cancelled",
              }[a.action as "pause"];
              this.updateGoal(g.id, {
                status,
                wait_condition: "",
                next_action:
                  a.action === "complete"
                    ? "你已确认目标完成"
                    : a.action === "cancel"
                      ? "目标已取消"
                      : "",
              });
              this.unschedule("goal:" + g.id);
              for (const child of this.tasks(g.id).filter(
                (x) => !closed(x.status),
              )) {
                if (closed(status)) {
                  this.db
                    .prepare(
                      "UPDATE tasks SET status='cancelled',revision=revision+1,reason='目标已结束' WHERE id=?",
                    )
                    .run(child.id);
                  this.unschedule("task:" + child.id);
                } else this.toggleChild(child, a.action === "resume", "goal");
              }
              if (a.action === "resume") this.wake(g.id);
              summary = {
                pause: "整个目标已暂停，包括关联的提醒。",
                resume: "已恢复目标；已过期的单次安排需要重新确定时间。",
                complete: "目标已完成，后续安排已停止。",
                cancel: "目标已取消，历史成果保留。",
              }[a.action as "pause"];
            }
          }
          this.event(g.id, a.action, summary, actor?.message_id);
        }
        result = { goal_id: g.id, summary, goal: this.goal(g.id) };
      } else if (name === "goal_progress") {
        g = this.goal(text(a.goal_id, 100));
        this.assertScope(actor, g, "goal");
        this.revision(g, a.goal_revision);
        this.assertOpen(g);
        const mode = choice(
          a.progress_mode,
          ["fact", "increment", "cumulative", "correct"],
          "fact",
        );
        if (actor && !actor.body.includes(text(a.fact, 2000)))
          throw new InputError(
            "事实只能原样摘录本轮用户明确说出的内容，不能把助理清单、推断或建议保存为用户事实。成果请安排研究任务保存。",
          );
        const content = text(a.fact, 2000),
          facts = g.facts as any[];
        const oldFact = a.fact_id
          ? facts.find((f) => f.id === a.fact_id)
          : null;
        if (a.fact_id && !oldFact) throw new InputError("原事实不存在");
        if (
          mode !== "fact" &&
          mode !== "correct" &&
          (typeof a.value !== "number" ||
            !Number.isFinite(a.value) ||
            a.value < 0)
        )
          throw new InputError("进展数值无效");
        if (mode === "increment" && !oldFact)
          throw new InputError("累计进展需明确已有进展项，不能猜测归属");
        this.invalidateGoal(g.id, "用户补充或纠正了目标事实", undefined, true);
        const fact = {
          id: oldFact?.id || randomUUID(),
          content,
          mode,
          value:
            mode === "increment"
              ? (oldFact.value || 0) + a.value
              : (a.value ?? null),
          unit: typeof a.unit === "string" ? a.unit.slice(0, 40) : null,
          source: authority,
          updated_at: this.now(),
        };
        this.updateGoal(g.id, {
          facts: [...facts.filter((f) => f.id !== fact.id), fact],
          wait_condition: "",
          status: g.status === "paused" ? "paused" : "active",
          next_action: "已收到新的信息，按最新情况更新安排",
        });
        this.db
          .prepare(
            "UPDATE goals SET facts_revision=facts_revision+1 WHERE id=?",
          )
          .run(g.id);
        // A changed itinerary invalidates only agent-owned plans. User reminders retain their contract.
        for (const child of this.tasks(g.id).filter(
          (x) => x.owner === "goal" && !closed(x.status),
        )) {
          this.db
            .prepare(
              "UPDATE tasks SET status='cancelled',revision=revision+1,reason='目标事实已变化，等待重新规划' WHERE id=?",
            )
            .run(child.id);
          this.unschedule("task:" + child.id);
        }
        this.wake(g.id);
        summary =
          "已更新目标信息，后续按最新情况推进；你明确设置的提醒不会被擅自改期。";
        this.event(g.id, "progress", content, actor?.message_id);
        result = { goal_id: g.id, summary, fact };
      } else throw new InputError("工作操作不存在");
      this.db
        .prepare("INSERT INTO work_actions VALUES(?,?,?,?,?)")
        .run(scope, key, name, json(a), json(result));
      return result;
    });
  }
  toggleChild(t: any, resume: boolean, source: string) {
    if (resume) {
      if (t.status !== "paused" || t.pause_source !== source) return;
      const g = this.goal(t.goal_id);
      if (t.owner === "goal" && !g.support_enabled) {
        this.db
          .prepare("UPDATE tasks SET pause_source='support' WHERE id=?")
          .run(t.id);
        return;
      }
      let at = t.next_run_at;
      if (at <= this.now())
        at =
          t.owner === "goal"
            ? this.now() + MINUTE
            : nextOccurrence(at, t.recurrence, this.now(), t.ends_at);
      if (!at) {
        this.db
          .prepare(
            "UPDATE tasks SET status='waiting',reason='原时间已过，请重新安排',pause_source=NULL,revision=revision+1 WHERE id=?",
          )
          .run(t.id);
        return;
      }
      this.db
        .prepare(
          "UPDATE tasks SET status='scheduled',next_run_at=?,pause_source=NULL,revision=revision+1 WHERE id=?",
        )
        .run(at, t.id);
      this.schedule("task:" + t.id, "work_task", at);
    } else if (!["paused", "failed"].includes(t.status)) {
      this.db
        .prepare(
          "UPDATE tasks SET status='paused',pause_source=?,revision=revision+1 WHERE id=?",
        )
        .run(source, t.id);
      this.unschedule("task:" + t.id);
    }
  }
  wake(id: string, at = this.now() + MINUTE) {
    const g = this.goal(id);
    if (
      g.execution_policy === "autonomous" &&
      g.support_enabled &&
      !closed(g.status) &&
      g.status !== "paused"
    )
      this.schedule(
        "goal:" + id,
        "goal_evaluate",
        Math.max(
          this.now() + MINUTE,
          Math.min(
            at,
            (
              this.db
                .prepare("SELECT next_at FROM system_tasks WHERE id=?")
                .get("goal:" + id) as any
            )?.next_at ?? at,
          ),
        ),
      );
  }
  reconcile(id: string) {
    const g = this.goal(id);
    if (g.kind !== "tracking" || closed(g.status)) return;
    const ts = this.tasks(id),
      pending = this.db
        .prepare(
          "SELECT id FROM delivery_candidates WHERE goal_id=? AND status='pending' AND obligation='committed'",
        )
        .get(id);
    let status = "active",
      reason = "";
    if (ts.length && ts.every((t) => t.status === "completed") && !pending) {
      status = "completed";
      reason = "约定工作已完成";
    } else if (
      ts.length &&
      ts.every((t) => closed(t.status)) &&
      ts.some((t) => t.status === "cancelled")
    ) {
      status = ts.every((t) => t.status === "cancelled")
        ? "cancelled"
        : "waiting";
      reason = "部分约定已取消，等待你决定是否结束";
    } else if (
      ts.some((t) => !closed(t.status)) &&
      ts.filter((t) => !closed(t.status)).every((t) => t.status === "paused")
    ) {
      status = "paused";
      reason = "安排已暂停";
    } else if (ts.some((t) => ["failed", "waiting"].includes(t.status))) {
      status = "waiting";
      reason = "有安排等待处理，请查看执行记录";
    } else if (pending) reason = "成果已保存，等待交付";
    else reason = ts.find((t) => t.next_run_at)?.title || "";
    this.updateGoal(id, { status, next_action: reason });
  }
  notificationUpdate(a: any) {
    return this.store.transaction(() => {
      object(a, ["revision", "goal_mode", "task_mode", "reminder_quiet"]);
      const d = this.defaults();
      this.revision(d, a.revision);
      const goalMode = choice(a.goal_mode, GOAL_MODES, d.goal_mode),
        taskMode = choice(
          a.task_mode,
          ["result_and_failure", "failure_only", "silent"],
          d.task_mode,
        ),
        quiet = choice(
          a.reminder_quiet,
          ["exact_time", "respect_window"],
          d.reminder_quiet,
        );
      this.db
        .prepare(
          "UPDATE notification_defaults SET revision=revision+1,goal_mode=?,task_mode=?,reminder_quiet=? WHERE id=1",
        )
        .run(goalMode, taskMode, quiet);
      this.db
        .prepare(
          "UPDATE delivery_candidates SET status='suppressed',decision_reason='默认策略已变更' WHERE status='pending' AND obligation='discretionary' AND goal_id IN (SELECT id FROM goals WHERE notification_mode='inherit')",
        )
        .run();
      return {
        ...this.defaults(),
        summary:
          "已保存。目标通知立即生效；提醒和任务结果默认仅影响新安排，旧约定不变。",
      };
    });
  }
  memoryVersion() {
    return hash(
      this.store
        .context(this.now())
        .memories.map((m: any) => [m.id, m.revision, m.expires_at]),
    );
  }
  snapshot(g: any, t: any) {
    const latest = this.db
      .prepare(
        "SELECT id FROM messages WHERE role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as any;
    return {
      goalRevision: g.revision,
      factsRevision: g.facts_revision,
      taskRevision: t?.revision ?? null,
      epoch: Number(this.store.getMeta("context_epoch") || 0),
      memoryVersion: this.memoryVersion(),
      latestUser: latest?.id ?? null,
      profileRevision: JSON.parse(
        (
          this.db
            .prepare("SELECT body FROM agent_profile WHERE id=1")
            .get() as any
        )?.body || '{"revision":1}',
      ).revision,
    };
  }
  valid(w: any) {
    const g = this.goal(w.goal_id),
      snap = parse(w.snapshot),
      t = w.task_id ? this.task(w.task_id) : null;
    if (
      closed(g.status) ||
      g.status === "paused" ||
      g.revision !== snap.goalRevision ||
      g.facts_revision !== snap.factsRevision
    )
      return false;
    if ((!t || t.owner === "goal") && !g.support_enabled) return false;
    if (t && (t.revision !== snap.taskRevision || t.status !== "running"))
      return false;
    if (
      snap.epoch !== Number(this.store.getMeta("context_epoch") || 0) ||
      snap.memoryVersion !== this.memoryVersion()
    )
      return false;
    const latest = this.db
      .prepare(
        "SELECT id FROM messages WHERE role='user' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get() as any;
    return (
      (latest?.id ?? null) === snap.latestUser &&
      parse(
        (
          this.db
            .prepare("SELECT body FROM agent_profile WHERE id=1")
            .get() as any
        ).body,
      ).revision === snap.profileRevision
    );
  }
  chatContext(messageId: string) {
    const linked = this.db
      .prepare(
        "SELECT d.goal_id,d.task_id FROM message_links l JOIN deliveries d ON d.message_id=l.reply_to WHERE l.message_id=?",
      )
      .get(messageId) as any;
    return {
      work: {
        goals: (
          this.db
            .prepare("SELECT id FROM goals ORDER BY updated_at DESC LIMIT 20")
            .all() as any[]
        ).map((x) => {
          const g = this.goal(x.id);
          return { ...g, tasks: this.tasks(g.id).slice(-12) };
        }),
        replyScope: linked || null,
        notificationDefaults: this.defaults(),
      },
      workRules:
        "Task 必须属于 Goal。具体委托用 task_manage 一次创建；独立新事项不挂到最近目标。多个候选先澄清，不能猜测进展归属。目标事实用 goal_progress，不重复保存通用记忆。",
    };
  }
  context(runId: string) {
    const w = this.db
      .prepare("SELECT * FROM work_runs WHERE run_id=? AND status='running'")
      .get(runId) as any;
    if (!w || !this.valid(w)) throw new InputError("工作版本或授权已失效", 409);
    const g = this.goal(w.goal_id),
      t = w.task_id ? this.task(w.task_id) : null;
    const artifact = this.db
      .prepare(
        "SELECT id FROM artifacts WHERE goal_id=? AND version>0 ORDER BY rowid DESC LIMIT 1",
      )
      .get(g.id) as any;
    const a = artifact ? this.artifact(artifact.id) : null;
    let budget = 8000;
    return {
      mode: t?.owner === "user" ? "task" : "goal_step",
      now: this.now(),
      localTime: localTime(this.now()),
      timezone: "Asia/Shanghai",
      goal: g,
      task: t,
      tasks: this.tasks(g.id)
        .filter((x) => !closed(x.status))
        .slice(0, 8),
      reviews: this.db
        .prepare(
          "SELECT summary,next_action,wait_condition,created_at FROM goal_reviews WHERE goal_id=? ORDER BY created_at DESC LIMIT 6",
        )
        .all(g.id),
      artifact: a && !a.historicalContext ? a : null,
      artifactRef: a
        ? {
            id: a.artifact_id,
            title: a.title,
            version: a.version,
            historicalContext: a.historicalContext,
          }
        : null,
      memories: this.store
        .context(this.now())
        .memories.slice(0, 12)
        .filter((m: any) => (budget -= m.content.length) >= 0),
      sourceCatalog: this.db
        .prepare(
          "SELECT url,title,fetched_at FROM sources WHERE run_id=? LIMIT 12",
        )
        .all(runId),
      authority: {
        delegation:
          (
            this.db
              .prepare("SELECT body FROM messages WHERE id=?")
              .get(g.authority_ref) as any
          )?.body || g.completion_criteria,
        allowSearch: t ? t.allow_search : g.allow_search,
        externalActions: false,
        canChangeUserTasks: false,
        maxTaskChanges: 3,
        maxPendingTasks: 8,
      },
      draft:
        this.db
          .prepare(
            "SELECT artifact_id,title,expected_version FROM artifact_drafts WHERE run_id=?",
          )
          .get(runId) || null,
    };
  }
  stage(runId: string, a: any) {
    const c = this.context(runId);
    object(a, [
      "artifact_id",
      "expected_version",
      "title",
      "body",
      "source_urls",
    ]);
    const title = text(a.title, 120),
      body = text(a.body, 20000);
    if (
      !Array.isArray(a.source_urls) ||
      a.source_urls.some((x: any) => typeof x !== "string") ||
      a.source_urls.length > 12
    )
      throw new InputError("成果必须提供来源数组，没有检索时为空数组");
    const known = this.db
      .prepare("SELECT url,title,fetched_at FROM sources WHERE run_id=?")
      .all(runId) as any[];
    if (c.artifact) known.push(...c.artifact.sources);
    if (a.source_urls.some((u: string) => !known.some((x) => x.url === u)))
      throw new InputError("成果包含未核验来源");
    const cited = body.match(/https?:\/\/[^\s)\]<>）。，；]+/g) || [];
    if (cited.some((u) => !a.source_urls.includes(u)))
      throw new InputError("正文链接须包含在真实来源列表中");
    let version = 0,
      artifactId = a.artifact_id;
    if (!artifactId) {
      const existing = this.db
        .prepare(
          "SELECT id,version FROM artifacts WHERE goal_id=? AND task_id IS ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(c.goal.id, c.task?.id ?? null) as any;
      if (existing) {
        artifactId = existing.id;
        version = existing.version;
      }
    }
    if (a.artifact_id) {
      const old = this.db
        .prepare("SELECT * FROM artifacts WHERE id=? AND goal_id=?")
        .get(a.artifact_id, c.goal.id) as any;
      if (!old) throw new InputError("成果不属于本目标", 403);
      version = old.version;
      if (a.expected_version !== version)
        throw new InputError("成果版本已变更", 409);
    }
    this.db
      .prepare(
        "INSERT INTO artifact_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET artifact_id=excluded.artifact_id,title=excluded.title,body=excluded.body,sources=excluded.sources,expected_version=excluded.expected_version",
      )
      .run(
        runId,
        artifactId ?? null,
        title,
        body,
        json(a.source_urls.map((u: string) => known.find((x) => x.url === u))),
        version,
      );
    return {
      staged: true,
      artifact_id: artifactId ?? null,
      expected_version: version,
      title,
      summary: "草稿已暂存，完成结算后才成为正式成果",
    };
  }
  readForRun(runId: string, id: string) {
    const c = this.context(runId),
      a = this.artifact(id);
    if (a.goal_id !== c.goal.id || a.historicalContext)
      throw new InputError("成果不在当前授权或有效上下文内", 403);
    return a;
  }
  budget(g: any) {
    const start = dayStart(this.now()),
      p = this.heartbeat.policy();
    const total = (
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM runs WHERE trigger_type IN ('heartbeat','task','goal_step') AND created_at>=?",
        )
        .get(start) as any
    ).n;
    if (total >= Math.min(28, p.modelDailyLimit))
      return "今日后台模型预算已用尽";
    if (
      g.kind === "outcome" &&
      (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM work_runs w JOIN runs r ON r.id=w.run_id WHERE w.goal_id=? AND r.created_at>=?",
          )
          .get(g.id, start) as any
      ).n >= 4
    )
      return "此目标今日推进预算已用尽";
    return null;
  }
  claim() {
    return this.store.transaction(() => {
      const jobs = this.db
        .prepare(
          "SELECT * FROM system_tasks WHERE kind IN ('goal_evaluate','work_task') AND next_at<=? ORDER BY next_at,id LIMIT 30",
        )
        .all(this.now()) as any[];
      for (const job of jobs) {
        const t = job.kind === "work_task" ? this.task(job.id.slice(5)) : null;
        if (t?.kind === "reminder") continue;
        const g = this.goal(t ? t.goal_id : job.id.slice(5));
        if (
          closed(g.status) ||
          g.status === "paused" ||
          (t && closed(t.status)) ||
          t?.status === "paused" ||
          ((!t || t.owner === "goal") && !g.support_enabled)
        ) {
          this.unschedule(job.id);
          continue;
        }
        if (
          this.db
            .prepare(
              "SELECT 1 FROM work_runs WHERE goal_id=? AND status IN ('running','unknown')",
            )
            .get(g.id)
        )
          continue;
        if (t && this.now() - t.next_run_at > t.late_window) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO task_occurrences(id,task_id,schedule_revision,scheduled_for,status,reason,finished_at) VALUES(?,?,?,?,'expired','超过执行宽限，未补跑过时研究',?)",
            )
            .run(
              randomUUID(),
              t.id,
              t.schedule_revision,
              t.next_run_at,
              this.now(),
            );
          const next = nextOccurrence(
            t.next_run_at,
            t.recurrence,
            this.now(),
            t.ends_at,
          );
          const contract = { ...t.delivery_contract, deliver_at: null };
          this.db
            .prepare(
              "UPDATE tasks SET status=?,next_run_at=?,deliver_at=?,reason='错过本次执行窗口',updated_at=? WHERE id=?",
            )
            .run(
              next ? "scheduled" : "failed",
              next,
              next && t.deliver_at
                ? next + (t.deliver_at - t.next_run_at)
                : null,
              this.now(),
              t.id,
            );
          this.unschedule(job.id);
          if (next) {
            this.advanceClock(t, next);
            this.schedule(job.id, job.kind, next);
          }
          this.event(
            g.id,
            "expired",
            `「${t.title}」错过本次执行窗口，未补跑过时研究。`,
          );
          if (t.owner === "user" && t.delivery_contract.mode !== "silent")
            this.candidate(
              g.id,
              t,
              null,
              "task",
              "expired-" +
                t.id +
                "-" +
                t.schedule_revision +
                "-" +
                t.next_run_at,
              "committed",
              "failure",
              `「${t.title}」错过本次执行窗口，${next ? "下次仍按原时间安排。" : "请重新安排执行时间。"}`,
              contract,
            );
          this.reconcile(g.id);
          continue;
        }
        if (t?.dependency_id) {
          const dep = this.task(t.dependency_id);
          if (dep.status !== "completed") {
            this.db
              .prepare(
                "UPDATE tasks SET status='waiting',reason='等待前置安排完成' WHERE id=?",
              )
              .run(t.id);
            this.schedule(job.id, job.kind, this.now() + MINUTE);
            continue;
          }
        }
        const reason = !this.modelAvailable
          ? "未配置 DeepSeek，等待模型可用"
          : this.budget(g);
        if (reason) {
          this.db
            .prepare("UPDATE goals SET next_action=? WHERE id=?")
            .run(reason, g.id);
          this.schedule(
            job.id,
            job.kind,
            reason.includes("预算")
              ? dayStart(this.now()) + DAY + 8 * 60 * MINUTE
              : this.now() + 5 * MINUTE,
          );
          continue;
        }
        const id = randomUUID();
        let occurrence: any = null;
        if (t) {
          const old = this.db
            .prepare(
              "SELECT * FROM task_occurrences WHERE task_id=? AND schedule_revision=? AND scheduled_for=?",
            )
            .get(t.id, t.schedule_revision, t.next_run_at) as any;
          if (old && ["completed", "expired", "unknown"].includes(old.status)) {
            this.unschedule(job.id);
            continue;
          }
          occurrence = old || { id: randomUUID() };
          if (!old)
            this.db
              .prepare(
                "INSERT INTO task_occurrences(id,task_id,schedule_revision,scheduled_for,status) VALUES(?,?,?,?,'running')",
              )
              .run(occurrence.id, t.id, t.schedule_revision, t.next_run_at);
          this.db
            .prepare(
              "UPDATE task_occurrences SET status='running',run_id=?,attempt=attempt+1 WHERE id=?",
            )
            .run(id, occurrence.id);
          this.db
            .prepare("UPDATE tasks SET status='running',reason='' WHERE id=?")
            .run(t.id);
          t.status = "running";
        }
        const mode = t?.owner === "user" ? "task" : "goal_step";
        this.db
          .prepare(
            "INSERT INTO runs(id,message_id,status,reason,created_at,trigger_type,trigger_id) VALUES(?,NULL,'queued',?,?,?,?)",
          )
          .run(id, "正在推进：" + g.title, this.now(), mode, t?.id || g.id);
        this.db
          .prepare(
            "INSERT INTO work_runs(run_id,goal_id,task_id,occurrence_id,snapshot,status,attempt) VALUES(?,?,?,?,?,'running',?)",
          )
          .run(
            id,
            g.id,
            t?.id ?? null,
            occurrence?.id ?? null,
            json(this.snapshot(g, t)),
            occurrence?.attempt ?? 0,
          );
        this.unschedule(job.id);
        return {
          id,
          trigger_type: mode,
          trigger_id: t?.id || g.id,
          body: "执行当前授权工作。先完成必要检索与成果草稿，最后返回约定 JSON；缺信息则明确等待，不猜测用户现实进展。",
        };
      }
      return null;
    });
  }
  publishArtifact(runId: string, g: any, t: any) {
    const d = this.db
      .prepare("SELECT * FROM artifact_drafts WHERE run_id=?")
      .get(runId) as any;
    if (!d) return null;
    let aid = d.artifact_id;
    if (!aid) {
      aid = randomUUID();
      this.db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?,0)")
        .run(aid, g.id, t?.id ?? null, d.title);
    }
    const a = this.db
      .prepare("SELECT * FROM artifacts WHERE id=?")
      .get(aid) as any;
    if (a.version !== d.expected_version)
      throw new InputError("成果版本冲突", 409);
    const old = a.version ? this.artifact(aid) : null;
    if (old && old.body === d.body && json(old.sources) === d.sources)
      return { id: old.id, artifact_id: aid, changed: false };
    const id = randomUUID(),
      version = a.version + 1;
    this.db
      .prepare("INSERT INTO artifact_versions VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        aid,
        version,
        d.body,
        d.sources,
        runId,
        Number(this.store.getMeta("context_epoch") || 0),
        this.now(),
      );
    this.db
      .prepare("UPDATE artifacts SET title=?,version=? WHERE id=?")
      .run(d.title, version, aid);
    return { id, artifact_id: aid, changed: true };
  }
  settle(runId: string, raw: string) {
    try {
      return this.store.transaction(() => {
        const w = this.db
          .prepare(
            "SELECT * FROM work_runs WHERE run_id=? AND status='running'",
          )
          .get(runId) as any;
        if (!w) return;
        if (!this.valid(w)) {
          this.failed(
            runId,
            "状态或上下文已变化，未发布旧结果",
            "cancelled",
            false,
          );
          return;
        }
        const c = this.context(runId),
          g = c.goal,
          t = c.task;
        const p = JSON.parse(
          raw
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, ""),
        );
        object(p, [
          "status",
          "summary",
          "phase",
          "next_action",
          "wait_condition",
          "next_check_at",
          "task_changes",
          "notify",
        ]);
        const status = choice(p.status, ["done", "waiting"]),
          summary = text(p.summary, 1200),
          next = text(p.next_action, 1000);
        const wait =
          typeof p.wait_condition === "string"
            ? p.wait_condition.trim().slice(0, 1000)
            : "";
        const changes = p.task_changes ?? [];
        if (!Array.isArray(changes) || changes.length > 3)
          throw new InputError("每轮最多三项内部安排变更");
        if (t?.owner === "user" && changes.length)
          throw new InputError("任务执行器不能扩展安排", 403);
        if (w.search_failed && status === "done")
          throw new InputError("检索未完成，不发布研究成功结果");
        if (status === "waiting" && !wait)
          throw new InputError("等待必须说明条件");
        const draft = this.db
          .prepare("SELECT * FROM artifact_drafts WHERE run_id=?")
          .get(runId) as any;
        if (t && status === "done" && !draft)
          throw new InputError("任务完成需要可核验的正式成果");
        if (
          t?.allow_search &&
          status === "done" &&
          (!parse(draft.sources).length ||
            !this.db
              .prepare("SELECT 1 FROM sources WHERE run_id=? LIMIT 1")
              .get(runId))
        )
          throw new InputError("检索任务完成需要真实来源");
        const artifact = this.publishArtifact(runId, g, t);
        let scheduleAt =
          p.next_check_at === undefined || p.next_check_at === null
            ? null
            : future(p.next_check_at, this.now());
        if (scheduleAt)
          scheduleAt = Math.max(scheduleAt, this.now() + 60 * MINUTE);
        if (!t && changes.length === 0 && !scheduleAt && !wait)
          throw new InputError("推进必须留下后继安排或明确等待条件");
        for (const change of changes) {
          object(change, ["action", "id", "revision", "task"]);
          if (change.action === "create")
            this.makeTask(g, change.task, "goal", g.authority_ref);
          else if (["cancel", "reschedule"].includes(change.action)) {
            const child = this.task(change.id);
            this.revision(child, change.revision);
            if (
              child.goal_id !== g.id ||
              child.owner !== "goal" ||
              closed(child.status) ||
              child.id === t?.id
            )
              throw new InputError("只能修改本目标内部未结束的安排", 403);
            if (change.action === "cancel") {
              this.db
                .prepare(
                  "UPDATE tasks SET status='cancelled',revision=revision+1 WHERE id=?",
                )
                .run(child.id);
              this.unschedule("task:" + child.id);
            } else {
              object(change.task, ["due_at"]);
              const at = future(change.task.due_at, this.now())!;
              this.db
                .prepare(
                  "UPDATE tasks SET next_run_at=?,status='scheduled',schedule_revision=schedule_revision+1,revision=revision+1 WHERE id=?",
                )
                .run(at, child.id);
              this.schedule("task:" + child.id, "work_task", at);
            }
          } else throw new InputError("内部安排操作无效");
        }
        if (t) {
          this.db
            .prepare(
              "UPDATE task_occurrences SET status=?,reason=?,finished_at=? WHERE id=?",
            )
            .run(
              status === "done" ? "completed" : "waiting",
              summary,
              this.now(),
              w.occurrence_id,
            );
          const at =
            status === "done"
              ? nextOccurrence(
                  t.next_run_at,
                  t.recurrence,
                  this.now(),
                  t.ends_at,
                )
              : null;
          this.db
            .prepare(
              "UPDATE tasks SET status=?,next_run_at=?,reason=?,updated_at=? WHERE id=?",
            )
            .run(
              status === "waiting" ? "waiting" : at ? "scheduled" : "completed",
              at,
              summary,
              this.now(),
              t.id,
            );
          if (at) {
            // Keep promised clock aligned to the occurrence, never to model completion time.
            const deliver = t.deliver_at
              ? at + (t.deliver_at - t.next_run_at)
              : null;
            this.db
              .prepare(
                "UPDATE tasks SET deliver_at=?,delivery_contract=? WHERE id=?",
              )
              .run(
                deliver,
                json({ ...t.delivery_contract, deliver_at: deliver }),
                t.id,
              );
            this.schedule("task:" + t.id, "work_task", at);
          }
        }
        this.updateGoal(g.id, {
          phase: typeof p.phase === "string" ? p.phase.slice(0, 120) : g.phase,
          next_action: next,
          wait_condition: wait,
          status: status === "waiting" ? "waiting" : "active",
        });
        this.db
          .prepare("UPDATE goals SET plan_revision=plan_revision+1 WHERE id=?")
          .run(g.id);
        if (changes.length)
          this.db.prepare("UPDATE goals SET plan=? WHERE id=?").run(
            json(
              this.tasks(g.id)
                .filter((x) => !closed(x.status))
                .map((x) => ({ id: x.id, title: x.title })),
            ),
            g.id,
          );
        const reviewId = randomUUID();
        this.db
          .prepare("INSERT INTO goal_reviews VALUES(?,?,?,?,?,?,?,?)")
          .run(
            reviewId,
            g.id,
            runId,
            summary,
            next,
            wait,
            artifact?.id ?? null,
            this.now(),
          );
        this.event(g.id, "progress", summary);
        if (g.kind === "outcome") {
          if (scheduleAt) this.wake(g.id, scheduleAt);
          else if (t && status === "done")
            this.wake(g.id, this.now() + 60 * MINUTE);
        }
        let notify = p.notify;
        if (notify !== undefined && notify !== null) {
          object(notify, ["event", "message"]);
          choice(notify.event, ["milestone", "decision", "none"]);
        }
        if (t?.owner === "user") {
          const mode = t.delivery_contract.mode;
          if (
            (status === "done" && mode === "result_and_failure") ||
            (status === "waiting" && mode !== "silent")
          )
            this.candidate(
              g.id,
              t,
              runId,
              "task",
              w.occurrence_id,
              "committed",
              status === "waiting" ? "failure" : "result",
              status === "done" && artifact
                ? summary + "\n\n" + this.artifact(artifact.artifact_id).body
                : summary,
              t.delivery_contract,
            );
        } else if (notify && notify.event !== "none") {
          if (
            notify.event === "milestone" &&
            !artifact?.changed &&
            !changes.length
          )
            throw new InputError("没有新成果或有效安排，不重复发送进展");
          if (notify.event === "decision" && !wait)
            throw new InputError("需要决定的消息必须有等待条件");
          const last = this.db
            .prepare(
              "SELECT r.wait_condition,json_extract(w.snapshot,'$.factsRevision') facts_revision FROM goal_reviews r JOIN work_runs w ON w.run_id=r.run_id WHERE r.goal_id=? AND r.id<>? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1",
            )
            .get(g.id, reviewId) as any;
          if (
            !(
              notify.event === "decision" &&
              last?.wait_condition &&
              (last.wait_condition === wait ||
                (last.facts_revision === g.facts_revision &&
                  !artifact?.changed &&
                  !changes.length))
            )
          )
            this.candidate(
              g.id,
              t,
              runId,
              "goal",
              reviewId,
              "discretionary",
              notify.event,
              text(notify.message, 1200),
              { mode: "result_and_failure", quiet: "respect_window" },
            );
        }
        this.db
          .prepare("UPDATE work_runs SET status='succeeded' WHERE run_id=?")
          .run(runId);
        this.db
          .prepare(
            "UPDATE runs SET status='succeeded',reason=?,result=?,preview='' WHERE id=?",
          )
          .run(
            summary,
            json({ summary, artifact, review_id: reviewId }),
            runId,
          );
        if (g.kind === "tracking") this.reconcile(g.id);
        this.deliver();
        return { summary, artifact };
      });
    } catch (e) {
      this.failed(
        runId,
        e instanceof InputError ? e.message : "模型结果不符合工作契约",
      );
      return null;
    }
  }
  candidate(
    goalId: string,
    t: any,
    runId: string | null,
    source: string,
    eventId: string,
    obligation: string,
    eventType: string,
    body: string,
    contract: any,
  ) {
    const g = this.goal(goalId),
      now = this.now();
    if (obligation === "discretionary")
      this.db
        .prepare(
          "UPDATE delivery_candidates SET status='superseded',decision_reason='已有较新进展' WHERE goal_id=? AND obligation='discretionary' AND status='pending'",
        )
        .run(goalId);
    const profile = (
      this.db.prepare("SELECT body FROM agent_profile WHERE id=1").get() as any
    )?.body;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO delivery_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        eventId,
        goalId,
        t?.id ?? null,
        runId,
        source,
        obligation,
        eventType,
        body,
        eventType === "failure" ? "未能完成约定工作" : "工作进展",
        "pending",
        g.revision,
        t?.revision ?? null,
        Number(this.store.getMeta("context_epoch") || 0),
        profile ? parse(profile).revision : 1,
        Math.max(now, contract.deliver_at || 0),
        Math.max(now, contract.deliver_at || 0) + DAY,
        now,
        "",
        json(contract),
      );
  }
  quietNext(now: number) {
    const p = this.heartbeat.policy(),
      start = dayStart(now),
      hour = (now - start) / (60 * MINUTE);
    if (hour < p.startHour) return start + p.startHour * 60 * MINUTE;
    if (hour >= p.endHour) return start + DAY + p.startHour * 60 * MINUTE;
    return now;
  }
  deliver() {
    this.store.transaction(() => {
      const now = this.now(),
        p = this.heartbeat.policy();
      const rows = this.db
        .prepare(
          "SELECT * FROM delivery_candidates WHERE status='pending' AND eligible_at<=? ORDER BY created_at,rowid",
        )
        .all(now) as any[];
      for (const c of rows) {
        const g = this.goal(c.goal_id),
          t = c.task_id ? this.task(c.task_id) : null,
          contract = parse(c.contract);
        const profile = parse(
          (
            this.db
              .prepare("SELECT body FROM agent_profile WHERE id=1")
              .get() as any
          ).body,
        );
        const resultFactsChanged =
          c.event_type === "result" &&
          c.run_id &&
          parse(
            (
              this.db
                .prepare("SELECT snapshot FROM work_runs WHERE run_id=?")
                .get(c.run_id) as any
            )?.snapshot || "{}",
          ).factsRevision !== g.facts_revision;
        const stale =
          resultFactsChanged ||
          profile.revision !== c.profile_revision ||
          closed(g.status) ||
          g.status === "paused" ||
          (t && ["paused", "cancelled"].includes(t.status)) ||
          (t && t.revision !== c.task_revision) ||
          (c.source === "goal" && g.revision !== c.goal_revision) ||
          Number(this.store.getMeta("context_epoch") || 0) !== c.context_epoch;
        if (stale || c.expires_at < now) {
          this.db
            .prepare(
              "UPDATE delivery_candidates SET status='suppressed',decision_reason=? WHERE id=?",
            )
            .run(stale ? "目标、任务或上下文已变化" : "消息已失去时效", c.id);
          continue;
        }
        let at =
          contract.quiet === "respect_window" ? this.quietNext(now) : now;
        if (c.obligation === "discretionary") {
          const mode =
            g.notification_mode === "inherit"
              ? this.defaults().goal_mode
              : g.notification_mode;
          if (
            mode === "silent" ||
            (mode === "decisions_only" && c.event_type !== "decision")
          ) {
            this.db
              .prepare(
                "UPDATE delivery_candidates SET status='suppressed',decision_reason='进展已静默保存' WHERE id=?",
              )
              .run(c.id);
            continue;
          }
          if (p.pausedUntil && p.pausedUntil > at) at = p.pausedUntil;
          const n = (
            this.db
              .prepare(
                "SELECT COUNT(*) n FROM deliveries WHERE obligation='discretionary' AND created_at>=?",
              )
              .get(dayStart(now)) as any
          ).n;
          const own = (
            this.db
              .prepare(
                "SELECT COUNT(*) n FROM deliveries WHERE goal_id=? AND obligation='discretionary' AND created_at>=?",
              )
              .get(g.id, dayStart(now)) as any
          ).n;
          if (n >= p.dailyLimit || own >= 2)
            at = Math.max(at, dayStart(now) + DAY + p.startHour * 60 * MINUTE);
          const last = this.db
            .prepare(
              "SELECT created_at FROM deliveries WHERE obligation='discretionary' ORDER BY created_at DESC LIMIT 1",
            )
            .get() as any;
          if (last)
            at = Math.max(at, last.created_at + p.minGapMinutes * MINUTE);
        }
        if (at > now) {
          this.db
            .prepare(
              "UPDATE delivery_candidates SET eligible_at=?,decision_reason='等待联系时段或普通消息额度' WHERE id=?",
            )
            .run(at, c.id);
          continue;
        }
        this.publish(
          c.event_id,
          c.body,
          c.source,
          c.goal_id,
          c.task_id,
          c.run_id,
          c.obligation,
          c.reason,
        );
        this.db
          .prepare(
            "UPDATE delivery_candidates SET status='delivered',decision_reason='已进入对话' WHERE id=?",
          )
          .run(c.id);
        this.reconcile(g.id);
      }
    });
  }
  publish(
    event: string,
    body: string,
    source: string,
    goal: string,
    task: string | null,
    run: string | null,
    obligation: string,
    reason: string,
  ) {
    const mid = "work-" + event;
    if (
      this.db.prepare("SELECT id FROM deliveries WHERE event_id=?").get(event)
    )
      return;
    this.db
      .prepare("INSERT INTO messages VALUES(?,?,'assistant',?,'completed',?)")
      .run(mid, mid, body, this.now());
    this.db
      .prepare(
        "INSERT INTO deliveries(id,run_id,check_id,message_id,topic,body_hash,created_at,reason,memory_refs,source,goal_id,task_id,event_id,obligation) VALUES(?,?,NULL,?,?,?,?,?,'[]',?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        run,
        mid,
        "work",
        hash(body),
        this.now(),
        reason,
        source,
        goal,
        task,
        event,
        obligation,
      );
  }
  tick() {
    this.store.expireContext(this.now());
    this.store.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT id FROM goals WHERE support_enabled=1 AND support_until IS NOT NULL AND support_until<=?",
        )
        .all(this.now()) as any[];
      for (const x of expired) {
        this.invalidateGoal(x.id, "自主推进授权已到期", undefined, true);
        this.updateGoal(x.id, {
          support_enabled: false,
          next_action: "约定的自主跟进时间已结束，等待你继续授权",
        });
        this.unschedule("goal:" + x.id);
        for (const t of this.tasks(x.id).filter(
          (t) => t.owner === "goal" && !closed(t.status),
        ))
          this.toggleChild(t, false, "support");
        this.event(
          x.id,
          "authority_expired",
          "自主推进已按约定停止，目标没有被推断为完成",
        );
      }

      const jobs = this.db
        .prepare(
          "SELECT s.* FROM system_tasks s JOIN tasks t ON s.id='task:'||t.id WHERE s.kind='work_task' AND t.kind='reminder' AND s.next_at<=? ORDER BY s.next_at",
        )
        .all(this.now()) as any[];
      for (const job of jobs) {
        const t = this.task(job.id.slice(5)),
          g = this.goal(t.goal_id);
        if (
          closed(g.status) ||
          g.status === "paused" ||
          t.status !== "scheduled"
        ) {
          this.unschedule(job.id);
          continue;
        }
        if (
          t.dependency_id &&
          this.task(t.dependency_id).status !== "completed"
        ) {
          this.schedule(job.id, job.kind, this.now() + MINUTE);
          continue;
        }
        const now = this.now(),
          late = now - t.next_run_at,
          old = this.db
            .prepare(
              "SELECT * FROM task_occurrences WHERE task_id=? AND schedule_revision=? AND scheduled_for=?",
            )
            .get(t.id, t.schedule_revision, t.next_run_at) as any;
        if (old) {
          this.unschedule(job.id);
          continue;
        }
        const at =
          t.delivery_contract.quiet === "respect_window"
            ? this.quietNext(now)
            : now;
        if (at > now && late <= t.late_window) {
          this.schedule(job.id, job.kind, at);
          continue;
        }
        const id = randomUUID(),
          expired = late > t.late_window;
        this.db
          .prepare(
            "INSERT INTO task_occurrences(id,task_id,schedule_revision,scheduled_for,status,reason,finished_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            t.id,
            t.schedule_revision,
            t.next_run_at,
            expired ? "expired" : "completed",
            expired
              ? "超过补发宽限"
              : late > 10000
                ? "恢复后延迟交付"
                : "按约定交付",
            now,
          );
        if (!expired) {
          const body =
            (late > 10000 ? "这条提醒晚到了：" : "") + t.expected_result;
          if (t.owner === "user")
            this.publish(
              id,
              body,
              "task",
              g.id,
              t.id,
              null,
              "committed",
              "你明确安排的提醒",
            );
          else {
            this.candidate(
              g.id,
              t,
              null,
              "goal",
              id,
              "discretionary",
              "milestone",
              body,
              { mode: "result_and_failure", quiet: "respect_window" },
            );
            this.db
              .prepare(
                "UPDATE delivery_candidates SET expires_at=? WHERE event_id=?",
              )
              .run(t.next_run_at + t.late_window, id);
          }
        } else
          this.event(
            g.id,
            "expired",
            `「${t.title}」超过补发期限，未当作准时完成。`,
          );
        const next = nextOccurrence(
          t.next_run_at,
          t.recurrence,
          now,
          t.ends_at,
        );
        this.db
          .prepare(
            "UPDATE tasks SET status=?,next_run_at=?,reason=?,updated_at=? WHERE id=?",
          )
          .run(
            next ? "scheduled" : expired ? "failed" : "completed",
            next,
            expired
              ? "超过补发期限"
              : t.owner === "user"
                ? "已进入对话"
                : "检查已完成，反馈按目标通知设置处理",
            now,
            t.id,
          );
        this.unschedule(job.id);
        if (next) this.schedule(job.id, job.kind, next);
        this.reconcile(g.id);
        if (t.owner === "goal") this.wake(g.id, now + 60 * MINUTE);
      }
      this.deliver();
    });
  }
  failed(runId: string, reason: string, status = "failed", retry = true) {
    this.store.transaction(() => {
      const w = this.db
        .prepare("SELECT * FROM work_runs WHERE run_id=? AND status='running'")
        .get(runId) as any;
      if (!w) return;
      const g = this.goal(w.goal_id),
        t = w.task_id ? this.task(w.task_id) : null;
      this.db
        .prepare("UPDATE work_runs SET status=? WHERE run_id=?")
        .run(status, runId);
      this.store.fail(runId, reason, status);
      this.db
        .prepare(
          "UPDATE runs SET status=?,reason=? WHERE id=? AND status IN ('queued','interrupted')",
        )
        .run(status, reason, runId);
      if (w.occurrence_id)
        this.db
          .prepare(
            "UPDATE task_occurrences SET status=?,reason=?,finished_at=? WHERE id=?",
          )
          .run(status, reason, this.now(), w.occurrence_id);
      if (t) {
        const occurrence = w.occurrence_id
          ? (this.db
              .prepare("SELECT attempt FROM task_occurrences WHERE id=?")
              .get(w.occurrence_id) as any)
          : null;
        const eligible =
          retry &&
          status === "failed" &&
          (occurrence?.attempt || 1) < 2 &&
          !closed(g.status) &&
          g.status !== "paused";
        const next = eligible
          ? this.now() + 15 * MINUTE
          : nextOccurrence(
              t.next_run_at || this.now(),
              t.recurrence,
              this.now(),
              t.ends_at,
            );
        this.db
          .prepare(
            "UPDATE tasks SET status=?,reason=? WHERE id=? AND status='running'",
          )
          .run(
            status === "unknown"
              ? "waiting"
              : next || status === "cancelled"
                ? "scheduled"
                : "failed",
            reason,
            t.id,
          );
        if (next && status !== "unknown") {
          if (!eligible) this.advanceClock(t, next);
          this.schedule("task:" + t.id, "work_task", next);
        } else if (status === "cancelled")
          this.schedule("task:" + t.id, "work_task", this.now() + MINUTE);
        if (
          t.owner === "user" &&
          status === "failed" &&
          t.delivery_contract.mode !== "silent"
        )
          this.candidate(
            g.id,
            t,
            runId,
            "task",
            "failure-" + runId,
            "committed",
            "failure",
            `「${t.title}」暂未完成：${reason}${eligible ? "。会在预算内再尝试一次。" : ""}`,
            { ...t.delivery_contract, deliver_at: null },
          );
      } else if (retry && status === "failed") {
        const previous = this.db
          .prepare(
            "SELECT status FROM work_runs WHERE goal_id=? AND task_id IS NULL AND run_id<>? ORDER BY rowid DESC LIMIT 1",
          )
          .get(g.id, runId) as any;
        if (previous?.status !== "failed")
          this.wake(g.id, this.now() + 60 * MINUTE);
      }
      this.db
        .prepare("UPDATE goals SET next_action=?,wait_condition=? WHERE id=?")
        .run(reason, status === "unknown" ? "执行结果需要核对" : "", g.id);
      this.event(g.id, status, reason);
      this.reconcile(g.id);
    });
  }
  invalidate(reason: string) {
    const rows = this.db
      .prepare("SELECT run_id,goal_id FROM work_runs WHERE status='running'")
      .all() as any[];
    for (const r of rows) {
      this.failed(r.run_id, reason, "cancelled", false);
      this.wake(r.goal_id);
    }
  }
  recover() {
    const rows = this.db
      .prepare("SELECT run_id FROM work_runs WHERE status='running'")
      .all() as any[];
    for (const r of rows)
      this.failed(
        r.run_id,
        "上次执行中断，结果待核对；不会自动重放",
        "unknown",
        false,
      );
  }
}
