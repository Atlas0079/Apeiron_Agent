import type { Inventory } from "./inventory.js";

export function fillScopedWarmupUnreadReasons(inventory: Inventory, scopeHints: string[]): Inventory {
  const next = cloneInventory(inventory);
  const reason = scopeHints.length > 0 ? "outside-scoped-warmup" : "read-deferred";
  for (const entry of Object.values(next.files)) {
    if (entry.status !== "unread" || entry.reason?.trim()) {
      continue;
    }
    entry.reason = reason;
  }
  return next;
}

function cloneInventory(inventory: Inventory): Inventory {
  return JSON.parse(JSON.stringify(inventory)) as Inventory;
}
