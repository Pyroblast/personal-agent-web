import { mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync(".runtime", { recursive: true });
copyFileSync("runtime-package.json", ".runtime/package.json");
copyFileSync("runtime-package-lock.json", ".runtime/package-lock.json");
const r = spawnSync("npm", ["ci", "--prefer-offline", "--prefix", ".runtime"], {
  stdio: "inherit",
});
process.exitCode = r.status ?? 1;
