import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
export type ModelConfig = { model: string; apiKey: string };
export function loadConfig(dataDir: string): ModelConfig | undefined {
  const p = join(dataDir, "model-config.json");
  if (!existsSync(p)) return;
  const c = JSON.parse(readFileSync(p, "utf8"));
  if (
    c.baseUrl !== "https://api.deepseek.com/v1" ||
    typeof c.apiKey !== "string" ||
    !c.apiKey.trim()
  )
    throw new Error("模型配置必须为官方 DeepSeek 接口");
  return {
    model: typeof c.model === "string" ? c.model : "deepseek-flash",
    apiKey: c.apiKey,
  };
}
export function reuseConfig(dataDir: string, source?: string) {
  const dest = join(dataDir, "model-config.json");
  if (existsSync(dest)) return;
  const f = source;
  if (!f || !existsSync(f))
    throw new Error(
      "未找到已有模型配置；请通过 PA_MVP_CONFIG_SOURCE 指定本机配置文件",
    );
  const c = JSON.parse(readFileSync(f, "utf8"));
  if (c.baseUrl !== "https://api.deepseek.com/v1" || !c.apiKey)
    throw new Error("已有配置不是有效的官方 DeepSeek 配置");
  writeFileSync(
    dest,
    JSON.stringify({
      mode: "deepseek",
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
    }),
    { mode: 0o600 },
  );
  chmodSync(dest, 0o600);
}
