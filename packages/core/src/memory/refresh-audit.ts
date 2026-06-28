import { existsSync } from "node:fs";
import path from "node:path";
import type { MemoryAgentAuditResult } from "./memory-agent-runner.js";
import type { MemoryAgentToolEvent } from "./memory-agent-tools.js";
import { inspectCoverage, type CoverageIssue } from "./coverage.js";
import type { Inventory } from "./inventory.js";
import type { RefreshTarget } from "./refresh-targets.js";

export interface RefreshAuditInput {
  workspaceRoot: string;
  targets: RefreshTarget[];
  inventory: Inventory | null;
  events: MemoryAgentToolEvent[];
  finish?: {
    checked?: RefreshAuditCheckedItem[];
    blocked?: RefreshAuditBlockedItem[];
  };
}

export interface RefreshAuditCheckedItem {
  path?: string;
  summaryRef?: string;
  updated?: boolean;
  noUpdateReason?: string;
}

export interface RefreshAuditBlockedItem {
  path?: string;
  reason?: string;
}

export interface RefreshAuditIssue {
  path: string;
  type:
    | "missing-target-resolution"
    | "blocked-missing-reason"
    | "updated-without-inventory-update"
    | "documented-missing-summary-ref"
    | "summary-ref-missing-file"
    | "ignored-missing-reason"
    | "coverage-blocked";
  message: string;
}

export async function auditRefresh(input: RefreshAuditInput): Promise<MemoryAgentAuditResult> {
  const remaining: RefreshAuditIssue[] = [];
  const warnings: RefreshAuditIssue[] = [];
  const blockers: RefreshAuditIssue[] = [];
  const checked = normalizeChecked(input.finish?.checked);
  const blocked = normalizeBlocked(input.finish?.blocked);

  if (input.finish) {
    for (const target of input.targets.filter((item) => item.priority === "must-refresh")) {
      if (!checked.has(target.path) && !blocked.has(target.path)) {
        remaining.push({
          path: target.path,
          type: "missing-target-resolution",
          message: "Every must-refresh target must appear in checked[] or blocked[]."
        });
      }
    }

    for (const [repoPath, reason] of blocked) {
      if (!reason.trim()) {
        blockers.push({
          path: repoPath,
          type: "blocked-missing-reason",
          message: "Blocked refresh targets must include a concrete reason."
        });
      }
    }

    for (const [repoPath, item] of checked) {
      if (item.updated && !sawInventoryUpdate(input.events, repoPath)) {
        warnings.push({
          path: repoPath,
          type: "updated-without-inventory-update",
          message: "Target was reported as updated without an inventory entry update; this is acceptable only when inventory facts did not change."
        });
      }
    }

    if (input.inventory) {
      auditInventory(input.workspaceRoot, input.inventory, remaining, blockers);
      const coverage = await inspectCoverage(input.workspaceRoot, input.inventory);
      for (const issue of coverage.issues) {
        const mapped = mapCoverageIssue(issue);
        if (issue.type === "missing-summary-file") {
          blockers.push(mapped);
        } else if (issue.type === "deleted-file" && input.targets.some((target) => target.path === issue.path && target.kinds.includes("deleted"))) {
          warnings.push(mapped);
        } else if (input.targets.some((target) => target.path === issue.path)) {
          remaining.push(mapped);
        } else {
          warnings.push(mapped);
        }
      }
    }
  }

  const finishAllowed = Boolean(input.finish) && remaining.length === 0 && blockers.length === 0;
  return {
    status: blockers.length > 0 ? "blocked" : finishAllowed ? "ready-to-finish" : "in-progress",
    finishAllowed,
    remaining,
    warnings,
    blockers,
    summary: {
      targetCount: input.targets.length,
      mustRefreshCount: input.targets.filter((target) => target.priority === "must-refresh").length,
      checkedCount: checked.size,
      blockedCount: blocked.size
    }
  };
}

function auditInventory(
  workspaceRoot: string,
  inventory: Inventory,
  remaining: RefreshAuditIssue[],
  blockers: RefreshAuditIssue[]
): void {
  for (const [repoPath, entry] of Object.entries(inventory.files)) {
    if ((entry.status === "documented" || entry.status === "grouped") && !entry.summaryRef) {
      remaining.push({
        path: repoPath,
        type: "documented-missing-summary-ref",
        message: "Documented/grouped inventory entries must have summaryRef."
      });
    }

    if ((entry.status === "documented" || entry.status === "grouped") && entry.summaryRef) {
      const summaryPath = entry.summaryRef.split("#", 1)[0];
      if (!existsSync(path.join(workspaceRoot, summaryPath))) {
        blockers.push({
          path: repoPath,
          type: "summary-ref-missing-file",
          message: `summaryRef does not exist: ${entry.summaryRef}`
        });
      }
    }

    if (entry.status === "ignored" && !entry.reason?.trim()) {
      remaining.push({
        path: repoPath,
        type: "ignored-missing-reason",
        message: "Ignored inventory entries must include a reason."
      });
    }
  }
}

function mapCoverageIssue(issue: CoverageIssue): RefreshAuditIssue {
  return {
    path: issue.path,
    type: issue.type === "missing-summary-file" ? "summary-ref-missing-file" : "coverage-blocked",
    message: issue.message
  };
}

function sawInventoryUpdate(events: MemoryAgentToolEvent[], repoPath: string): boolean {
  return events.some((event) => {
    if (event.type !== "tool-result" || event.tool !== "update_inventory_entry") {
      return false;
    }
    const result = event.result as { path?: unknown };
    return result.path === repoPath;
  });
}

function normalizeChecked(checked: RefreshAuditCheckedItem[] | undefined): Map<string, RefreshAuditCheckedItem> {
  return new Map(
    (Array.isArray(checked) ? checked : [])
      .filter((item) => typeof item.path === "string" && item.path.length > 0)
      .map((item) => [String(item.path), item])
  );
}

function normalizeBlocked(blocked: RefreshAuditBlockedItem[] | undefined): Map<string, string> {
  return new Map(
    (Array.isArray(blocked) ? blocked : [])
      .filter((item) => typeof item.path === "string" && item.path.length > 0)
      .map((item) => [String(item.path), String(item.reason ?? "")])
  );
}
