import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readInventory } from "./inventory.js";
import type { WarmupMode } from "./warmup-types.js";

export type WarmupRunPhase = "running" | "completed" | "interrupted";
export type WarmupErrorCategory = "config" | "auth" | "rate-limit" | "network" | "provider" | "protocol" | "aborted" | "unknown";

export interface WarmupRunError {
  category: WarmupErrorCategory;
  message: string;
  retryable: boolean;
}

export interface WarmupRunStatus {
  version: 1;
  phase: WarmupRunPhase;
  mode: WarmupMode;
  goal: string;
  scopeHints: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  interruptedAt?: string;
  completedFiles: string[];
  pendingFiles: string[];
  documentedFiles: string[];
  writtenMemoryFiles: string[];
  blocked: Array<{ path: string; reason: string }>;
  lastError?: WarmupRunError;
  resumeFrom?: {
    interruptedAt: string;
    completedFiles: string[];
    pendingFiles: string[];
    error?: WarmupRunError;
  };
}

export async function readWarmupStatus(workspaceRoot: string): Promise<WarmupRunStatus | null> {
  const filePath = warmupStatusPath(workspaceRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as WarmupRunStatus;
}

export async function writeWarmupStatus(workspaceRoot: string, status: WarmupRunStatus): Promise<void> {
  const filePath = warmupStatusPath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export async function createWarmupProgressSnapshot(workspaceRoot: string): Promise<{
  completedFiles: string[];
  pendingFiles: string[];
}> {
  const inventory = await readInventory(workspaceRoot);
  const files = inventory?.files ?? {};
  const completedFiles = Object.entries(files)
    .filter(([, entry]) => entry.status === "documented" || entry.status === "grouped" || entry.status === "ignored")
    .map(([repoPath]) => repoPath)
    .sort();
  const pendingFiles = Object.entries(files)
    .filter(([, entry]) => entry.status === "unread" || entry.status === "stale" || entry.status === "missing-ref")
    .map(([repoPath]) => repoPath)
    .sort();
  return { completedFiles, pendingFiles };
}

export function classifyWarmupError(error: unknown): WarmupRunError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message === "Apeiron run aborted") {
    return { category: "aborted", message, retryable: true };
  }
  if (lower.includes("missing apeiron_openai") || lower.includes("missing apeiron_model") || lower.includes("unsupported apeiron_model_api")) {
    return { category: "config", message, retryable: false };
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("api key")) {
    return { category: "auth", message, retryable: false };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many request")) {
    return { category: "rate-limit", message, retryable: true };
  }
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("fetch failed") || lower.includes("econn") || lower.includes("enotfound")) {
    return { category: "network", message, retryable: true };
  }
  if (lower.includes("did not return finish") || lower.includes("valid json") || lower.includes("did not include text")) {
    return { category: "protocol", message, retryable: true };
  }
  if (lower.includes("llm request failed") || lower.includes("stopreason=error")) {
    return { category: "provider", message, retryable: true };
  }
  return { category: "unknown", message, retryable: true };
}

export function warmupStatusPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".apeiron", "memory", "warmup-status.json");
}
