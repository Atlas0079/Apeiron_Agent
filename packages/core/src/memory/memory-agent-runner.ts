import { createPiAiClient } from "../llm/pi-ai-provider.js";
import {
  completeJsonWithRetry,
  readApeironLlmEnv,
  type ApeironLlmMessage,
  type ApeironLlmOptions,
  type ApeironLlmRetryEvent
} from "../llm/provider.js";
import { MemoryAgentTools, type MemoryAgentToolEvent } from "./memory-agent-tools.js";

export interface MemoryAgentAuditResult {
  status: "in-progress" | "ready-to-finish" | "blocked";
  finishAllowed: boolean;
  remaining: unknown[];
  warnings: unknown[];
  blockers: unknown[];
  summary?: unknown;
}

export interface MemoryAgentRunInput {
  workspaceRoot: string;
  systemPrompt: string;
  task: unknown;
  maxTurns?: number;
  maxReadBytes?: number;
  maxSearchResults?: number;
  abortSignal?: AbortSignal;
  onToolEvent?: (event: MemoryAgentToolEvent) => void;
  onCommentary?: (commentary: string) => void;
  onLlmRetry?: (event: ApeironLlmRetryEvent) => void;
  llmOptions?: Partial<ApeironLlmOptions>;
  audit?: (input: { events: MemoryAgentToolEvent[]; finish?: unknown }) => Promise<MemoryAgentAuditResult>;
}

export interface MemoryAgentRunResult<TFinish = unknown> {
  finish: TFinish;
  events: MemoryAgentToolEvent[];
  turns: number;
}

type MemoryAgentAction = { commentary?: string } & (
  | { action: "get_coverage_status" }
  | { action: "list_files"; pattern?: string }
  | { action: "read_file"; path: string }
  | { action: "search_text"; query: string; scope?: string }
  | { action: "get_git_status" }
  | { action: "get_git_diff"; path?: string }
  | { action: "find_summary_for_file"; path: string }
  | { action: "read_memory_file"; path: string }
  | { action: "write_memory_file"; path: string; content: string }
  | { action: "append_memory_fact"; fact: string }
  | { action: "update_inventory_entry"; path: string; patch: Record<string, unknown> }
  | { action: "mark_file_ignored"; path: string; reason: string }
  | { action: "mark_files_ignored"; paths: string[]; reason: string }
  | { action: "ignore_extensions"; extensions: string[]; reason: string }
  | { action: "finish"; result: unknown }
);

export async function runMemoryAgent<TFinish = unknown>(input: MemoryAgentRunInput): Promise<MemoryAgentRunResult<TFinish>> {
  const tools = new MemoryAgentTools({
    workspaceRoot: input.workspaceRoot,
    maxReadBytes: input.maxReadBytes,
    maxSearchResults: input.maxSearchResults,
    abortSignal: input.abortSignal,
    onEvent: input.onToolEvent
  });
  const client = createPiAiClient({ ...readApeironLlmEnv(), ...input.llmOptions });
  const messages: ApeironLlmMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: buildInitialPrompt(input.task) }
  ];

  for (let turn = 0; turn < (input.maxTurns ?? 20); turn += 1) {
    throwIfAborted(input.abortSignal);
    const { raw, parsed: action } = await completeJsonWithRetry<MemoryAgentAction>(client, messages, { ...input.llmOptions, maxTokens: 6000 }, input.onLlmRetry);
    throwIfAborted(input.abortSignal);
    messages.push({ role: "assistant", content: raw });
    emitCommentary(input.onCommentary, action.commentary);
    if (action.action === "finish") {
      const audit = input.audit ? await input.audit({ events: tools.events, finish: action.result }) : undefined;
      if (audit && !audit.finishAllowed) {
        messages.push({
          role: "user",
          content: JSON.stringify(
            {
              finishRejected: true,
              reason: "Memory agent tried to finish before the warmup audit allowed it.",
              audit,
              instruction: "Continue with the next JSON action that addresses remaining/blocking items."
            },
            null,
            2
          )
        });
        continue;
      }
      return { finish: action.result as TFinish, events: tools.events, turns: turn + 1 };
    }
    throwIfAborted(input.abortSignal);
    const result = await executeMemoryAction(tools, action);
    const audit = input.audit ? await input.audit({ events: tools.events }) : undefined;
    messages.push({ role: "user", content: JSON.stringify({ tool: action.action, result, audit }, null, 2) });
  }

  throwIfAborted(input.abortSignal);
  messages.push({
    role: "user",
    content: "Maximum memory-agent turns reached. Return a finish action now with checked, updated, blocked, and any remaining work."
  });
  const { raw, parsed: action } = await completeJsonWithRetry<MemoryAgentAction>(client, messages, { ...input.llmOptions, maxTokens: 4000 }, input.onLlmRetry);
  throwIfAborted(input.abortSignal);
  emitCommentary(input.onCommentary, action.commentary);
  if (action.action !== "finish") {
    throw new Error("Memory agent reached maxTurns and finalization did not return finish");
  }
  return { finish: action.result as TFinish, events: tools.events, turns: input.maxTurns ?? 20 };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Apeiron run aborted");
  }
}

