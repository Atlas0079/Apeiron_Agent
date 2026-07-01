import type { MemoryAgentToolEvent } from "./memory-agent-tools.js";
import type { ApeironLlmRetryEvent } from "../llm/provider.js";
import { auditRefresh } from "./refresh-audit.js";
import { runMemoryAgent } from "./memory-agent-runner.js";
import type { RefreshTarget } from "./refresh-targets.js";
import { readInventory } from "./inventory.js";
import { summarizeMemoryDiff, type MemoryDiffSummary } from "./memory-diff.js";
import { markBlockingTurnsRefreshComplete } from "../session/turn.js";

export interface RefreshLlmInput {
  workspaceRoot: string;
  targets: RefreshTarget[];
  maxTurns?: number;
  abortSignal?: AbortSignal;
  onToolEvent?: (event: MemoryAgentToolEvent) => void;
  onLlmRetry?: (event: ApeironLlmRetryEvent) => void;
  llmOptions?: Parameters<typeof runMemoryAgent>[0]["llmOptions"];
}

export interface RefreshLlmResult {
  updatedSummaries: string[];
  updatedMemoryFiles: string[];
  blocked: Array<{ path: string; reason: string }>;
  checked: Array<{ path: string; summaryRef: string; updated: boolean; noUpdateReason: string | null }>;
  memoryFactsAppended: string[];
  memoryDiffSummary: MemoryDiffSummary;
  events: MemoryAgentToolEvent[];
  turns: number;
}

interface RefreshAgentFinish {
  updatedSummaries?: string[];
  updatedMemoryFiles?: string[];
  blocked?: Array<{ path: string; reason: string }>;
  checked?: Array<{ path: string; summaryRef?: string; updated?: boolean; noUpdateReason?: string }>;
  memoryFactsAppended?: string[];
}

export async function runLlmRefresh(input: RefreshLlmInput): Promise<RefreshLlmResult> {
  const inventory = await readInventory(input.workspaceRoot);
  if (!inventory) {
    throw new Error("Missing .apeiron/memory/inventory.json");
  }
  const result = await runMemoryAgent<RefreshAgentFinish>({
    workspaceRoot: input.workspaceRoot,
    maxTurns: input.maxTurns ?? 20,
    abortSignal: input.abortSignal,
    onToolEvent: input.onToolEvent,
    onLlmRetry: input.onLlmRetry,
    llmOptions: input.llmOptions,
    systemPrompt: REFRESH_SYSTEM_PROMPT,
    task: {
      mode: "refresh",
      targets: input.targets,
      completionCriteria: [
        "Every must-refresh target is checked or explicitly blocked.",
        "Create or update summaryRef and inventory entry when needed.",
        "documented/grouped inventory entries must have summaryRef and the summaryRef file must exist.",
        "ignored inventory entries must have a reason.",
        "Update MODULES/PROJECT/CONVENTIONS/TESTING/MEMORY only when the current code facts require it.",
        "MEMORY.md is append-only and may only receive long-term maintenance facts.",
        "Finish result must list checked, updatedMemoryFiles, updatedSummaries, memoryFactsAppended, and blocked."
      ]
    },
    audit: async ({ events, finish }) =>
      auditRefresh({
        workspaceRoot: input.workspaceRoot,
        targets: input.targets,
        inventory: await readInventory(input.workspaceRoot),
        events,
        finish: normalizeRefreshFinishForAudit(finish)
      })
  });
  const normalized = await normalizeRefreshFinish(input.workspaceRoot, result.finish, result.events, result.turns);
  await markBlockingTurnsRefreshComplete(
    input.workspaceRoot,
    normalized.blocked.length > 0 ? "blocked" : hasMemoryUpdates(normalized) ? "updated" : "clean"
  );
  return normalized;
}

const REFRESH_SYSTEM_PROMPT = `You are Apeiron refresh, an agentic memory maintenance run.

You are not a per-file summarizer. You must inspect the current repository state using tools, decide what memory needs to change, write those memory updates, update inventory, then finish with an audit summary.

Hard rules:
- Return only valid JSON actions.
- Source files are read-only in refresh. Only write under .apeiron/memory via write_memory_file or update inventory via update_inventory_entry.
- Do not overwrite .apeiron/memory/MEMORY.md. Use append_memory_fact only for facts that will matter in future maintenance.
- Do not write temporary task logs, command output, or guesses into memory.
- documented/grouped inventory entries must have summaryRef.
- You may mark clearly low-value files ignored without reading contents when path evidence is reliable. Prefer mark_files_ignored for batches, and always provide a concrete reason.
- If a whole file extension should stay outside Apeiron memory, use ignore_extensions so future coverage scans skip it.
- If a must-refresh target cannot be checked, include it in blocked with a concrete reason.

Useful strategy:
1. Start with get_coverage_status and get_git_diff.
2. For each target, inspect enough source, diff, inventory, and existing summaries to make a reliable memory maintenance decision.
3. Search or read adjacent files/tests/configs when needed to understand module impact.
4. Write concise current-state memory docs. Prefer grouped/module summaries when that is more accurate than isolated summaries.
5. Update inventory entries after writing memory docs.
6. Finish only after all must-refresh targets are checked or blocked with reason.`;

async function normalizeRefreshFinish(
  workspaceRoot: string,
  finish: RefreshAgentFinish,
  events: MemoryAgentToolEvent[],
  turns: number
): Promise<RefreshLlmResult> {
  const checked = Array.isArray(finish.checked)
    ? finish.checked.map((item) => ({
        path: String(item.path ?? ""),
        summaryRef: String(item.summaryRef ?? ""),
        updated: Boolean(item.updated),
        noUpdateReason: typeof item.noUpdateReason === "string" && item.noUpdateReason.trim() ? item.noUpdateReason : null
      }))
    : [];
  return {
    updatedSummaries: asStringArray(finish.updatedSummaries),
    updatedMemoryFiles: asStringArray(finish.updatedMemoryFiles),
    blocked: Array.isArray(finish.blocked)
      ? finish.blocked.map((item) => ({ path: String(item.path ?? ""), reason: String(item.reason ?? "") }))
      : [],
    checked,
    memoryFactsAppended: asStringArray(finish.memoryFactsAppended),
    memoryDiffSummary: await summarizeMemoryDiff(workspaceRoot),
    events,
    turns
  };
}

function normalizeRefreshFinishForAudit(value: unknown): RefreshAgentFinish | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const finish = value as RefreshAgentFinish;
  return {
    checked: Array.isArray(finish.checked) ? finish.checked : [],
    blocked: Array.isArray(finish.blocked) ? finish.blocked : []
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function hasMemoryUpdates(result: RefreshLlmResult): boolean {
  return result.updatedMemoryFiles.length > 0 || result.updatedSummaries.length > 0 || result.memoryFactsAppended.length > 0;
}
