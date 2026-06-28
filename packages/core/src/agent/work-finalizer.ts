import type { ContextPack } from "../memory/context-pack.js";
import { readInventory } from "../memory/inventory.js";
import type { MemoryDiffSummary } from "../memory/memory-diff.js";
import type { MemoryAgentToolEvent } from "../memory/memory-agent-tools.js";
import type { ApeironLlmOptions, ApeironLlmRetryEvent } from "../llm/provider.js";
import { runLlmRefresh, type RefreshLlmResult } from "../memory/refresh-runner.js";
import { resolveRefreshTargets } from "../memory/refresh-target-policy.js";
import type { RefreshTarget } from "../memory/refresh-targets.js";
import { getGitStatus, type GitStatus } from "../repo/git.js";
import { appendSessionContextPack, appendSessionEvent, type ApeironSessionHandle } from "../session/store.js";
import { recordTurn, type WorkTurn } from "../session/turn.js";
import type { TrackedRepoTools, TrackedToolEvent } from "../tools/tracked-repo-tools.js";
import { createTurnChangeBoundary } from "./turn-change-boundary.js";

export interface FinalizeWorkRunInput {
  workspaceRoot: string;
  task: string;
  answer: string;
  autoRefresh?: boolean;
  tools: TrackedRepoTools;
  contextPack: ContextPack;
  beforeStatus: GitStatus | undefined;
  session: ApeironSessionHandle | undefined;
  persistedToolEventCount: number;
  turnStartedAt: string;
  abortSignal?: AbortSignal;
  onRefreshToolEvent?: (event: MemoryAgentToolEvent) => void;
  onLlmRetry?: (event: ApeironLlmRetryEvent) => void;
  llmOptions?: Partial<ApeironLlmOptions>;
}

export interface FinalizedWorkRun {
  answer: string;
  changed: boolean;
  refreshTargets: RefreshTarget[];
  turn: WorkTurn;
  refreshResult?: RefreshLlmResult;
  memoryDiffSummary?: MemoryDiffSummary;
  events: TrackedToolEvent[];
  contextPack: ContextPack;
  sessionId?: string;
  sessionPath?: string;
}

