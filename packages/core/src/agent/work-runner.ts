import { createPiAiClient } from "../llm/pi-ai-provider.js";
import {
  completeWithRetry,
  extractJsonObject,
  readApeironLlmEnv,
  type ApeironLlmMessage,
  type ApeironLlmOptions,
  type ApeironLlmRetryEvent
} from "../llm/provider.js";
import {
  createContextItem,
  createContextPack,
  enabledContextItems,
  updateContextPack,
  type ContextItem,
  type ContextPack
} from "../memory/context-pack.js";
import type { ApeironLlmContentPart } from "../llm/provider.js";
import { resolveApeironConfig, type ApeironConfig } from "../config.js";
import type { MemoryAgentToolEvent } from "../memory/memory-agent-tools.js";
import type { MemoryDiffSummary } from "../memory/memory-diff.js";
import { inspectCoverage } from "../memory/coverage.js";
import { readInventory } from "../memory/inventory.js";
import type { RefreshLlmResult } from "../memory/refresh-runner.js";
import type { RefreshTarget } from "../memory/refresh-targets.js";
import { getGitStatus } from "../repo/git.js";
import { appendSessionEvent, createSession } from "../session/store.js";
import { assertNoBlockingTurn, type WorkTurn } from "../session/turn.js";
import { TrackedRepoTools, type TrackedToolEvent } from "../tools/tracked-repo-tools.js";
import { finalizeWorkRun, persistNewToolEvents } from "./work-finalizer.js";

export interface WorkRunInput {
  workspaceRoot: string;
  task: string;
  contextPack?: ContextPack;
  contextItemsOverride?: ContextItem[];
  queuedInputs?: WorkQueuedInput[];
  liveInputQueue?: WorkInputQueue;
  imageAttachments?: WorkImageAttachment[];
  priorityPaths?: string[];
  maxTurns?: number;
  maxSearchResults?: number;
  maxReadBytes?: number;
  commandTimeoutMs?: number;
  autoRefresh?: boolean;
  config?: Partial<ApeironConfig>;
  persistSession?: boolean;
  abortSignal?: AbortSignal;
  onToolEvent?: (event: TrackedToolEvent) => void;
  onCommentary?: (commentary: string) => void;
  onLlmRetry?: (event: ApeironLlmRetryEvent) => void;
  onRefreshToolEvent?: (event: MemoryAgentToolEvent) => void;
  llmOptions?: Partial<ApeironLlmOptions>;
}

export interface WorkQueuedInput {
  mode: "steering" | "follow-up";
  content: string;
  createdAt?: string;
}

export interface WorkImageAttachment {
  name: string;
  data: string;
  mimeType: string;
}

export interface WorkInputQueue {
  push(input: WorkQueuedInput): void;
  drain(): WorkQueuedInput[];
}

export function createWorkInputQueue(initial: WorkQueuedInput[] = []): WorkInputQueue {
  const queue = [...initial];
  return {
    push(input) {
      queue.push(input);
    },
    drain() {
      return queue.splice(0, queue.length);
    }
  };
}

