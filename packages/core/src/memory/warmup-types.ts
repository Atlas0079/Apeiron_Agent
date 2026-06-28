export type WarmupMode = "full" | "scoped";

export interface WarmupScopeHint {
  goal: string;
  paths: string[];
}

export interface WarmupAuditIssue {
  path?: string;
  type:
    | "inventory-missing-file"
    | "unread-file"
    | "stale-file"
    | "missing-summary-ref"
    | "missing-summary-file"
    | "ignored-missing-reason"
    | "missing-memory-file"
    | "missing-scope-rationale"
    | "read-file-unprocessed";
  message: string;
}

export interface WarmupAuditResult {
  mode: WarmupMode;
  status: "in-progress" | "ready-to-finish" | "blocked";
  finishAllowed: boolean;
  remaining: WarmupAuditIssue[];
  warnings: WarmupAuditIssue[];
  blockers: WarmupAuditIssue[];
  summary: {
    totalFiles: number;
    documentedFiles: number;
    groupedFiles: number;
    ignoredFiles: number;
    unreadFiles: number;
    staleFiles: number;
    readFilesThisRun: number;
  };
}