function buildInitialPrompt(task: unknown): string {
  return JSON.stringify(
    {
      instruction:
        "Run as a memory maintenance agent. Return exactly one JSON action per turn. Use tools to inspect repo state and update .apeiron/memory. Finish only after checking completion conditions.",
      commentary:
        "Include a concise commentary string in every action when useful. This commentary is shown directly to the user and should explain what you are doing or what you just learned, without inventing results not supported by tool output.",
      actions: {
        get_coverage_status: { action: "get_coverage_status" },
        list_files: { action: "list_files", pattern: "optional substring" },
        read_file: { action: "read_file", path: "repo/path.ts" },
        search_text: { action: "search_text", query: "text", scope: "optional/repo/path" },
        get_git_status: { action: "get_git_status" },
        get_git_diff: { action: "get_git_diff", path: "optional/repo/path.ts" },
        find_summary_for_file: { action: "find_summary_for_file", path: "repo/path.ts" },
        read_memory_file: { action: "read_memory_file", path: ".apeiron/memory/PROJECT.md" },
        write_memory_file: { action: "write_memory_file", path: ".apeiron/memory/files/src/file.ts.md", content: "markdown" },
        append_memory_fact: { action: "append_memory_fact", fact: "long-term maintenance fact" },
        update_inventory_entry: { action: "update_inventory_entry", path: "repo/path.ts", patch: { status: "documented" } },
        mark_file_ignored: { action: "mark_file_ignored", path: "repo/path", reason: "why this is long-term ignorable" },
        mark_files_ignored: { action: "mark_files_ignored", paths: ["repo/path.log", "generated/file.ts"], reason: "why these files have no long-term maintenance value" },
        ignore_extensions: { action: "ignore_extensions", extensions: [".png", ".log"], reason: "why this file type should stay outside Apeiron memory" },
        finish: { action: "finish", result: {} }
      },
      task
    },
    null,
    2
  );
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

async function executeMemoryAction(tools: MemoryAgentTools, action: MemoryAgentAction): Promise<unknown> {
  switch (action.action) {
    case "get_coverage_status":
      return await tools.getCoverageStatus();
    case "list_files":
      return await tools.listFiles(action.pattern);
    case "read_file":
      return await tools.readFile(action.path);
    case "search_text":
      return await tools.searchText(action.query, action.scope);
    case "get_git_status":
      return await tools.getGitStatus();
    case "get_git_diff":
      return await tools.getGitDiff(action.path);
    case "find_summary_for_file":
      return await tools.findSummaryForFile(action.path);
    case "read_memory_file":
      return await tools.readMemoryFile(action.path);
    case "write_memory_file":
      return await tools.writeMemoryFile(action.path, action.content);
    case "append_memory_fact":
      return await tools.appendMemoryFact(action.fact);
    case "update_inventory_entry":
      return await tools.updateInventoryEntry(action.path, action.patch);
    case "mark_file_ignored":
      return await tools.markFileIgnored(action.path, action.reason);
    case "mark_files_ignored":
      return await tools.markFilesIgnored(action.paths, action.reason);
    case "ignore_extensions":
      return await tools.ignoreExtensions(action.extensions, action.reason);
    default:
      return { ok: false, error: "unsupported memory action" };
  }
}