export interface WorkRunResult {
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

type WorkAction = { commentary?: string } & (
  | { action: "read_file"; path: string }
  | { action: "search_text"; query: string; scope?: string }
  | { action: "write_file"; path: string; content: string }
  | { action: "delete_file"; path: string }
  | { action: "run_command"; command: string }
  | { action: "final"; answer: string }
);

export async function runLlmWork(input: WorkRunInput): Promise<WorkRunResult> {
  const turnStartedAt = new Date().toISOString();
  const config = resolveApeironConfig(input.config);
  await assertNoBlockingTurn(input.workspaceRoot);
  const inventory = await readInventory(input.workspaceRoot);
  if (!inventory) {
    throw new Error("Missing .apeiron/memory/inventory.json. Run warmup first.");
  }
  const coverage = await inspectCoverage(input.workspaceRoot, inventory);
  const contextPack = await createContextPack({
    task: input.task,
    workspaceRoot: input.workspaceRoot,
    inventory: coverage.inventory,
    coverage,
    priorityPaths: input.priorityPaths,
    existingPack: input.contextPack
  });
  let effectiveContextPack = input.contextItemsOverride
    ? updateContextPack(contextPack, { items: input.contextItemsOverride })
    : contextPack;
  const session = input.persistSession === false ? undefined : await createSession({ workspaceRoot: input.workspaceRoot, task: input.task });
  if (session) {
    await appendSessionEvent(input.workspaceRoot, session, {
      type: "message",
      role: "user",
      content: input.task,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, session, {
      type: "context-pack",
      contextPack: effectiveContextPack,
      createdAt: new Date().toISOString()
    });
    await appendSessionEvent(input.workspaceRoot, session, {
      type: "phase",
      phase: "work",
      summary: "Starting LLM work loop",
      createdAt: new Date().toISOString()
    });
  }
  const tools = new TrackedRepoTools({
    workspaceRoot: input.workspaceRoot,
    maxReadBytes: input.maxReadBytes,
    maxSearchResults: input.maxSearchResults,
    commandTimeoutMs: input.commandTimeoutMs,
    abortSignal: input.abortSignal,
    onEvent: input.onToolEvent
  });
  const beforeStatus = await getGitStatus(input.workspaceRoot).catch(() => undefined);
  const client = createPiAiClient({ ...readApeironLlmEnv(), ...input.llmOptions });
  const messages: ApeironLlmMessage[] = [
    {
      role: "system",
      content:
        "You are Apeiron work agent. Return only valid JSON actions. Use tools to inspect and edit the repo. Do not edit .apeiron memory files; refresh updates memory after work. Prefer small, targeted changes and run validation commands when useful."
    },
    {
      role: "user",
      content: buildInitialPrompt(input.task, effectiveContextPack, input.queuedInputs ?? [], input.imageAttachments ?? [], config)
    }
  ];
  let persistedToolEventCount = 0;

  for (let turn = 0; turn < (input.maxTurns ?? 12); turn += 1) {
    throwIfAborted(input.abortSignal);
    appendLiveInputs(messages, input.liveInputQueue?.drain() ?? []);
    const raw = await completeWithRetry(client, messages, { ...input.llmOptions, maxTokens: 6000 }, input.onLlmRetry);
    throwIfAborted(input.abortSignal);
    messages.push({ role: "assistant", content: raw });
    const action = extractJsonObject<WorkAction>(raw);
    emitCommentary(input.onCommentary, action.commentary);
    if (action.action === "final") {
      return await finalizeWorkRun({
        workspaceRoot: input.workspaceRoot,
        task: input.task,
        answer: action.answer,
        autoRefresh: input.autoRefresh,
        tools,
        contextPack: effectiveContextPack,
        beforeStatus,
        session,
        persistedToolEventCount,
        turnStartedAt,
        abortSignal: input.abortSignal,
        onRefreshToolEvent: input.onRefreshToolEvent,
        onLlmRetry: input.onLlmRetry,
        llmOptions: input.llmOptions
      });
    }
    throwIfAborted(input.abortSignal);
    const toolResult = await executeAction(tools, action);
    effectiveContextPack = growContextPackFromToolResult(effectiveContextPack, action, toolResult);
    persistedToolEventCount = await persistNewToolEvents(input.workspaceRoot, session, tools.events, persistedToolEventCount);
    messages.push({ role: "user", content: JSON.stringify(toolResult, null, 2) });
  }

  throwIfAborted(input.abortSignal);
  messages.push({
    role: "user",
    content: "Maximum tool turns reached. Return a final JSON action now: {\"action\":\"final\",\"answer\":\"...\"}."
  });
  const raw = await completeWithRetry(client, messages, { ...input.llmOptions, maxTokens: 3000 }, input.onLlmRetry);
  throwIfAborted(input.abortSignal);
  const action = extractJsonObject<WorkAction>(raw);
  emitCommentary(input.onCommentary, action.commentary);
  if (action.action !== "final") {
    throw new Error("Work loop reached maxTurns and finalization did not return final action");
  }
  return await finalizeWorkRun({
    workspaceRoot: input.workspaceRoot,
    task: input.task,
    answer: action.answer,
    autoRefresh: input.autoRefresh,
    tools,
    contextPack: effectiveContextPack,
    beforeStatus,
    session,
    persistedToolEventCount,
    turnStartedAt,
    abortSignal: input.abortSignal,
    onRefreshToolEvent: input.onRefreshToolEvent,
    onLlmRetry: input.onLlmRetry,
    llmOptions: input.llmOptions
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Apeiron run aborted");
  }
}

function appendLiveInputs(messages: ApeironLlmMessage[], queuedInputs: WorkQueuedInput[]): void {
  for (const item of queuedInputs) {
    const label = item.mode === "steering" ? "Steering" : "Follow-up";
    messages.push({
      role: "user",
      content: JSON.stringify(
        {
          type: item.mode,
          instruction:
            item.mode === "steering"
              ? "Apply this steering to the current work immediately before choosing the next action."
              : "Treat this as follow-up work. Address it after the current task if it is safe; otherwise mention it in final as queued follow-up.",
          content: item.content,
          createdAt: item.createdAt ?? new Date().toISOString(),
          label
        },
        null,
        2
      )
    });
  }
}

function buildInitialPrompt(
  task: string,
  contextPack: ContextPack,
  queuedInputs: WorkQueuedInput[],
  imageAttachments: WorkImageAttachment[],
  config: ApeironConfig
): string | ApeironLlmContentPart[] {
  const includedContextPack = {
    ...contextPack,
    items: enabledContextItems(contextPack)
  };
  const text = JSON.stringify(
    {
      instruction:
        "Complete the task by returning one JSON action per turn. Available actions: read_file, search_text, write_file, delete_file, run_command, final. write_file replaces the entire file content. Paths must be repo-relative. Do not modify .apeiron memory files.",
      commentary:
        "Include a concise commentary string in every action when useful. This commentary is shown directly to the user and should explain what you are doing or what you just learned, without inventing results not supported by tool output.",
      messageLayout:
        "System message contains agent behavior rules. This user message contains the user's task plus enabled contextPack items for this model call. Later tool results are returned as user messages. Context items are not separate chat turns.",
      queuedInputs: queuedInputs.map((item) => ({
        mode: item.mode,
        content: item.content,
        createdAt: item.createdAt ?? null
      })),
      queuedInputSemantics:
        "steering messages should affect the current work plan immediately. follow-up messages are user requests to address after the current task if they fit safely in this run; otherwise mention they remain follow-up work in final.",
      warmupExpansion: {
        autoExpandWarmup: config.autoExpandWarmup,
        maxWarmupExpansionFilesPerRun: config.maxWarmupExpansionFilesPerRun,
        instruction:
          config.autoExpandWarmup === "always"
            ? "You may read additional unread files when they are directly useful for the current task. Keep expansion focused and within the max file hint."
            : config.autoExpandWarmup === "ask"
              ? "Do not read additional unread files for warmup expansion without user approval. If expansion would help, finish or queue a clear request naming paths and reasons."
              : "Do not intentionally expand warmup into additional unread files. Use the provided context and targeted reads needed for the coding task."
      },
      schemas: {
        read_file: { action: "read_file", path: "repo/path.ts" },
        search_text: { action: "search_text", query: "text", scope: "optional/repo/path" },
        write_file: { action: "write_file", path: "repo/path.ts", content: "complete new file content" },
        delete_file: { action: "delete_file", path: "repo/path.ts" },
        run_command: { action: "run_command", command: "npm test" },
        final: { action: "final", answer: "short user-facing summary and validation" }
      },
      task,
      contextPackForThisModelCall: includedContextPack,
      imageAttachments: imageAttachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType
      }))
    },
    null,
    2
  );
  if (imageAttachments.length === 0) {
    return text;
  }
  return [
    { type: "text", text },
    ...imageAttachments.map((attachment) => ({
      type: "image" as const,
      data: attachment.data,
      mimeType: attachment.mimeType
    }))
  ];
}

