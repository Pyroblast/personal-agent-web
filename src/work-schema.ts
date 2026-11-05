import { Store, InputError, text } from "./store.js";

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const WORK_MODES = ["task", "goal_step"];
export const GOAL_MODES = [
  "milestones_and_decisions",
  "decisions_only",
  "silent",
];
export const json = (v: any) => JSON.stringify(v);
export const parse = (v: string) => JSON.parse(v);
export function object(v: any, keys: string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new InputError("参数不符合工作契约");
}
export function choice(v: any, choices: string[], fallback?: string) {
  v = v ?? fallback;
  if (!choices.includes(v)) throw new InputError("选项无效");
  return v as string;
}
export function future(v: any, now: number, optional = false) {
  if (optional && (v === undefined || v === null)) return null;
  if (!Number.isSafeInteger(v) || v <= now || v > now + 366 * DAY)
    throw new InputError("请提供未来一年内的准确时间，并确认日期和时区");
  return v as number;
}
export function localFuture(value: any, now: number) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
  )
    throw new InputError("本地时间格式须为 YYYY-MM-DDTHH:mm，使用北京时间");
  const normalized = value.length === 16 ? value + ":00" : value,
    at = Date.parse(normalized + "+08:00");
  if (!Number.isFinite(at) || localTime(at) !== normalized.replace("T", " "))
    throw new InputError("日期或时间无效");
  return future(at, now)!;
}
export function dueTime(a: any, now: number, optional = false) {
  if (
    [a.due_at, a.due_local, a.delay_minutes].filter(
      (x) => x !== undefined && x !== null,
    ).length > 1
  )
    throw new InputError("执行时间只能使用一种表达");
  if (a.due_local !== undefined) return localFuture(a.due_local, now);
  if (a.delay_minutes !== undefined) {
    if (
      !Number.isSafeInteger(a.delay_minutes) ||
      a.delay_minutes < 1 ||
      a.delay_minutes > 525600
    )
      throw new InputError("相对时间须为1至525600分钟");
    return now + a.delay_minutes * MINUTE;
  }
  return optional && a.due_at === undefined
    ? now + 1000
    : future(a.due_at, now)!;
}
export function nextOccurrence(
  at: number,
  recurrence: string,
  after: number,
  endsAt?: number | null,
) {
  if (recurrence === "once") return null;
  const period = recurrence === "weekly" ? 7 * DAY : DAY;
  const next = at + Math.max(1, Math.floor((after - at) / period) + 1) * period;
  return endsAt && next > endsAt ? null : next;
}
export function localTime(at: number) {
  return new Date(at).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}
export function nonempty(v: any, max = 2000) {
  return text(v, max);
}

