import type { Inventory, InventoryStatus } from "./inventory.js";
import type { RefreshTarget, RefreshTargetKind } from "./refresh-targets.js";

export interface ResolveRefreshTargetsInput {
  inventory: Inventory | null;
  targetGroups: RefreshTarget[][];
}

export function resolveRefreshTargets(input: ResolveRefreshTargetsInput): RefreshTarget[] {
  const merged = mergeRefreshTargets(...input.targetGroups);
  if (!input.inventory) {
    return merged;
  }
  return applyInventoryPolicy(merged, input.inventory);
}

export function mergeRefreshTargets(...targetGroups: RefreshTarget[][]): RefreshTarget[] {
  const merged = new Map<string, RefreshTarget>();
  for (const group of targetGroups) {
    for (const target of group) {
      const existing = merged.get(target.path);
      if (!existing) {
        merged.set(target.path, {
          ...target,
          kinds: normalizeKinds(target.kinds)
        });
        continue;
      }
      const kinds = normalizeKinds([...existing.kinds, ...target.kinds]);
      merged.set(target.path, {
        path: target.path,
        kinds,
        priority: existing.priority === "must-refresh" || target.priority === "must-refresh" ? "must-refresh" : existing.priority,
        reason: existing.reason === target.reason ? existing.reason : `${existing.reason}; ${target.reason}`
      });
    }
  }
  return sortTargets(Array.from(merged.values()));
}

function applyInventoryPolicy(targets: RefreshTarget[], inventory: Inventory): RefreshTarget[] {
  const resolved: RefreshTarget[] = [];
  for (const target of targets) {
    if (hasContentChange(target.kinds)) {
      resolved.push(target);
      continue;
    }

    if (!isReadOnlyTarget(target.kinds)) {
      resolved.push(target);
      continue;
    }

    const entry = inventory.files[target.path];
    if (!entry) {
      resolved.push({
        ...target,
        priority: "opportunistic",
        reason: "file was read during work and is missing from inventory"
      });
      continue;
    }

    if (entry.status === "ignored") {
      continue;
    }

    if (canSkipReadRefresh(entry.status) && entry.summaryRef) {
      continue;
    }

    if (canSkipReadRefresh(entry.status) && !entry.summaryRef) {
      resolved.push({
        ...target,
        priority: "must-refresh",
        reason: `file was read during work and inventory status is ${entry.status} without summaryRef`
      });
      continue;
    }

    if (entry.status === "stale" || entry.status === "missing-ref") {
      resolved.push({
        ...target,
        priority: "must-refresh",
        reason: `file was read during work and inventory status is ${entry.status}`
      });
      continue;
    }

    resolved.push({
      ...target,
      priority: "opportunistic",
      reason: "file was read during work and may support opportunistic warmup if inventory status is unread"
    });
  }
  return sortTargets(resolved);
}

function hasContentChange(kinds: RefreshTargetKind[]): boolean {
  return kinds.some((kind) => kind === "modified" || kind === "created" || kind === "deleted");
}

function isReadOnlyTarget(kinds: RefreshTargetKind[]): boolean {
  return kinds.length > 0 && kinds.every((kind) => kind === "read");
}

function canSkipReadRefresh(status: InventoryStatus): boolean {
  return status === "documented" || status === "grouped";
}

function normalizeKinds(kinds: RefreshTargetKind[]): RefreshTargetKind[] {
  return Array.from(new Set(kinds)).sort();
}

function sortTargets(targets: RefreshTarget[]): RefreshTarget[] {
  return targets.sort((a, b) => a.path.localeCompare(b.path));
}
