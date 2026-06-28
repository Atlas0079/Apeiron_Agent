import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type InventoryKind =
  | "runtime"
  | "test"
  | "config"
  | "docs"
  | "generated"
  | "asset"
  | "log"
  | "vendor"
  | "unknown";

export type InventoryStatus = "documented" | "grouped" | "ignored" | "unread" | "stale" | "missing-ref";

export interface InventoryCoverage {
  mode: "full" | "scoped" | "opportunistic" | "unknown";
  scope: string[] | null;
  createdAt: string;
  lastFullWarmupAt: string | null;
}

export interface InventoryEntry {
  kind: InventoryKind;
  status: InventoryStatus;
  summaryRef: string | null;
  purpose: string;
  reason: string | null;
  /**
   * Source fingerprint last covered by the memory summary.
   * Coverage scans report the current hash separately and must not treat this
   * as an automatically refreshed workspace hash.
   */
  hash: string | null;
  lastReadAt: string | null;
  lastRefreshAt: string | null;
}

export interface Inventory {
  version: 1;
  workspaceRoot: ".";
  coverage: InventoryCoverage;
  files: Record<string, InventoryEntry>;
}

export function createEmptyInventory(mode: InventoryCoverage["mode"] = "unknown", scope: string[] | null = null): Inventory {
  return {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode,
      scope,
      createdAt: new Date().toISOString(),
      lastFullWarmupAt: null
    },
    files: {}
  };
}

export async function readInventory(workspaceRoot: string): Promise<Inventory | null> {
  const filePath = inventoryPath(workspaceRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Inventory;
  assertInventory(parsed);
  return parsed;
}

export async function writeInventory(workspaceRoot: string, inventory: Inventory): Promise<void> {
  assertInventory(inventory);
  const filePath = inventoryPath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

export function inventoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".apeiron", "memory", "inventory.json");
}

export function createDiscoveredEntry(input: {
  kind: InventoryKind;
  status: InventoryStatus;
  purpose: string;
  reason: string | null;
  hash: string | null;
  summaryRef?: string | null;
  lastReadAt?: string | null;
  lastRefreshAt?: string | null;
}): InventoryEntry {
  return {
    kind: input.kind,
    status: input.status,
    summaryRef: input.summaryRef ?? null,
    purpose: input.purpose,
    reason: input.reason,
    hash: input.hash,
    lastReadAt: input.lastReadAt ?? null,
    lastRefreshAt: input.lastRefreshAt ?? null
  };
}

export function classifyPath(repoPath: string): InventoryKind {
  const lower = repoPath.toLowerCase();
  if (lower.includes("/test/") || lower.includes("/tests/") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    return "test";
  }
  if (lower.endsWith(".md") || lower.startsWith("docs/")) {
    return "docs";
  }
  if (/\.(json|ya?ml|toml|ini|env|config\.[cm]?[jt]s)$/.test(lower) || lower.includes("config")) {
    return "config";
  }
  if (/\.(png|jpe?g|gif|svg|webp|ico|ttf|woff2?)$/.test(lower)) {
    return "asset";
  }
  if (/\.(log|tmp)$/.test(lower)) {
    return "log";
  }
  if (lower.includes("/vendor/") || lower.includes("/third_party/")) {
    return "vendor";
  }
  if (/\.(generated|gen)\./.test(lower) || lower.includes("/generated/")) {
    return "generated";
  }
  if (/\.[cm]?[jt]sx?$/.test(lower)) {
    return "runtime";
  }
  return "unknown";
}

function assertInventory(value: Inventory): void {
  if (value.version !== 1 || value.workspaceRoot !== "." || typeof value.files !== "object") {
    throw new Error("Invalid Apeiron inventory.json");
  }
}
