import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type TurnPhase = "done" | "blocked";
export type TurnRefreshStatus = "not-needed" | "pending" | "clean" | "updated" | "blocked";

export interface WorkTurn {
  id: string;
  sessionId?: string;
  task: string;
  startedAt: string;
  completedAt: string;
  phase: TurnPhase;
  refreshStatus: TurnRefreshStatus;
  refreshRequired: boolean;
  refreshTargets: string[];
  readFiles: string[];
  modifiedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
}

export interface TurnIndex {
  version: 1;
  turns: WorkTurn[];
}

export async function assertNoBlockingTurn(workspaceRoot: string): Promise<void> {
  const blocking = await getBlockingTurn(workspaceRoot);
  if (!blocking) {
    return;
  }
  throw new Error(
    `Apeiron has a turn blocked on refresh: ${blocking.id}. Run refresh for its targets before starting another work turn.`
  );
}

export async function getBlockingTurn(workspaceRoot: string): Promise<WorkTurn | null> {
  const index = await readTurnIndex(workspaceRoot);
  return index.turns.find((turn) => turn.refreshStatus === "pending" || turn.refreshStatus === "blocked") ?? null;
}

export async function recordTurn(workspaceRoot: string, turn: WorkTurn): Promise<void> {
  const index = await readTurnIndex(workspaceRoot);
  const turns = [turn, ...index.turns.filter((existing) => existing.id !== turn.id)].slice(0, 100);
  await writeTurnIndex(workspaceRoot, { version: 1, turns });
}

export async function markBlockingTurnsRefreshComplete(workspaceRoot: string, status: Exclude<TurnRefreshStatus, "pending">): Promise<WorkTurn[]> {
  const index = await readTurnIndex(workspaceRoot);
  const completed: WorkTurn[] = [];
  const turns = index.turns.map((turn) => {
    if (turn.refreshStatus !== "pending" && turn.refreshStatus !== "blocked") {
      return turn;
    }
    const phase: TurnPhase = status === "blocked" ? "blocked" : "done";
    const next: WorkTurn = {
      ...turn,
      phase,
      refreshStatus: status,
      completedAt: new Date().toISOString()
    };
    completed.push(next);
    return next;
  });
  if (completed.length > 0) {
    await writeTurnIndex(workspaceRoot, { version: 1, turns });
  }
  return completed;
}

export async function readTurnIndex(workspaceRoot: string): Promise<TurnIndex> {
  const filePath = turnIndexPath(workspaceRoot);
  if (!existsSync(filePath)) {
    return { version: 1, turns: [] };
  }
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as TurnIndex;
  if (parsed.version !== 1 || !Array.isArray(parsed.turns)) {
    throw new Error("Invalid Apeiron turns index");
  }
  return parsed;
}

async function writeTurnIndex(workspaceRoot: string, index: TurnIndex): Promise<void> {
  const filePath = turnIndexPath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function turnIndexPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".apeiron", "sessions", "turns.json");
}
