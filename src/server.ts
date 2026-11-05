import { createServer, type IncomingMessage } from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { resolve, join, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, InputError } from "./store.js";
import { Engine } from "./engine.js";
import { checkHistory } from "./check-history.js";
import { reuseConfig } from "./config.js";
const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function body(req: IncomingMessage) {
  let b = "";
  for await (const chunk of req) {
    b += chunk;
    if (Buffer.byteLength(b) > 100000) throw new InputError("请求过大", 413);
  }
  try {
    return JSON.parse(b);
  } catch {
    throw new InputError("JSON 格式错误");
  }
}
export function createApp(dataDir: string, uiDir = join(project, "ui")) {
  // Serve one coherent UI build for this server instance while a new build is prepared.
  const assets = new Map<string, Buffer>();
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) assets.set(resolve(file), readFileSync(file));
    }
  };
  collect(uiDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const lockFile = join(dataDir, "service.lock");
  const owner = randomBytes(16).toString("hex");
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    let alive = true;
    try {
      process.kill(lock.pid, 0);
    } catch (e: any) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("此数据目录已有服务运行，不能启动第二个调度器");
    unlinkSync(lockFile);
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner }), {
    flag: "wx",
    mode: 0o600,
  });
  const release = () => {
    if (
      existsSync(lockFile) &&
      JSON.parse(readFileSync(lockFile, "utf8")).owner === owner
    )
      unlinkSync(lockFile);
  };
  try {
    const tokenFile = join(dataDir, "access-token");
    if (!existsSync(tokenFile))
      writeFileSync(tokenFile, randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
    if (process.env.PA_MVP_REUSE_CONFIG === "1")
      reuseConfig(dataDir, process.env.PA_MVP_CONFIG_SOURCE);
    const token = readFileSync(tokenFile, "utf8"),
      store = new Store(join(dataDir, "product.sqlite"));
    const instanceId = randomBytes(16).toString("hex");
    const bridgeToken = randomBytes(32).toString("hex"),
      engine = new Engine(store, dataDir, bridgeToken);
    const server = createServer(async (req, res) => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(data));
      };
      try {
        const host = req.headers.host || "";
        if (!/^127\.0\.0\.1:\d+$/.test(host)) {
          json(403, { error: "仅允许本机入口" });
          return;
        }
        const url = new URL(req.url || "/", `http://${host}`);
        if (url.pathname.startsWith("/internal/")) {
          if (
            req.headers.authorization !== "Bearer " + bridgeToken ||
            req.method !== "POST"
          ) {
            json(403, { error: "内部接口拒绝访问" });
            return;
          }
          json(200, engine.internal(url.pathname.slice(10), await body(req)));
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          if (req.headers.origin && req.headers.origin !== `http://${host}`) {
            json(403, { error: "来源不允许" });
            return;
          }
          const supplied = String(req.headers.authorization || "").replace(
            /^Bearer /,
            "",
          );
          if (
            Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
          ) {
            json(401, { error: "请使用启动时的本机入口" });
            return;
          }
          if (
            req.method === "GET" &&
            url.pathname === "/api/heartbeat/history"
          ) {
            json(200, checkHistory(store, url.searchParams));
            return;
          }
          if (req.method === "GET" && url.pathname === "/api/state") {
            json(200, {
              ...store.state(),
              runtime: engine.status(),
              heartbeat: engine.heartbeat.status(),
              agentProfile: engine.profile.get(),
              upkeep: engine.upkeep.status(),
              work: engine.work.state(),
              instanceId,
            });
            return;
          }
          if (req.method === "GET" && url.pathname === "/api/artifact") {
            json(
              200,
              engine.work.artifact(
                String(url.searchParams.get("id")),
                url.searchParams.has("version")
                  ? Number(url.searchParams.get("version"))
                  : undefined,
              ),
            );
            return;
          }
          if (
            req.method === "GET" &&
            url.pathname === "/api/notification-policies"
          ) {
            json(200, {
              ...engine.work.defaults(),
              contactPolicy: engine.heartbeat.policy(),
            });
            return;
          }
          if (req.method === "POST") {
            if (!req.headers["content-type"]?.startsWith("application/json"))
              throw new InputError("仅接受 JSON", 415);
            const b = await body(req);
            if (url.pathname === "/api/work") {
              const result = engine.work.command(
                b.name,
                b.args,
                null,
                b.requestKey,
              );
              if (engine.isWork()) {
                try {
                  engine.work.context(engine.active.id);
                } catch {
                  await engine.fail("用户修改了工作安排，已撤销旧执行");
                }
              }
              json(200, result);
              void engine.pump();
              return;
            }
            if (url.pathname === "/api/notification-policies") {
              json(200, engine.work.notificationUpdate(b));
              return;
            }
            if (url.pathname === "/api/messages") {
              let isNew = false;
              const message = store.transaction(() => {
                isNew = !store.db
                  .prepare("SELECT id FROM messages WHERE request_key=?")
                  .get(String(b.requestKey));
                const m: any = store.enqueue(
                  b.text,
                  b.requestKey,
                  !!engine.config,
                );
                if (isNew) engine.heartbeat.link(m.id, b.replyTo);
                else if (
                  b.replyTo &&
                  (
                    store.db
                      .prepare(
                        "SELECT reply_to FROM message_links WHERE message_id=?",
                      )
                      .get(m.id) as any
                  )?.reply_to !== b.replyTo
                )
                  throw new InputError("同一请求不能更换回复对象", 409);
                return m;
              });
              if (isNew) await engine.onUserInput();
              json(201, message);
              return;
            }
            if (url.pathname === "/api/profile") {
              json(200, await engine.updateProfile(b.patch, b.revision));
              return;
            }
            if (url.pathname === "/api/upkeep") {
              json(200, await engine.updateUpkeep(b.enabled, b.revision));
              return;
            }
            if (url.pathname === "/api/upkeep/check") {
              json(200, await engine.organizeNow());
              return;
            }
            if (url.pathname === "/api/upkeep/resolve") {
              const result = engine.upkeep.resolve(
                b.checkId,
                b.index,
                b.keepId,
              );
              if (b.keepId) await engine.invalidate();
              json(200, result);
              return;
            }
            if (url.pathname === "/api/heartbeat") {
              json(200, await engine.updatePolicy(b.patch, b.revision));
              return;
            }
            if (url.pathname === "/api/heartbeat/check") {
              json(200, await engine.checkNow());
              return;
            }
            if (url.pathname === "/api/heartbeat/seen") {
              json(200, engine.heartbeat.seen(b.ids));
              return;
            }
            if (url.pathname === "/api/messages/cancel") {
              await engine.cancel(String(b.id));
              json(200, { ok: true });
              return;
            }
            if (url.pathname === "/api/memories") {
              const memory = store.saveMemory(b);
              await engine.invalidate();
              json(200, memory);
              return;
            }
            if (url.pathname === "/api/memories/forget") {
              store.forget(String(b.id), b.revision);
              await engine.invalidate();
              json(200, { ok: true });
              return;
            }
          }
          json(404, { error: "接口不存在" });
          return;
        }
        if (req.method !== "GET") {
          json(405, { error: "方法不支持" });
          return;
        }
        const p =
          url.pathname === "/"
            ? "index.html"
            : decodeURIComponent(url.pathname.slice(1));
        const full = resolve(uiDir, p);
        if (!full.startsWith(resolve(uiDir) + "/")) {
          json(404, { error: "不存在" });
          return;
        }
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        };
        if (!assets.has(full)) {
          json(404, { error: "页面尚未构建" });
          return;
        }
        res.writeHead(200, {
          "content-type": mime[extname(full)] || "application/octet-stream",
          "content-security-policy":
            "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        res.end(assets.get(full));
      } catch (e) {
        json(e instanceof InputError ? e.status : 500, {
          error:
            e instanceof InputError ? e.message : "操作失败，请检查本机服务",
        });
      }
    });
    server.on("listening", () =>
      engine.start("http://127.0.0.1:" + (server.address() as any).port),
    );
    server.once("close", () => {
      clearInterval(engine.heartbeatTimer);
      release();
    });
    server.once("error", release);
    return { server, store, token, engine };
  } catch (e) {
    release();
    throw e;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = resolve(process.env.PA_MVP_DATA_DIR || ".data");
  const app = createApp(dir, resolve("dist/ui"));
  const port = Number(process.env.PA_MVP_PORT || 4310);
  app.server.listen(port, "127.0.0.1", () =>
    console.log(
      `Personal Agent MVP 开发版：http://127.0.0.1:${port}/#token=${app.token}\n后台需保持运行；真实模型按配置启用。`,
    ),
  );
  app.server.on("error", () => {
    console.error("端口不可用，请设置独立的 PA_MVP_PORT");
    app.store.close();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void app.engine.close().then(() =>
        app.server.close(() => {
          app.store.close();
          process.exit(0);
        }),
      );
    });
}
