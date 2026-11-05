import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(".runtime/node_modules");
const desired = JSON.parse(
  readFileSync("runtime-package.json", "utf8"),
).dependencies;
let ok = true;
for (const name of [
  "node",
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-sdk-client",
]) {
  const path = resolve(root, name, "package.json");
  if (!existsSync(path)) {
    console.log(`${name}: NOT INSTALLED`);
    ok = false;
    continue;
  }
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  console.log(`${name}: ${pkg.version} (expected ${desired[name]})`);
  if (pkg.version !== desired[name]) ok = false;
}
if (ok) {
  const r = spawnSync(resolve(root, "node/bin/node"), ["--version"], {
    encoding: "utf8",
  });
  console.log("isolated Node:", r.stdout.trim());
  ok = r.status === 0;
}
console.log("Runtime dependencies:", ok ? "PASS" : "NOT READY");
process.exitCode = ok ? 0 : 1;
