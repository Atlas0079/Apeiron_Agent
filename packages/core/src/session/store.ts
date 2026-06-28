import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContextPack } from "../memory/context-pack.js";
import type { RefreshLlmResult } from "../memory/refresh-runner.js";
import type { RefreshTarget } from "../memory/refresh-targets.js";
import type { TrackedToolEvent } from "../tools/tracked-repo-tools.js";
import type { TurnChangeBoundaryResult } from "../agent/turn-change-boundary.js";
import type { WorkTurn } from "./turn.js";

export type SessionPhase = "context" | "work" | "refresh" | "done" | "blocked";

export interface ApeironSessionUiSnapshot {
  version: 1;
  messages: unknown[];
  attachments: unknown[];
  codeChanges: string[];
  memoryChanges: string[];
  contextPack?: ContextPack;
  latestRefreshSummary?: unknown;
}

export interface ApeironSessionIndexEntry {
  id: string;
  path: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  checkpointCount: number;
}

export interface ApeironSessionHandle {
  id: string;
  path: string;
}

export interface ApeironCheckpointSummary {
  id: string;
  sessionId: string;
  label: string;
  summary: string;
  messageIndex: number;
  createdAt: string;
  hasSnapshot: boolean;
  snapshot?: ApeironSessionUiSnapshot;
}

export type ApeironSessionEvent =
  | { type: "session-start"; id: string; cwd: string; task: string; createdAt: string }
  | { type: "message"; role: "user" | "assistant"; content: string; createdAt: string }
  | { type: "phase"; phase: SessionPhase; summary: string; createdAt: string }
  | { type: "context-pack"; contextPack: ContextPack; createdAt: string }
  | { type: "tool-event"; event: TrackedToolEvent; createdAt: string }
  | { type: "turn-change-boundary"; boundary: TurnChangeBoundaryResult; createdAt: string }
  | { type: "refresh-targets"; targets: RefreshTarget[]; createdAt: string }
  | { type: "refresh-result"; result: RefreshLlmResult; createdAt: string }
  | { type: "turn"; turn: WorkTurn; createdAt: string }
  | { type: "checkpoint"; id: string; label: string; summary: string; messageIndex?: number; createdAt: string }
  | { type: "checkpoint-snapshot"; checkpointId: string; snapshot: ApeironSessionUiSnapshot; createdAt: string };

export async function createSession(input: { workspaceRoot: string; task: string; title?: string }): Promise<ApeironSessionHandle> {
  const id = `session-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const relativePath = `.apeiron/sessions/${id}.jsonl`;
  const absolutePath = path.join(input.workspaceRoot, ".apeiron", "sessions", `${id}.jsonl`);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const now = new Date().toISOString();
  const handle = { id, path: relativePath };
  await appendSessionEvent(input.workspaceRoot, handle, {
    type: "session-start",
    id,
    cwd: input.workspaceRoot,
    task: input.task,
    createdAt: now
  });
  await updateSessionIndex(input.workspaceRoot, {
    id,
    path: relativePath,
    cwd: input.workspaceRoot,
    createdAt: now,
    updatedAt: now,
    title: input.title ?? input.task.slice(0, 120),
    checkpointCount: 0
  });
  return handle;
}

export async function appendSessionEvent(
  workspaceRoot: string,
  handle: ApeironSessionHandle,
  event: ApeironSessionEvent
): Promise<void> {
  const absolutePath = path.join(workspaceRoot, handle.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.appendFile(absolutePath, `${JSON.stringify(event)}\n`, "utf8");
  await touchSessionIndex(workspaceRoot, handle.id, event.type === "checkpoint");
}

export async function readSessionEvents(workspaceRoot: string, sessionId: string): Promise<ApeironSessionEvent[]> {
  const absolutePath = path.join(workspaceRoot, ".apeiron", "sessions", `${sessionId}.jsonl`);
  if (!existsSync(absolutePath)) {
    return [];
  }
  const content = await fs.readFile(absolutePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApeironSessionEvent);
}

export async function readLatestSessionContextPack(workspaceRoot: string, sessionId: string): Promise<ContextPack | null> {
  const events = await readSessionEvents(workspaceRoot, sessionId);
  for (const event of events.slice().reverse()) {
    if (event.type === "context-pack") {
      return event.contextPack;
    }
  }
  return null;
}

export async function readSessionCheckpoints(workspaceRoot: string, sessionId: string): Promise<ApeironCheckpointSummary[]> {
  const events = await readSessionEvents(workspaceRoot, sessionId);
  let messageIndex = 0;
  const checkpoints: ApeironCheckpointSummary[] = [];
  const snapshots = new Map<string, ApeironSessionUiSnapshot>();
  for (const event of events) {
    if (event.type === "message") {
      messageIndex += 1;
    }
    if (event.type === "checkpoint-snapshot") {
      snapshots.set(event.checkpointId, event.snapshot);
      const checkpoint = checkpoints.find((item) => item.id === event.checkpointId);
      if (checkpoint) {
        checkpoint.hasSnapshot = true;
        checkpoint.snapshot = event.snapshot;
      }
    }
    if (event.type === "checkpoint") {
      const snapshot = snapshots.get(event.id);
      checkpoints.push({
        id: event.id,
        sessionId,
        label: event.label,
        summary: event.summary,
        messageIndex: event.messageIndex ?? messageIndex,
        createdAt: event.createdAt,
        hasSnapshot: Boolean(snapshot),
        snapshot
      });
    }
  }
  return checkpoints;
}

export async function appendSessionContextPack(
  workspaceRoot: string,
  handle: ApeironSessionHandle,
  contextPack: ContextPack
): Promise<void> {
  await appendSessionEvent(workspaceRoot, handle, {
    type: "context-pack",
    contextPack,
    createdAt: new Date().toISOString()
  });
}

export async function readSessionIndex(workspaceRoot: string): Promise<ApeironSessionIndexEntry[]> {
  const indexPath = sessionIndexPath(workspaceRoot);
  if (!existsSync(indexPath)) {
    return [];
  }
  const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as { sessions?: ApeironSessionIndexEntry[] };
  return Array.isArray(parsed.sessions) ? parsed.sessions : [];
}

async function touchSessionIndex(workspaceRoot: string, sessionId: string, checkpointAdded: boolean): Promise<void> {
  const entries = await readSessionIndex(workspaceRoot);
  const index = entries.findIndex((entry) => entry.id === sessionId);
  if (index < 0) {
    return;
  }
  entries[index] = {
    ...entries[index],
    updatedAt: new Date().toISOString(),
    checkpointCount: entries[index].checkpointCount + (checkpointAdded ? 1 : 0)
  };
  await writeSessionIndex(workspaceRoot, entries);
}

async function updateSessionIndex(workspaceRoot: string, entry: ApeironSessionIndexEntry): Promise<void> {
  const entries = await readSessionIndex(workspaceRoot);
  const filtered = entries.filter((existing) => existing.id !== entry.id);
  await writeSessionIndex(workspaceRoot, [entry, ...filtered]);
}

async function writeSessionIndex(workspaceRoot: string, sessions: ApeironSessionIndexEntry[]): Promise<void> {
  const indexPath = sessionIndexPath(workspaceRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
}

function sessionIndexPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".apeiron", "sessions", "index.json");
}
