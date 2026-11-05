import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Heartbeat } from "../src/heartbeat.js";
import { checkHistory } from "../src/check-history.js";
import { createApp } from "../src/server.js";
const day = Date.parse("2026-11-04T00:00:00+08:00"),
  now = day + 12 * 3600000;
function fixture() {
  const s = new Store(":memory:");
  new Heartbeat(s);
  const add = (id: string, at: number, status = "skipped", run: any = null) => {
    if (run)
      s.db
        .prepare(
          "INSERT INTO runs(id,status,reason,created_at,trigger_type,started_at,steps,usage) VALUES(?,'succeeded','test',?,'heartbeat',?,?,?)",
        )
        .run(id, at, run.started || 0, run.steps || 0, run.usage || "{}");
    s.db
      .prepare(
        "INSERT INTO heartbeat_checks(id,occurrence,trigger,status,reason,created_at,run_id) VALUES(?,?,'auto',?,'synthetic',?,?)",
      )
      .run(id, id, status, at, run ? id : null);
  };
  return {
    s,
    add,
    get: (q = "") => checkHistory(s, new URLSearchParams(q), now),
  };
}
test("history crosses the old 50-row limit, uses full-range counts, and reads without mutation", () => {
  const f = fixture();
  for (let i = 0; i < 123; i++)
    f.add("c" + i, day + i, "silent", {
      started: day,
      usage: '{"totalTokens":10}',
    });
  const before = f.s.db.prepare("SELECT * FROM heartbeat_checks").all();
  let r = f.get("range=all"),
    ids = r.checks.map((c) => c.id);
  assert.equal(r.summary.total, 123);
  assert.equal(r.counts.silent, 123);
  while (r.nextCursor) {
    r = f.get("range=all&cursor=" + r.nextCursor);
    ids.push(...r.checks.map((c) => c.id));
  }
  assert.equal(ids.length, 123);
  assert.equal(new Set(ids).size, 123);
  assert.deepEqual(
    f.s.db.prepare("SELECT * FROM heartbeat_checks").all(),
    before,
  );
  f.s.close();
});
test("Beijing calendar boundaries are inclusive through custom end date and last seven calendar days", () => {
  const f = fixture();
  f.add("before", day - 1);
  f.add("start", day);
  f.add("end", day + 86400000 - 1);
  f.add("after", day + 86400000);
  f.add("week", day - 6 * 86400000);
  f.add("outside", day - 6 * 86400000 - 1);
  assert.deepEqual(
    f.get().checks.map((c) => c.id),
    ["end", "start"],
  );
  assert.deepEqual(
    f.get("range=yesterday").checks.map((c) => c.id),
    ["before"],
  );
  assert.equal(f.get("range=week").summary.total, 4);
  assert.deepEqual(
    f.get("range=custom&from=2026-11-04&to=2026-11-04").checks.map((c) => c.id),
    ["end", "start"],
  );
  f.s.close();
});
test("unfinished groups failure/cancellation/interruption, never silence; skip may have a model run", () => {
  const f = fixture();
  for (const status of [
    "failed",
    "cancelled",
    "interrupted",
    "silent",
    "delivered",
    "running",
    "skipped",
  ])
    f.add(
      status,
      day,
      status,
      status === "skipped" ? { started: day, steps: 1 } : null,
    );
  const r = f.get("kind=unfinished");
  assert.equal(r.summary.total, 3);
  assert.deepEqual(
    new Set(r.checks.map((c) => c.status)),
    new Set(["failed", "cancelled", "interrupted"]),
  );
  assert.equal(r.counts.all, 7);
  assert.equal(r.counts.silent, 1);
  assert.equal(f.get("kind=skipped").summary.models, 1);
  f.s.close();
});
test("pagination remains stable with equal timestamps and newly inserted checks", () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.add("c" + i, day);
  const first = f.get("limit=2");
  f.add("new", day + 1);
  let second = f.get("limit=2&cursor=" + first.nextCursor);
  assert.equal(second.summary.total, 5);
  const ids = [
    ...first.checks,
    ...second.checks,
    ...f.get("limit=2&cursor=" + second.nextCursor).checks,
  ].map((c) => c.id);
  assert.deepEqual(ids, ["c4", "c3", "c2", "c1", "c0"]);
  assert.equal(f.get().checks[0].id, "new");
  f.s.close();
});
test("invalid dates, reversed ranges, injection, limits and crossed-filter cursors fail explicitly", () => {
  const f = fixture();
  f.add("a", day);
  f.add("b", day);
  const cursor = f.get("limit=1").nextCursor;
  for (const q of [
    "range=no",
    "kind=toString",
    "kind=skipped%27",
    "range=custom",
    "range=custom&from=2026-02-30&to=2026-03-04",
    "range=custom&from=2026-11-05&to=2026-11-04",
    "limit=-1",
    "limit=999",
    "limit=1.5",
    "cursor=garbage",
    "kind=silent&cursor=" + cursor,
  ])
    assert.throws(() => f.get(q));
  assert.throws(
    () =>
      checkHistory(
        f.s,
        new URLSearchParams("limit=1&cursor=" + cursor),
        now + 86400000,
      ),
    /刷新/,
  );
  f.s.close();
});
test("model participation and missing usage are not manufactured from a run ID", () => {
  const f = fixture();
  f.add("none", day);
  f.add("queued", day, "cancelled", {});
  f.add("started", day, "failed", { started: day });
  f.add("called", day, "skipped", { usage: '{"totalTokens":123}' });
  f.add("bad", day, "failed", { started: day, usage: "bad" });
  const rows = Object.fromEntries(f.get().checks.map((c) => [c.id, c]));
  assert.equal(rows.none.modelState, "none");
  assert.equal(rows.queued.modelState, "queued");
  assert.equal(rows.started.modelState, "started");
  assert.equal(rows.called.modelState, "called");
  assert.equal(rows.bad.totalTokens, null);
  assert.equal(rows.called.totalTokens, 123);
  f.s.close();
});
test("history endpoint requires browser auth and same origin, supports real persisted records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-history-")),
    app = createApp(dir);
  try {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const address = app.server.address() as any,
      url = "http://127.0.0.1:" + address.port;
    const token = readFileSync(join(dir, "access-token"), "utf8"),
      headers = { authorization: "Bearer " + token };
    app.store.db
      .prepare(
        "INSERT INTO heartbeat_checks(id,occurrence,trigger,status,reason,created_at) VALUES('old','old','auto','skipped','synthetic',?)",
      )
      .run(day - 100 * 86400000);
    assert.equal((await fetch(url + "/api/heartbeat/history")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/heartbeat/history", {
          headers: { ...headers, origin: "http://other" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/api/heartbeat/history?range=all", { headers }))
        .status,
      200,
    );
    const result = await (
      await fetch(url + "/api/heartbeat/history?range=all", { headers })
    ).json();
    assert.equal(result.summary.total, 1);
    assert.equal(result.checks[0].id, "old");
    assert.equal(
      (await fetch(url + "/api/heartbeat/history?range=custom", { headers }))
        .status,
      400,
    );
  } finally {
    await app.engine.close();
    await new Promise<void>((r) => app.server.close(() => r()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