function emitCommentary(onCommentary: ((commentary: string) => void) | undefined, commentary: unknown): void {
  if (typeof commentary !== "string") {
    return;
  }
  const trimmed = commentary.trim();
  if (trimmed) {
    onCommentary?.(trimmed);
  }
}

async function executeAction(tools: TrackedRepoTools, action: WorkAction): Promise<unknown> {
  if (action.action === "read_file") {
    return { tool: action.action, path: action.path, result: await tools.readFile(action.path) };
  }
  if (action.action === "search_text") {
    return { tool: action.action, query: action.query, results: await tools.searchText(action.query, action.scope) };
  }
  if (action.action === "write_file") {
    return { tool: action.action, path: action.path, result: await tools.writeFile(action.path, String(action.content ?? "")) };
  }
  if (action.action === "delete_file") {
    return { tool: action.action, path: action.path, result: await tools.deleteFile(action.path) };
  }
  if (action.action === "run_command") {
    return { tool: action.action, command: action.command, result: await tools.runCommand(action.command) };
  }
  return { error: "unsupported action" };
}

function growContextPackFromToolResult(contextPack: ContextPack, action: WorkAction, toolResult: unknown): ContextPack {
  const item = createContextItemFromToolResult(action, toolResult);
  return item ? updateContextPack(contextPack, { items: [item] }) : contextPack;
}

