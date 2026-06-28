import type { Inventory } from "./inventory.js";
import type { RefreshTarget, RefreshTargetKind, RefreshTargetPriority } from "./refresh-targets.js";
import { createRefreshContracts, type RefreshContract, type RefreshContractIssue } from "./refresh-contract.js";

export type RefreshPlanIssue = RefreshContractIssue;

export interface RefreshPlanItem {
  path: string;
  kinds: RefreshTargetKind[];
  priority: RefreshTargetPriority;
  reason: string;
  inventoryStatus: string | null;
  summaryRef: string | null;
  requiredReads: string[];
  expectedMemoryUpdates: string[];
  issues: RefreshPlanIssue[];
  skipReason: string | null;
}

export interface RefreshPlan {
  version: 1;
  createdAt: string;
  items: RefreshPlanItem[];
}

export function createRefreshPlan(input: { inventory: Inventory; targets: RefreshTarget[] }): RefreshPlan {
  const items = createRefreshContracts(input).map(createRefreshPlanItem);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    items
  };
}

function createRefreshPlanItem(contract: RefreshContract): RefreshPlanItem {
  return {
    path: contract.path,
    kinds: contract.kinds,
    priority: contract.priority,
    reason: contract.reason,
    inventoryStatus: contract.inventoryStatus,
    summaryRef: contract.summaryRef,
    requiredReads: buildRequiredReads(contract),
    expectedMemoryUpdates: buildExpectedMemoryUpdates(contract),
    issues: contract.issues,
    skipReason: contract.skipReason
  };
}

function buildRequiredReads(contract: RefreshContract): string[] {
  if (contract.skipReason) {
    return [];
  }
  const reads = new Set<string>();
  if (contract.obligations.readSource) {
    reads.add(contract.path);
  }
  if (contract.obligations.readDiff) {
    reads.add("git diff");
  }
  reads.add(".apeiron/memory/inventory.json");
  if (contract.summaryRef) {
    reads.add(contract.summaryRef);
  }
  if (contract.issues.includes("missing-summary-ref")) {
    reads.add("summaryRef to be created or chosen by refresh agent");
  }
  reads.add(".apeiron/memory/MODULES.md");
  return Array.from(reads);
}

function buildExpectedMemoryUpdates(contract: RefreshContract): string[] {
  if (contract.skipReason) {
    return [];
  }
  const updates = new Set<string>();
  updates.add(".apeiron/memory/inventory.json");
  if (contract.summaryRef) {
    updates.add(contract.summaryRef.split("#", 1)[0]);
  }
  if (contract.issues.includes("missing-summary-ref")) {
    updates.add("summaryRef to be created or chosen by refresh agent");
  }
  if (contract.obligations.readDiff) {
    updates.add(".apeiron/memory/MODULES.md");
  }
  return Array.from(updates);
}
