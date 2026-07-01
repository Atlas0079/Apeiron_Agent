import { readInventory, writeInventory } from "./inventory.js";
import { runMemoryAgent } from "./memory-agent-runner.js";
import type { MemoryAgentToolEvent } from "./memory-agent-tools.js";
import type { ApeironLlmRetryEvent } from "../llm/provider.js";
import { initApeiron } from "./store.js";
import { auditWarmup } from "./warmup-audit.js";
import { fillScopedWarmupUnreadReasons } from "./warmup-inventory.js";
import {
  classifyWarmupError,
  createWarmupProgressSnapshot,
  readWarmupStatus,
  writeWarmupStatus
} from "./warmup-status.js";
import type { WarmupMode } from "./warmup-types.js";

export interface WarmupLlmInput {
  workspaceRoot: string;
  mode: WarmupMode;
  goal?: string;
  scope?: string[];
  maxFiles?: number;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  onToolEvent?: (event: MemoryAgentToolEvent) => void;
  onCommentary?: (commentary: string) => void;
  onLlmRetry?: (event: ApeironLlmRetryEvent) => void;
  llmOptions?: Parameters<typeof runMemoryAgent>[0]["llmOptions"];
}

export interface WarmupLlmResult {
  mode: WarmupMode;
  goal: string;
  scopeHints: string[];
  scopeRationale: string;
  documentedFiles: string[];
  unreadFiles: number;
  writtenMemoryFiles: string[];
  blocked: Array<{ path: string; reason: string }>;
  events: MemoryAgentToolEvent[];
  turns: number;
}

interface WarmupAgentFinish {
  documentedFiles?: string[];
  writtenMemoryFiles?: string[];
  blocked?: Array<{ path: string; reason: string }>;
  scopeRationale?: string;
}

export async function runLlmWarmup(input: WarmupLlmInput): Promise<WarmupLlmResult> {
  await initApeiron(input.workspaceRoot);
  const scopeHints = input.scope?.length ? input.scope : [];
  const goal = input.goal?.trim() || (input.mode === "full" ? "Build complete project memory for the repository." : "Build scoped project memory for the user's current goal.");
  const previous = await readWarmupStatus(input.workspaceRoot);
  const resumeFrom = previous?.phase === "interrupted" && previous.mode === input.mode
    ? {
        interruptedAt: previous.interruptedAt ?? previous.updatedAt,
        completedFiles: previous.completedFiles,
        pendingFiles: previous.pendingFiles,
        error: previous.lastError
      }
    : undefined;
  const startedAt = new Date().toISOString();
  await writeWarmupStatus(input.workspaceRoot, {
    version: 1,
    phase: "running",
    mode: input.mode,
    goal,
    scopeHints,
    startedAt,
    updatedAt: startedAt,
    completedFiles: resumeFrom?.completedFiles ?? [],
    pendingFiles: resumeFrom?.pendingFiles ?? [],
    documentedFiles: [],
    writtenMemoryFiles: [],
    blocked: [],
    resumeFrom
  });
  let result;
  try {
    result = await runMemoryAgent<WarmupAgentFinish>({
      workspaceRoot: input.workspaceRoot,
      maxTurns: input.maxTurns ?? 30,
      maxSearchResults: input.maxFiles ?? 50,
      abortSignal: input.abortSignal,
      onToolEvent: input.onToolEvent,
      onCommentary: input.onCommentary,
      onLlmRetry: input.onLlmRetry,
      llmOptions: input.llmOptions,
      systemPrompt: WARMUP_SYSTEM_PROMPT,
      task: {
        mode: input.mode,
        goal,
        scopeHints,
        maxFilesHint: input.maxFiles,
        completionCriteria: buildCompletionCriteria(input.mode),
        resumeFrom,
        resumeInstruction: resumeFrom
          ? "A previous warmup run was interrupted. Resume from existing inventory and memory. Prioritize pendingFiles and skip already documented/grouped/ignored files unless their inventory is stale or missing a summaryRef."
          : undefined
      },
      audit: async ({ events, finish }) =>
        await auditWarmup({
          workspaceRoot: input.workspaceRoot,
          mode: input.mode,
          readFilesThisRun: readFilesFromEvents(events),
          finish: normalizeWarmupFinish(finish)
        })
    });
  } catch (error) {
    const progress = await createWarmupProgressSnapshot(input.workspaceRoot);
    const interruptedAt = new Date().toISOString();
    await writeWarmupStatus(input.workspaceRoot, {
      version: 1,
      phase: "interrupted",
      mode: input.mode,
      goal,
      scopeHints,
      startedAt,
      updatedAt: interruptedAt,
      interruptedAt,
      completedFiles: progress.completedFiles,
      pendingFiles: progress.pendingFiles,
      documentedFiles: [],
      writtenMemoryFiles: [],
      blocked: [],
      lastError: classifyWarmupError(error),
      resumeFrom
    });
    throw error;
  }
  const inventory = await readInventory(input.workspaceRoot);
  if (!inventory) {
    throw new Error("Inventory missing after warmup init");
  }
  inventory.coverage.mode = input.mode;
  inventory.coverage.scope = scopeHints.length > 0 ? scopeHints : null;
  const finalInventory = input.mode === "scoped" ? fillScopedWarmupUnreadReasons(inventory, scopeHints) : inventory;
  if (input.mode === "scoped") {
    finalInventory.coverage.mode = input.mode;
    finalInventory.coverage.scope = scopeHints.length > 0 ? scopeHints : null;
  } else if (input.mode === "full" && normalizeBlocked(result.finish.blocked).length === 0) {
    finalInventory.coverage.lastFullWarmupAt = new Date().toISOString();
  }
  await writeInventory(input.workspaceRoot, finalInventory);
  const normalizedBlocked = normalizeBlocked(result.finish.blocked);
  const warmupResult = {
    mode: input.mode,
    goal,
    scopeHints,
    scopeRationale: String(result.finish.scopeRationale ?? ""),
    documentedFiles: asStringArray(result.finish.documentedFiles),
    unreadFiles: Object.values(finalInventory.files).filter((entry) => entry.status === "unread").length,
    writtenMemoryFiles: asStringArray(result.finish.writtenMemoryFiles),
    blocked: normalizedBlocked,
    events: result.events,
    turns: result.turns
  };
  const progress = await createWarmupProgressSnapshot(input.workspaceRoot);
  const completedAt = new Date().toISOString();
  await writeWarmupStatus(input.workspaceRoot, {
    version: 1,
    phase: "completed",
    mode: input.mode,
    goal,
    scopeHints,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    completedFiles: progress.completedFiles,
    pendingFiles: progress.pendingFiles,
    documentedFiles: warmupResult.documentedFiles,
    writtenMemoryFiles: warmupResult.writtenMemoryFiles,
    blocked: normalizedBlocked,
    resumeFrom
  });
  return warmupResult;
}