function createContextItemFromToolResult(action: WorkAction, toolResult: unknown): ContextItem | null {
  if (action.action === "final") {
    return null;
  }
  const now = new Date().toISOString();
  if (action.action === "read_file") {
    const result = toolResult as { result?: { ok?: boolean; content?: string; error?: string } };
    return createContextItem({
      type: "file",
      source: action.path,
      title: `Read file: ${action.path}`,
      summary: result.result?.ok ? `Agent read ${action.path}.` : `Read failed: ${result.result?.error ?? "unknown error"}`,
      content: result.result?.ok ? result.result.content : undefined,
      enabled: Boolean(result.result?.ok),
      autoAdded: true,
      addedBy: "agent",
      reason: "Agent read this file during the conversation.",
      createdAt: now,
      excludedReason: result.result?.ok ? undefined : "read-failed"
    });
  }
  if (action.action === "search_text") {
    const result = toolResult as { results?: unknown[] };
    return createContextItem({
      type: "tool-result",
      source: `search:${action.scope ?? "."}:${action.query}`,
      title: `Search: ${action.query}`,
      summary: `Search returned ${result.results?.length ?? 0} result(s).`,
      content: JSON.stringify(result.results ?? [], null, 2),
      enabled: true,
      autoAdded: true,
      addedBy: "agent",
      reason: "Agent searched the repository during the conversation.",
      createdAt: now
    });
  }
  if (action.action === "write_file") {
    const result = toolResult as { result?: { ok?: boolean; created?: boolean; error?: string } };
    return createContextItem({
      type: "diff",
      source: action.path,
      title: `${result.result?.created ? "Created" : "Modified"} file: ${action.path}`,
      summary: result.result?.ok
        ? `Agent ${result.result.created ? "created" : "modified"} ${action.path}.`
        : `Write failed: ${result.result?.error ?? "unknown error"}`,
      enabled: true,
      autoAdded: true,
      addedBy: "agent",
      reason: "Agent changed this file during the conversation.",
      createdAt: now
    });
  }
  if (action.action === "delete_file") {
    const result = toolResult as { result?: { ok?: boolean; error?: string } };
    return createContextItem({
      type: "diff",
      source: action.path,
      title: `Deleted file: ${action.path}`,
      summary: result.result?.ok ? `Agent deleted ${action.path}.` : `Delete failed: ${result.result?.error ?? "unknown error"}`,
      enabled: true,
      autoAdded: true,
      addedBy: "agent",
      reason: "Agent changed the workspace during the conversation.",
      createdAt: now
    });
  }
  if (action.action === "run_command") {
    const result = toolResult as { result?: { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean } };
    const content = JSON.stringify(result.result ?? {}, null, 2);
    return createContextItem({
      type: "tool-result",
      source: `command:${action.command}`,
      title: `Command: ${action.command}`,
      summary: `Command exited ${result.result?.exitCode ?? "unknown"}${result.result?.timedOut ? " and timed out" : ""}.`,
      content,
      enabled: result.result?.exitCode !== 0,
      autoAdded: true,
      addedBy: "agent",
      reason: result.result?.exitCode === 0 ? "Successful command result is available for review." : "Failed command output may matter for the next model call.",
      createdAt: now
    });
  }
  return null;
}
