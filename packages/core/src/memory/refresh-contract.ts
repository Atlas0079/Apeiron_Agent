import type { Inventory, InventoryStatus } from "./inventory.js";
import type { RefreshTarget, RefreshTargetKind, RefreshTargetPriority } from "./refresh-targets.js";

export type RefreshContractIssue = "missing-inventory-entry" | "missing-summary-ref";

export interface RefreshContractObligations {
  inspectInventory: true;
  readSource: boolean;
  readDiff: boolean;
  readSummary: boolean;
  requireFinishCheck: boolean;
  requireNoUpdateReasonIfClean: boolean;
  updateInventoryIfUpdated: boolean;
}

export interface RefreshContract {
  path: string;
  kinds: RefreshTargetKind[];
  priority: RefreshTargetPriority;
  reason: string;
  inventoryStatus: InventoryStatus | null;
  summaryRef: string | null;
  obligations: RefreshContractObligations;
  issues: RefreshContractIssue[];
  skipReason: string | null;
}

export function createRefreshContracts(input: { inventory: Inventory; targets: RefreshTarget[] }): RefreshContract[] {
  return input.targets.map((target) => createRefreshContract(input.inventory, target));
}

function createRefreshContract(inventory: Inventory, target: RefreshTarget): RefreshContract {
  const entry = inventory.files[target.path] ?? null;
  const summaryRef = entry?.summaryRef ?? null;
  const readOnly = target.kinds.length > 0 && target.kinds.every((kind) => kind === "read");
  const skipReason =
    entry && target.priority === "opportunistic" && readOnly && entry.status !== "unread"
      ? `read-only opportunistic target already has inventory status ${entry.status}`
      : null;

  return {
    path: target.path,
    kinds: target.kinds,
    priority: skipReason ? "ignore-unless-memory-wrong" : target.priority,
    reason: target.reason,
    inventoryStatus: entry?.status ?? null,
    summaryRef,
    obligations: {
      inspectInventory: true,
      readSource: !target.kinds.includes("deleted"),
      readDiff: target.kinds.some((kind) => kind === "modified" || kind === "created" || kind === "deleted"),
      readSummary: Boolean(summaryRef),
      requireFinishCheck: !skipReason,
      requireNoUpdateReasonIfClean: !skipReason && target.priority === "must-refresh",
      updateInventoryIfUpdated: !skipReason
    },
    issues: buildIssues(entry, target, summaryRef),
    skipReason
  };
}

function buildIssues(entry: Inventory["files"][string] | null, target: RefreshTarget, summaryRef: string | null): RefreshContractIssue[] {
  const issues = new Set<RefreshContractIssue>();
  if (!entry) {
    issues.add("missing-inventory-entry");
  }
  if (target.priority === "must-refresh" && !summaryRef) {
    issues.add("missing-summary-ref");
  }
  return Array.from(issues);
}
