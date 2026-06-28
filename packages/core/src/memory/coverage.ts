import { existsSync } from "node:fs";
import path from "node:path";
import { hashFileSha256 } from "../repo/hash.js";
import { listRepoFiles } from "../repo/file-list.js";
import { decideIgnored, loadIgnoreRules } from "./ignore.js";
import {
  classifyPath,
  createDiscoveredEntry,
  createEmptyInventory,
  type Inventory,
  type InventoryEntry,
  type InventoryStatus
} from "./inventory.js";

export type CoverageStatus = "ready" | "needs-warmup" | "needs-refresh" | "blocked";

export interface CoverageIssue {
  path: string;
  type: "new-file" | "deleted-file" | "content-changed" | "missing-summary-ref" | "missing-summary-file";
  message: string;
  inventoryHash?: string | null;
  currentHash?: string | null;
}

export interface CoverageScanResult {
  status: CoverageStatus;
  issues: CoverageIssue[];
  inventory: Inventory;
  reconciledInventory: Inventory;
}

export async function inspectCoverage(workspaceRoot: string, existingInventory: Inventory | null): Promise<CoverageScanResult> {
  const rules = await loadIgnoreRules(workspaceRoot);
  const repoFiles = await listRepoFiles(workspaceRoot, { ignoreRules: rules });
  const inventory = existingInventory ? cloneInventory(existingInventory) : createEmptyInventory("unknown", null);
  const reconciledInventory = cloneInventory(inventory);
  const issues: CoverageIssue[] = [];
  const currentPaths = new Set(repoFiles.map((file) => file.path));

  for (const file of repoFiles) {
    const hash = await hashFileSha256(file.absolutePath);
    const ignored = decideIgnored(file.path, rules);
    const existing = reconciledInventory.files[file.path];
    if (!existing) {
      issues.push({ path: file.path, type: "new-file", message: "File is missing from inventory.json" });
      reconciledInventory.files[file.path] = createDiscoveredEntry({
        kind: classifyPath(file.path),
        status: ignored.ignored ? "ignored" : "unread",
        purpose: ignored.ignored ? "Ignored file discovered by coverage scan" : "File discovered by coverage scan",
        reason: ignored.reason ?? "new-file-detected",
        hash
      });
      continue;
    }
    if (existing.hash && existing.hash !== hash && existing.status !== "ignored") {
      issues.push({
        path: file.path,
        type: "content-changed",
        message: "File hash differs from inventory.json",
        inventoryHash: existing.hash,
        currentHash: hash
      });
      reconciledInventory.files[file.path] = { ...existing, status: "stale", reason: "content-changed" };
      continue;
    }
    reconciledInventory.files[file.path] = { ...existing, hash };
    validateSummaryRef(workspaceRoot, file.path, reconciledInventory.files[file.path], issues);
  }

  for (const inventoryPath of Object.keys(reconciledInventory.files)) {
    if (!currentPaths.has(inventoryPath)) {
      const ignored = decideIgnored(inventoryPath, rules);
      if (ignored.ignored) {
        delete reconciledInventory.files[inventoryPath];
        continue;
      }
      issues.push({ path: inventoryPath, type: "deleted-file", message: "Inventory file is missing from workspace" });
      reconciledInventory.files[inventoryPath] = {
        ...reconciledInventory.files[inventoryPath],
        status: "stale",
        reason: "deleted-file-detected"
      };
    }
  }

  return {
    status: deriveCoverageStatus(existingInventory, issues),
    issues,
    inventory,
    reconciledInventory
  };
}

export async function reconcileInventoryCoverage(workspaceRoot: string, existingInventory: Inventory | null): Promise<Inventory> {
  return (await inspectCoverage(workspaceRoot, existingInventory)).reconciledInventory;
}

/**
 * Backward-compatible name for existing callers. Prefer inspectCoverage for
 * pure status checks and reconcileInventoryCoverage before writing inventory.
 */
export async function scanCoverage(workspaceRoot: string, existingInventory: Inventory | null): Promise<CoverageScanResult> {
  return await inspectCoverage(workspaceRoot, existingInventory);
}

function validateSummaryRef(
  workspaceRoot: string,
  repoPath: string,
  entry: InventoryEntry,
  issues: CoverageIssue[]
): void {
  if (!requiresSummaryRef(entry.status)) {
    return;
  }
  if (!entry.summaryRef) {
    issues.push({ path: repoPath, type: "missing-summary-ref", message: "Documented/grouped file has no summaryRef" });
    return;
  }
  const summaryPath = entry.summaryRef.split("#", 1)[0];
  if (!existsSync(path.join(workspaceRoot, summaryPath))) {
    issues.push({ path: repoPath, type: "missing-summary-file", message: `summaryRef does not exist: ${entry.summaryRef}` });
  }
}

function requiresSummaryRef(status: InventoryStatus): boolean {
  return status === "documented" || status === "grouped";
}

function deriveCoverageStatus(existingInventory: Inventory | null, issues: CoverageIssue[]): CoverageStatus {
  if (!existingInventory) {
    return "needs-warmup";
  }
  if (issues.some((issue) => issue.type === "missing-summary-file")) {
    return "blocked";
  }
  if (issues.length > 0) {
    return "needs-refresh";
  }
  return "ready";
}

function cloneInventory(inventory: Inventory): Inventory {
  return JSON.parse(JSON.stringify(inventory)) as Inventory;
}
