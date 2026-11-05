import { DeepSeekHarness } from "../.runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js";
import { resolve } from "node:path";
let harness,
  session,
  sessionId,
  closed = false,
  busy = false;
const send = (x) => {
  if (process.connected) process.send(x);
};
const redact = (s) =>
  String(s)
    .split(process.env.DEEPSEEK_API_KEY || "__NO_SECRET__")
    .join("[REDACTED]");
process.on("disconnect", async () => {
  await harness?.close().catch(() => {});
  process.exit(0);
});
process.on("message", async (m) => {
  if (m.type === "stop") {
    closed = true;
    await harness?.close().catch(() => {});
    process.exit(0);
    return;
  }
  if (m.type !== "run" || busy) return;
  busy = true;
  try {
    if (!harness) {
      harness = new DeepSeekHarness({
        profile: "sdk-minimal",
        patches: [
          resolve("runtime/personal.cordis.yml"),
          ...(process.env.PA_WORK_SEARCH === undefined
            ? [resolve("runtime/compat2.cordis.yml")]
            : []),
          ...(process.env.PA_RUN_MODE === "heartbeat"
            ? [resolve("runtime/heartbeat.cordis.yml")]
            : []),
          ...(process.env.PA_RUN_MODE === "work"
            ? [resolve("runtime/work.cordis.yml")]
            : []),
          ...(process.env.PA_RUN_MODE === "upkeep"
            ? [resolve("runtime/upkeep.cordis.yml")]
            : []),
          ...(process.env.PA_MVP_TEST_COMPACTION === "1"
            ? [resolve("runtime/acceptance.cordis.yml")]
            : []),
        ],
        dshHome: process.env.DSH_HOME,
        cwd: process.env.PA_WORKSPACE,
        processCwd: process.env.PA_WORKSPACE,
        model: process.env.PA_MODEL || "deepseek-flash",
        provider: "deepseek-official",
        maxTokens: process.env.PA_RUN_MODE === "work" ? 8192 : 4096,
        initializeTimeoutMs: 30000,
        requestTimeoutMs: 180000,
        env: { ...process.env },
      });
      await harness.start();
      send({ type: "ready" });
    }
    if (sessionId !== m.sessionId) {
      session = m.resume
        ? await harness.resumeSession(m.sessionId)
        : harness.session(m.sessionId);
      sessionId = m.sessionId;
    }
    // Literal content blocks: do not route user text through native slash commands.
    const result = await session.run([{ type: "text", text: m.text }], {
      onNotification: (n) => {
        if (n.method === "session.event") {
          const e = n.params.event;
          if (e.type === "llm/retry")
            send({
              type: "provider-issue",
              code: e.data?.failure?.code,
              status: e.data?.failure?.status,
            });
          if (e.type === "agent/inbox/spliced")
            send({ type: "receipt", id: e.data?.inserted?.[0]?.id });
          if (e.type === "turn/end") send({ type: "turn-end", data: e.data });
          if (/compact|condens/.test(e.type))
            send({ type: "compact", eventType: e.type, data: e.data });
        }
      },
    });
    const end = [...result.events].reverse().find((e) => e.type === "turn/end");
    if (!end) throw new Error("No durable turn completion");
    const usage = {};
    for (const e of result.events)
      if (e.type === "assistant/message" || e.type === "compaction/summary")
        for (const [k, v] of Object.entries(e.data.usage || {}))
          if (typeof v === "number") usage[k] = (usage[k] || 0) + v;
    send({
      type: "result",
      usage,
      text: result.finalResponse,
      sessionId,
      turnEnd: end.data,
      eventTypes: [...new Set(result.events.map((e) => e.type))],
    });
  } catch (e) {
    if (!closed) send({ type: "error", error: redact(e?.stack || e) });
  } finally {
    busy = false;
  }
});
