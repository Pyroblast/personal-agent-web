import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
// Controlled product directory; no user skill roots or tool privileges are loaded.
export function loadedSkills(mode: string, query: string) {
  const names =
    mode === "memory_upkeep"
      ? []
      : mode === "user_message"
        ? ["goal-creation", "goal-followup"]
        : ["goal-followup"];
  if (
    mode !== "memory_upkeep" &&
    /旅行|出行|行程|机票|酒店|航班|旅游|东京|北京|签证/.test(query)
  )
    names.push("travel-planning");
  return names.map((name) => {
    const body = readFileSync(resolve("runtime/skills", name + ".md"), "utf8");
    return {
      name,
      version: createHash("sha256").update(body).digest("hex"),
      body,
    };
  });
}
