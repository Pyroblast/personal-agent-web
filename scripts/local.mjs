import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  mkdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const dir = resolve(".data/experience");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const infoFile = dir + "/service.json";
const previous = existsSync(infoFile)
  ? JSON.parse(readFileSync(infoFile, "utf8"))
  : null;
async function alive(info) {
  if (!info || !existsSync(dir + "/access-token")) return false;
  try {
    const r = await fetch("http://127.0.0.1:" + info.port + "/api/state", {
      headers: {
        authorization: "Bearer " + readFileSync(dir + "/access-token", "utf8"),
      },
      signal: AbortSignal.timeout(1000),
    });
    if (!r.ok) return false;
    const state = await r.json();
    return !info.instanceId || info.instanceId === state.instanceId;
  } catch {
    return false;
  }
}
const command = process.argv[2] || "start";
if (command === "stop") {
  if (await alive(previous)) {
    process.kill(previous.pid, "SIGTERM");
    console.log("已请求停止后台；当前执行会标记为中断。");
  } else console.log("后台未运行。");
} else {
  let info = previous;
  if (!(await alive(info))) {
    if (
      !existsSync("dist/server.js") ||
      !existsSync(".runtime/node_modules/node/bin/node")
    )
      throw new Error("请先执行 npm run build 和 npm run setup:runtime");
    const log = openSync(dir + "/server.log", "a", 0o600);
    const port = Number(process.env.PA_MVP_PORT || 4310);
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PA_MVP_DATA_DIR: dir,
        PA_MVP_PORT: String(port),
        PA_MVP_REUSE_CONFIG: "0",
        PA_MVP_TEST_COMPACTION: "0",
      },
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    info = { pid: child.pid, port };
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (await alive(info)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready)
      throw new Error(
        "后台启动失败，请查看 .data/experience/server.log；若端口占用可设置 PA_MVP_PORT。",
      );
    const state = await fetch("http://127.0.0.1:" + port + "/api/state", {
      headers: {
        authorization: "Bearer " + readFileSync(dir + "/access-token", "utf8"),
      },
    }).then((r) => r.json());
    info.instanceId = state.instanceId;
    writeFileSync(infoFile, JSON.stringify(info), { mode: 0o600 });
  }
  const url =
    "http://127.0.0.1:" +
    info.port +
    "/#token=" +
    readFileSync(dir + "/access-token", "utf8");
  console.log(
    "本机体验入口：" + url + "\n关闭浏览器后台仍运行；停止：npm run local:stop",
  );
  if (command === "open") spawn("open", [url], { stdio: "ignore" }).unref();
}
