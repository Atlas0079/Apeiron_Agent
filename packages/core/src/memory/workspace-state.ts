import { existsSync } from "node:fs";
import path from "node:path";
import { getBlockingTurn, type WorkTurn } from "../session/turn.js";
import { inspectCoverage, type CoverageScanResult, type CoverageStatus } from "./coverage.js";
import { readInventory } from "./inventory.js";

export interface ApeironWorkspaceState {
  initialized: boolean;
  hasApeironDir: boolean;
  hasInventory: boolean;
  coverageStatus: CoverageStatus;
  coverage: CoverageScanResult | null;
  blockingTurn: WorkTurn | null;
  error: string | null;
}

export async function getApeironWorkspaceState(workspaceRoot: string): Promise<ApeironWorkspaceState> {
  const hasApeironDir = existsSync(path.join(workspaceRoot, ".apeiron"));
  const hasInventory = existsSync(path.join(workspaceRoot, ".apeiron", "memory", "inventory.json"));
  if (!hasApeironDir || !hasInventory) {
    return {
      initialized: false,
      hasApeironDir,
      hasInventory,
      coverageStatus: "needs-warmup",
      coverage: null,
      blockingTurn: null,
      error: null
    };
  }

  try {
    const inventory = await readInventory(workspaceRoot);
    if (!inventory) {
      return {
        initialized: false,
        hasApeironDir,
        hasInventory: false,
        coverageStatus: "needs-warmup",
        coverage: null,
        blockingTurn: null,
        error: null
      };
    }
    const coverage = await inspectCoverage(workspaceRoot, inventory);
    const blockingTurn = await getBlockingTurn(workspaceRoot);
    return {
      initialized: true,
      hasApeironDir,
      hasInventory,
      coverageStatus: coverage.status,
      coverage,
      blockingTurn,
      error: null
    };
  } catch (error) {
    return {
      initialized: hasApeironDir && hasInventory,
      hasApeironDir,
      hasInventory,
      coverageStatus: "blocked",
      coverage: null,
      blockingTurn: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