export async function finalizeWorkRun(input: FinalizeWorkRunInput): Promise<FinalizedWorkRun> {
  const afterStatus = await getGitStatus(input.workspaceRoot).catch(() => undefined);
  const turnBoundary = await createTurnChangeBoundary({
    workspaceRoot: input.workspaceRoot,
    beforeStatus: input.beforeStatus,
    afterStatus,
    trackedTargets: input.tools.listRefreshTargets()
  });
  const inventory = await readInventory(input.workspaceRoot);
  const targets = resolveRefreshTargets({
    inventory,
    targetGroups: [turnBoundary.refreshTargets]
  });
  await persistNewToolEvents(input.workspaceRoot, input.session, input.tools.events, input.persistedToolEventCount);

  const refreshRequired = targets.length > 0;
  if (input.session) {
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "turn-change-boundary",
      boundary: turnBoundary,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "refresh-targets",
      targets,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "phase",
      phase: targets.length > 0 && input.autoRefresh !== false ? "refresh" : "done",
      summary: targets.length > 0 && input.autoRefresh !== false ? "Running automatic refresh" : "No automatic refresh needed",
      createdAt: new Date().toISOString()
    });
  }

  const refreshResult =
    input.autoRefresh === false || targets.length === 0
      ? undefined
      : await runLlmRefresh({
          workspaceRoot: input.workspaceRoot,
          targets,
          abortSignal: input.abortSignal,
          onToolEvent: input.onRefreshToolEvent,
          onLlmRetry: input.onLlmRetry,
          llmOptions: input.llmOptions
        });
  const refreshStatus = deriveRefreshStatus(refreshRequired, input.autoRefresh !== false, refreshResult);
  const turnPhase = refreshStatus === "blocked" || refreshStatus === "pending" ? "blocked" : "done";
  const turn = buildTurn({
    startedAt: input.turnStartedAt,
    sessionId: input.session?.id,
    task: input.task,
    phase: turnPhase,
    refreshStatus,
    refreshRequired,
    refreshTargets: targets,
    events: input.tools.events
  });

  await recordTurn(input.workspaceRoot, turn);
  if (input.session && refreshResult) {
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "refresh-result",
      result: refreshResult,
      createdAt: new Date().toISOString()
    });
  }
  if (input.session) {
    await appendSessionContextPack(input.workspaceRoot, input.session, input.contextPack);
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "turn",
      turn,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "message",
      role: "assistant",
      content: input.answer,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "checkpoint",
      id: `checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      label: "work-run-complete",
      summary: input.answer.slice(0, 500),
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, input.session, {
      type: "phase",
      phase: turnPhase,
      summary: turnPhase === "done" ? "Work run completed" : "Work run is blocked until refresh completes",
      createdAt: new Date().toISOString()
    });
  }

  return {
    answer: input.answer,
    changed: Boolean(input.beforeStatus && afterStatus && JSON.stringify(input.beforeStatus.changes) !== JSON.stringify(afterStatus.changes)),
    refreshTargets: targets,
    turn,
    refreshResult,
    memoryDiffSummary: refreshResult?.memoryDiffSummary,
    events: input.tools.events,
    contextPack: input.contextPack,
    sessionId: input.session?.id,
    sessionPath: input.session?.path
  };
}

export async function persistNewToolEvents(
  workspaceRoot: string,
  session: ApeironSessionHandle | undefined,
  events: TrackedToolEvent[],
  startIndex: number
): Promise<number> {
  if (!session) {
    return events.length;
  }
  for (const event of events.slice(startIndex)) {
    await appendSessionEvent(workspaceRoot, session, {
      type: "tool-event",
      event,
      createdAt: new Date().toISOString()
    });
  }
  return events.length;
}

function deriveRefreshStatus(
  refreshRequired: boolean,
  autoRefreshEnabled: boolean,
  refreshResult: RefreshLlmResult | undefined
): WorkTurn["refreshStatus"] {
  if (!refreshRequired) {
    return "not-needed";
  }
  if (!autoRefreshEnabled || !refreshResult) {
    return "pending";
  }
  if (refreshResult.blocked.length > 0) {
    return "blocked";
  }
  return refreshResult.updatedMemoryFiles.length > 0 || refreshResult.updatedSummaries.length > 0 || refreshResult.memoryFactsAppended.length > 0
    ? "updated"
    : "clean";
}

function buildTurn(input: {
  startedAt: string;
  sessionId?: string;
  task: string;
  phase: WorkTurn["phase"];
  refreshStatus: WorkTurn["refreshStatus"];
  refreshRequired: boolean;
  refreshTargets: RefreshTarget[];
  events: TrackedToolEvent[];
}): WorkTurn {
  const files = {
    readFiles: new Set<string>(),
    modifiedFiles: new Set<string>(),
    createdFiles: new Set<string>(),
    deletedFiles: new Set<string>()
  };
  for (const event of input.events) {
    if (event.type !== "tool-result") {
      continue;
    }
    if (event.tool === "read_file" && event.ok) {
      files.readFiles.add(event.path);
    }
    if (event.tool === "write_file" && event.ok) {
      if (event.created) {
        files.createdFiles.add(event.path);
      } else {
        files.modifiedFiles.add(event.path);
      }
    }
    if (event.tool === "delete_file" && event.ok) {
      files.deletedFiles.add(event.path);
    }
  }
  return {
    id: `turn-${input.startedAt.replace(/[:.]/g, "-")}`,
    sessionId: input.sessionId,
    task: input.task,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    phase: input.phase,
    refreshStatus: input.refreshStatus,
    refreshRequired: input.refreshRequired,
    refreshTargets: input.refreshTargets.map((target) => target.path).sort(),
    readFiles: Array.from(files.readFiles).sort(),
    modifiedFiles: Array.from(files.modifiedFiles).sort(),
    createdFiles: Array.from(files.createdFiles).sort(),
    deletedFiles: Array.from(files.deletedFiles).sort()
  };
}
