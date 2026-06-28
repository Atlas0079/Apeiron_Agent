import type {
  ApeironCheckpointSummary,
  ApeironSessionIndexEntry,
  ContextItem,
  ContextPack,
  WarmupRunStatus
} from "@apeiron/core";
import type { ProviderSettings, ProviderSettingsInput } from "./providerSettings.js";

export type AgentPhase = "idle" | "warmup" | "context" | "work" | "refresh" | "blocked" | "done" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  attachments?: AttachmentRecord[];
  codeChanges?: string[];
  memoryChanges?: string[];
  tools?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  label: string;
  status: "running" | "ok" | "failed";
  detail?: string;
}

export interface TimelineEvent {
  id: string;
  kind: string;
  summary: string;
  detail: unknown;
  createdAt: string;
}

export interface QueuedInput {
  id: string;
  mode: "steering" | "follow-up";
  content: string;
  createdAt: string;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  kind: "text" | "image";
  path: string;
  messageId?: string;
  preview?: string;
  data?: string;
  mimeType?: string;
}

export interface CoverageNode {
  path: string;
  kind: string;
  status: string;
  summaryRef: string | null;
  reason: string | null;
  purpose: string;
  lastReadAt: string | null;
  lastRefreshAt: string | null;
}

export interface CoverageDetail extends CoverageNode {
}

export interface ChatState {
  phase: AgentPhase;
  workspaceRoot: string;
  statusText: string;
  model: string;
  sessionId?: string;
  turnId?: string;
  refreshStatus?: string;
  contextItems: ContextItem[];
  contextPack?: ContextPack;
  contextBudgetTokens: number;
  contextTokensEstimate: number;
  sessions: ApeironSessionIndexEntry[];
  checkpoints: ApeironCheckpointSummary[];
  codeChanges: string[];
  memoryChanges: string[];
  coverage: CoverageNode[];
  selectedCoverage?: CoverageDetail;
  messages: ChatMessage[];
  events: TimelineEvent[];
  queue: QueuedInput[];
  attachments: AttachmentRecord[];
  blockingTurn?: unknown;
  excludedContextIds: string[];
  latestRefreshSummary?: RefreshSummary;
  coverageFilter: string;
  abortRequested: boolean;
  providerSettings: ProviderSettings;
  providerSettingsStatus?: string;
  warmupStatus?: WarmupRunStatus | null;
}

export interface RefreshSummary {
  checked: number;
  updatedMemoryFiles: string[];
  updatedSummaries: string[];
  blocked: Array<{ path: string; reason: string }>;
  memoryDiffFiles: string[];
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "warmup"; mode: "full" | "scoped"; goal: string }
  | { type: "abort" }
  | { type: "saveProviderSettings"; settings: ProviderSettingsInput }
  | { type: "clearProviderApiKey" }
  | { type: "testProviderSettings" }
  | { type: "queue"; text: string; mode: "steering" | "follow-up" }
  | { type: "refreshTurn" }
  | { type: "createContext"; task: string }
  | { type: "toggleContext"; id: string; included: boolean }
  | { type: "selectCoverage"; path: string }
  | { type: "addCoverageToContext"; path: string }
  | { type: "openSummary"; path: string }
  | { type: "addFileToContext" }
  | { type: "selectSession"; id: string }
  | { type: "selectCheckpoint"; sessionId: string; checkpointId: string }
  | { type: "openChanges"; scope: "all" | "code" | "memory" }
  | { type: "openDiff"; path: string }
  | { type: "uploadAttachment" }
  | { type: "setCoverageFilter"; filter: string }
  | { type: "editMessage"; id: string }
  | { type: "openSource"; path: string };
