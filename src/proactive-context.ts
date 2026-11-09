import type { Store } from "./store.js";
import { ContextService } from "./context-service.js";
export function proactiveContext(store: Store, goalId: string | null = null) {
  return new ContextService(store).build(goalId);
}