const WARMUP_SYSTEM_PROMPT = `You are Apeiron warmup, an agentic memory maintenance run.

You are not a batch file summarizer. You must explore the repository with tools, decide what to read, write project memory, update inventory, and finish with an audit.

Hard rules:
- Return only valid JSON actions.
- You may read source files and search text. You may write only .apeiron/memory files and inventory entries.
- Do not write temporary task logs into memory.
- MEMORY.md is append-only; use append_memory_fact only for long-term maintenance facts.
- documented/grouped inventory entries must have summaryRef.
- You may mark clearly low-value files ignored without reading contents when the path, extension, or directory makes the reason reliable. Prefer mark_files_ignored for batches, and always provide a concrete reason.
- If a whole file extension should stay outside Apeiron memory, use ignore_extensions so future coverage scans skip it.
- For scoped warmup, the user goal and optional scopeHints are not hard boundaries. You must infer the useful working scope by discussing the goal in your own reasoning, reading enough code to support it, and finishing with scopeRationale.
- For scoped warmup, files outside the explored scope may remain unread, but they need a reason.
- For full warmup, do not finish successfully while unignored files remain unread or without summaryRef.
- The system will send an audit after tool actions. Treat audit.remaining as the next work queue. If finish is rejected, continue addressing the audit.

Suggested strategy:
1. Start with get_coverage_status and list_files.
2. Read top-level README/docs/manifests/configs.
3. For scoped warmup, infer the scope from the goal and evidence. Use scopeHints only as hints.
4. Read runtime/module boundary files and relevant tests/configs until the scoped goal or full coverage is sufficiently supported.
5. Write PROJECT.md, MODULES.md, CONVENTIONS.md, TESTING.md as current-state memory.
6. Write file or grouped module summaries for files you genuinely read and understand.
7. Update inventory entries for documented/grouped/unread/ignored files.
7a. Batch-ignore obvious noise such as logs, generated outputs, caches, binary snapshots, or vendor artifacts when the path evidence is sufficient.
7b. Use ignore_extensions for repeated irrelevant file types rather than marking many individual files.
8. Re-check coverage before finish.
9. Finish with documentedFiles, writtenMemoryFiles, blocked entries, and for scoped warmup scopeRationale.`;

function buildCompletionCriteria(mode: WarmupMode): string[] {
  if (mode === "full") {
    return [
      "Every unignored repo file is documented or grouped, or blocked with reason.",
      "Every documented/grouped file has a summaryRef that exists.",
      "PROJECT/MODULES/CONVENTIONS/TESTING/MEMORY are current and based on read evidence."
    ];
  }
  return [
    "The agent has inferred and explained a scoped boundary from the user's goal, optional hints, and code evidence.",
    "Files read and understood during this scoped warmup are documented or grouped.",
    "Files read but not reliably understood are left unread only if blocked with reason.",
    "Files outside the explored scope may remain unread but should have a clear reason from inventory scan.",
    "PROJECT.md and MODULES.md give a usable coarse project map."
  ];
}

function readFilesFromEvents(events: MemoryAgentToolEvent[]): string[] {
  const readFiles = new Set<string>();
  for (const event of events) {
    if (event.type === "tool-result" && event.tool === "read_file") {
      const result = event.result as { path?: unknown; content?: unknown; ok?: unknown };
      if (typeof result.path === "string" && typeof result.content === "string") {
        readFiles.add(result.path);
      }
    }
  }
  return Array.from(readFiles);
}

function normalizeWarmupFinish(value: unknown): WarmupAgentFinish | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const finish = value as WarmupAgentFinish;
  return {
    scopeRationale: typeof finish.scopeRationale === "string" ? finish.scopeRationale : undefined,
    blocked: normalizeBlocked(finish.blocked)
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeBlocked(value: unknown): Array<{ path: string; reason: string }> {
  return Array.isArray(value)
    ? value.map((item) => ({ path: String(item?.path ?? ""), reason: String(item?.reason ?? "") }))
    : [];
}
