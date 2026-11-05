import { InputError, Store } from "./store.js";

const DAY = 86400000;
export const historyKinds: Record<string, string[]> = {
  all: [],
  delivered: ["delivered"],
  silent: ["silent"],
  skipped: ["skipped"],
  unfinished: ["failed", "cancelled", "interrupted"],
  running: ["running"],
};
function dateStart(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new InputError("请选择完整日期");
  const n = Date.parse(value + "T00:00:00+08:00");
  if (
    !Number.isFinite(n) ||
    new Date(n + 8 * 3600000).toISOString().slice(0, 10) !== value
  )
    throw new InputError("日期无效");
  return n;
}
export function checkHistory(
  store: Store,
  query: URLSearchParams,
  now = Date.now(),
) {
  const range = query.get("range") || "today",
    kind = query.get("kind") || "all";
  if (
    !["today", "yesterday", "week", "all", "custom"].includes(range) ||
    !Object.hasOwn(historyKinds, kind)
  )
    throw new InputError("筛选条件无效");
  const today = dateStart(
    new Date(now + 8 * 3600000).toISOString().slice(0, 10),
  );
  let from: number | null = null,
    to: number | null = null;
  if (range === "today") {
    from = today;
    to = today + DAY;
  }
  if (range === "yesterday") {
    from = today - DAY;
    to = today;
  }
  if (range === "week") {
    from = today - 6 * DAY;
    to = today + DAY;
  }
  if (range === "custom") {
    from = dateStart(query.get("from") || "");
    to = dateStart(query.get("to") || "") + DAY;
    if (from >= to) throw new InputError("开始日期不能晚于结束日期");
  }
  const limit = Number(query.get("limit") || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new InputError("每页记录数须为 1 至 50");
  const filter = JSON.stringify([range, kind, from, to]);
  let anchor = Number(
    (
      store.db
        .prepare("SELECT COALESCE(MAX(rowid),0) n FROM heartbeat_checks")
        .get() as any
    ).n,
  );
  let cursor: any = null;
  if (query.has("cursor")) {
    const raw = query.get("cursor")!;
    try {
      if (raw.length > 1000) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
      if (cursor.filter !== filter) throw new Error();
      for (const k of ["anchor", "time", "row"])
        if (!Number.isSafeInteger(cursor[k]) || cursor[k] < 0)
          throw new Error();
      if (cursor.anchor > anchor || cursor.row > cursor.anchor)
        throw new Error();
      anchor = cursor.anchor;
    } catch {
      throw new InputError("分页条件已失效，请刷新记录", 409);
    }
  }
  const terms = ["c.rowid<=?"],
    params: (string | number)[] = [anchor];
  if (from !== null) {
    terms.push("c.created_at>=?");
    params.push(from);
  }
  if (to !== null) {
    terms.push("c.created_at<?");
    params.push(to);
  }
  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(historyKinds).map((k) => [k, 0]),
  );
  const groups = store.db
    .prepare(
      `SELECT c.status,COUNT(*) n FROM heartbeat_checks c WHERE ${terms.join(" AND ")} GROUP BY c.status`,
    )
    .all(...params) as any[];
  for (const g of groups) {
    counts.all += g.n;
    for (const [k, values] of Object.entries(historyKinds))
      if (values.includes(g.status)) counts[k] += g.n;
  }
  const statuses = historyKinds[kind];
  if (statuses.length) {
    terms.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const summary = store.db
    .prepare(
      `SELECT COUNT(*) total,COALESCE(SUM(c.run_id IS NOT NULL),0) models,COALESCE(SUM(c.status='delivered'),0) contacts FROM heartbeat_checks c WHERE ${terms.join(" AND ")}`,
    )
    .get(...params) as any;
  if (cursor) {
    terms.push("(c.created_at<? OR (c.created_at=? AND c.rowid<?))");
    params.push(cursor.time, cursor.time, cursor.row);
  }
  const rows = store.db
    .prepare(
      `SELECT c.rowid position,c.id,c.trigger,c.status,c.reason,c.created_at,c.finished_at,c.run_id,r.started_at,r.steps,r.usage,r.web_calls,r.retry_count FROM heartbeat_checks c LEFT JOIN runs r ON r.id=c.run_id WHERE ${terms.join(" AND ")} ORDER BY c.created_at DESC,c.rowid DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as any[];
  const more = rows.length > limit,
    checks = rows.slice(0, limit).map((c) => {
      let usage: any = {};
      try {
        usage = JSON.parse(c.usage || "{}");
      } catch {}
      const total = usage?.totalTokens;
      const modelState = !c.run_id
        ? "none"
        : c.status === "silent" ||
            c.status === "delivered" ||
            (Number.isFinite(total) && total > 0)
          ? "called"
          : c.started_at || c.steps
            ? "started"
            : "queued";
      return {
        ...c,
        modelState,
        totalTokens: Number.isFinite(total) && total >= 0 ? total : null,
        usage: undefined,
      };
    });
  const last = checks.at(-1);
  return {
    checks,
    counts,
    summary,
    from,
    to,
    serverTime: now,
    nextCursor:
      more && last
        ? Buffer.from(
            JSON.stringify({
              filter,
              anchor,
              time: last.created_at,
              row: last.position,
            }),
          ).toString("base64url")
        : null,
  };
}