// Run after Heartbeat's 2.0 schema initialization. Preserve delivery IDs and reply links.
export function migrateDeliveries(store: Store) {
  const columns = store.db
    .prepare("PRAGMA table_info(deliveries)")
    .all() as any[];
  if (columns.some((c) => c.name === "source")) return;
  store.transaction(() => {
    store.db.exec(`CREATE TABLE deliveries_v3(
      id TEXT PRIMARY KEY,run_id TEXT UNIQUE,check_id TEXT UNIQUE,message_id TEXT UNIQUE NOT NULL,
      topic TEXT NOT NULL,body_hash TEXT NOT NULL,created_at INTEGER NOT NULL,replied_at INTEGER,seen_at INTEGER,
      reason TEXT NOT NULL,memory_refs TEXT NOT NULL,feedback_at INTEGER,feedback TEXT,
      source TEXT NOT NULL DEFAULT 'heartbeat',goal_id TEXT,task_id TEXT,event_id TEXT UNIQUE,
      obligation TEXT NOT NULL DEFAULT 'discretionary',
      CHECK(source IN ('heartbeat','goal','task')),
      CHECK(source!='task' OR (goal_id IS NOT NULL AND task_id IS NOT NULL)),
      CHECK(source!='goal' OR goal_id IS NOT NULL));
      INSERT INTO deliveries_v3(id,run_id,check_id,message_id,topic,body_hash,created_at,replied_at,seen_at,reason,memory_refs,feedback_at,feedback)
      SELECT id,run_id,check_id,message_id,topic,body_hash,created_at,replied_at,seen_at,reason,memory_refs,feedback_at,feedback FROM deliveries;
      DROP TABLE deliveries; ALTER TABLE deliveries_v3 RENAME TO deliveries;`);
  });
}
export function migrateWork(store: Store) {
  const version = store.getMeta("work_schema_version");
  if (version && version !== "3")
    throw new Error("不支持的目标数据版本，停止启动以保护数据");
  if (
    !version &&
    store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goals'",
      )
      .get()
  )
    throw new Error("发现未知目标数据结构，停止迁移以保护数据");
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS goals(
        id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('tracking','outcome')),
        status TEXT NOT NULL,execution_policy TEXT NOT NULL,support_enabled INTEGER NOT NULL DEFAULT 0,
        authority_ref TEXT NOT NULL,completion_criteria TEXT NOT NULL,facts TEXT NOT NULL DEFAULT '[]',
        plan TEXT NOT NULL DEFAULT '[]',phase TEXT NOT NULL DEFAULT '',next_action TEXT NOT NULL DEFAULT '',
        wait_condition TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,facts_revision INTEGER NOT NULL DEFAULT 1,
        plan_revision INTEGER NOT NULL DEFAULT 1,notification_mode TEXT NOT NULL DEFAULT 'inherit',
        allow_search INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
        owner TEXT NOT NULL CHECK(owner IN ('user','goal')),kind TEXT NOT NULL CHECK(kind IN ('reminder','research','goal_step')),
        title TEXT NOT NULL,expected_result TEXT NOT NULL,status TEXT NOT NULL,authority_ref TEXT NOT NULL,
        recurrence TEXT NOT NULL CHECK(recurrence IN ('once','daily','weekly')),timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        next_run_at INTEGER,deliver_at INTEGER,late_window INTEGER NOT NULL DEFAULT 7200000,
        revision INTEGER NOT NULL DEFAULT 1,schedule_revision INTEGER NOT NULL DEFAULT 1,
        dependency_id TEXT REFERENCES tasks(id),delivery_contract TEXT NOT NULL,pause_source TEXT,
        allow_search INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_occurrences(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),schedule_revision INTEGER NOT NULL,
        scheduled_for INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',run_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,finished_at INTEGER,UNIQUE(task_id,schedule_revision,scheduled_for));
      CREATE TABLE IF NOT EXISTS work_runs(
        run_id TEXT PRIMARY KEY REFERENCES runs(id),goal_id TEXT NOT NULL REFERENCES goals(id),task_id TEXT REFERENCES tasks(id),
        occurrence_id TEXT REFERENCES task_occurrences(id),snapshot TEXT NOT NULL,status TEXT NOT NULL,
        search_failed INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS goal_events(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),kind TEXT NOT NULL,
        body TEXT NOT NULL,source_message_id TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_actions(run_id TEXT NOT NULL,operation_id TEXT NOT NULL,name TEXT NOT NULL,args TEXT NOT NULL,
        result TEXT NOT NULL,PRIMARY KEY(run_id,operation_id));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS artifact_versions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version INTEGER NOT NULL,body TEXT NOT NULL,sources TEXT NOT NULL,run_id TEXT NOT NULL,context_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,UNIQUE(artifact_id,version));
      CREATE TABLE IF NOT EXISTS artifact_drafts(run_id TEXT PRIMARY KEY,artifact_id TEXT,title TEXT NOT NULL,body TEXT NOT NULL,
        sources TEXT NOT NULL,expected_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS goal_reviews(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),run_id TEXT UNIQUE NOT NULL,
        summary TEXT NOT NULL,next_action TEXT NOT NULL,wait_condition TEXT NOT NULL,artifact_version_id TEXT,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_candidates(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,goal_id TEXT NOT NULL REFERENCES goals(id),
        task_id TEXT REFERENCES tasks(id),run_id TEXT,source TEXT NOT NULL,obligation TEXT NOT NULL,event_type TEXT NOT NULL,
        body TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,goal_revision INTEGER NOT NULL,task_revision INTEGER,
        context_epoch INTEGER NOT NULL,profile_revision INTEGER NOT NULL,eligible_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,decision_reason TEXT NOT NULL DEFAULT '',contract TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_defaults(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,goal_mode TEXT NOT NULL,
        task_mode TEXT NOT NULL,reminder_quiet TEXT NOT NULL);
      INSERT OR IGNORE INTO notification_defaults VALUES(1,1,'milestones_and_decisions','result_and_failure','exact_time');
      CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id);
      CREATE INDEX IF NOT EXISTS candidates_pending ON delivery_candidates(status,eligible_at);
      CREATE INDEX IF NOT EXISTS work_goal ON work_runs(goal_id);`);
    if (
      !(store.db.prepare("PRAGMA table_info(tasks)").all() as any[]).some(
        (x) => x.name === "ends_at",
      )
    )
      store.db.exec("ALTER TABLE tasks ADD COLUMN ends_at INTEGER");
    if (
      !(store.db.prepare("PRAGMA table_info(goals)").all() as any[]).some(
        (x) => x.name === "support_until",
      )
    )
      store.db.exec("ALTER TABLE goals ADD COLUMN support_until INTEGER");
    store.setMeta("work_schema_version", "3");
  });
}
