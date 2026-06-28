import { existsSync } from "node:fs";
import path from "node:path";
import { inspectCoverage } from "./coverage.js";
import type { Inventory, InventoryEntry } from "./inventory.js";
import { readInventory } from "./inventory.js";
import type { WarmupAuditIssue, WarmupAuditResult, WarmupMode } from "./warmup-types.js";

export interface WarmupAuditInput {
  workspaceRoot: string;
  mode: WarmupMode;
  readFilesThisRun?: string[];
  finish?: {
    scopeRationale?: string;
    blocked?: Array<{ path: string; reason: string }>;
  };
}

const BASE_MEMORY_FILES = ["PROJECT.md", "MODULES.md", "CONVENTIONS.md", "TESTING.md", "MEMORY.md"];

export async function auditWarmup(input: WarmupAuditInput): Promise<WarmupAuditResult> {
  const inventory = await readInventory(input.workspaceRoot);
  const coverage = await inspectCoverage(input.workspaceRoot, inventory);
  const effectiveInventory = coverage.reconciledInventory;
  const remaining: WarmupAuditIssue[] = [];
  const warnings: WarmupAuditIssue[] = [];
  const blockers: WarmupAuditIssue[] = [];
  const blockedPaths = new Set((input.finish?.blocked ?? []).map((item) => item.path).filter(Boolean));

  for (const issue of coverage.issues) {
    const mapped = mapCoverageIssue(issue.path, issue.type, issue.message);
    if (issue.type === "missing-summary-file") {
      blockers.push(mapped);
    } else {
      remaining.push(mapped);
    }
  }

  for (const [repoPath, entry] of Object.entries(effectiveInventory.files)) {
    auditEntry(input.workspaceRoot, input.mode, repoPath, entry, blockedPaths, remaining, warnings, blockers);
  }

  for (const memoryFile of BASE_MEMORY_FILES) {
    const memoryPath = path.join(input.workspaceRoot, ".apeiron", "memory", memoryFile);
    if (!existsSync(memoryPath)) {
      remaining.push({
        path: `.apeiron/memory/${memoryFile}`,
        type: "missing-memory-file",
        message: `${memoryFile} must exist after warmup.`
      });
    }
  }

  if (input.mode === "scoped") {
    auditScopedReadFiles(input, effectiveInventory, remaining);
    if (!input.finish?.scopeRationale?.trim()) {
      warnings.push({
        type: "missing-scope-rationale",
        message: "Scoped warmup should finish with a scopeRationale explaining why the explored boundary is sufficient."
      });
    }
  }

  const summary = summarizeInventory(effectiveInventory, input.readFilesThisRun?.length ?? 0);
  const finishAllowed = input.mode === "full"
    ? remaining.length === 0 && blockers.length === 0
    : blockers.length === 0 && !remaining.some((issue) => issue.type !== "unread-file");
  return {
    mode: input.mode,
    status: blockers.length > 0 ? "blocked" : finishAllowed ? "ready-to-finish" : "in-progress",
    finishAllowed,
    remaining,
    warnings,
    blockers,
    summary
  };
}

function auditEntry(
  workspaceRoot: string,
  mode: WarmupMode,
  repoPath: string,
  entry: InventoryEntry,
  blockedPaths: Set<string>,
  remaining: WarmupAuditIssue[],
  warnings: WarmupAuditIssue[],
  blockers: WarmupAuditIssue[]
): void {
  if (entry.status === "ignored" && !entry.reason?.trim()) {
    remaining.push({
      path: repoPath,
      type: "ignored-missing-reason",
      message: "Ignored files must record a long-term reason."
    });
  }

  if ((entry.status === "documented" || entry.status === "grouped") && !entry.summaryRef) {
    remaining.push({
      path: repoPath,
      type: "missing-summary-ref",
      message: "Documented/grouped files must have summaryRef."
    });
  }

  if ((entry.status === "documented" || entry.status === "grouped") && entry.summaryRef) {
    const summaryPath = entry.summaryRef.split("#", 1)[0];
    if (!existsSync(path.join(workspaceRoot, summaryPath))) {
      blockers.push({
        path: repoPath,
        type: "missing-summary-file",
        message: `summaryRef does not exist: ${entry.summaryRef}`
      });
    }
  }

  if (entry.status === "stale" && !blockedPaths.has(repoPath)) {
    remaining.push({
      path: repoPath,
      type: "stale-file",
      message: "Stale files must be refreshed, documented/grouped, ignored, or blocked with reason."
    });
  }

  if (entry.status === "unread" && mode === "full" && !blockedPaths.has(repoPath)) {
    remaining.push({
      path: repoPath,
      type: "unread-file",
      message: "Full warmup cannot finish while unignored files remain unread."
    });
  }

  if (entry.status === "unread" && mode === "scoped" && !entry.reason?.trim()) {
    warnings.push({
      path: repoPath,
      type: "unread-file",
      message: "Scoped warmup may leave files unread, but unread files should have a reason."
    });
  }
}

function auditScopedReadFiles(input: WarmupAuditInput, inventory: Inventory, remaining: WarmupAuditIssue[]): void {
  for (const repoPath of input.readFilesThisRun ?? []) {
    const entry = inventory.files[repoPath];
    if (!entry) {
      remaining.push({
        path: repoPath,
        type: "read-file-unprocessed",
        message: "A file read during scoped warmup is missing from inventory."
      });
      continue;
    }
    if (entry.status === "unread" && !input.finish?.blocked?.some((item) => item.path === repoPath)) {
      remaining.push({
        path: repoPath,
        type: "read-file-unprocessed",
        message: "Files read during scoped warmup should be documented/grouped/ignored, or explicitly blocked if still unreliable."
      });
    }
  }
}

function mapCoverageIssue(path: string, type: string, message: string): WarmupAuditIssue {
  if (type === "new-file") {
    return { path, type: "inventory-missing-file", message };
  }
  if (type === "missing-summary-ref") {
    return { path, type: "missing-summary-ref", message };
  }
  if (type === "missing-summary-file") {
    return { path, type: "missing-summary-file", message };
  }
  return { path, type: "stale-file", message };
}

function summarizeInventory(inventory: Inventory, readFilesThisRun: number): WarmupAuditResult["summary"] {
  const entries = Object.values(inventory.files);
  return {
    totalFiles: entries.length,
    documentedFiles: entries.filter((entry) => entry.status === "documented").length,
    groupedFiles: entries.filter((entry) => entry.status === "grouped").length,
    ignoredFiles: entries.filter((entry) => entry.status === "ignored").length,
    unreadFiles: entries.filter((entry) => entry.status === "unread").length,
    staleFiles: entries.filter((entry) => entry.status === "stale").length,
    readFilesThisRun
  };
}
