import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reconcileInventoryCoverage } from "./coverage.js";
import { createEmptyInventory, readInventory, writeInventory } from "./inventory.js";

export interface InitApeironResult {
  created: string[];
  inventoryFiles: number;
}

const MEMORY_TEMPLATES: Record<string, string> = {
  "PROJECT.md": "# Project\n\nPurpose: TODO\n\n",
  "MODULES.md": "# Modules\n\nNo modules documented yet.\n\n",
  "CONVENTIONS.md": "# Conventions\n\nNo project conventions documented yet.\n\n",
  "TESTING.md": "# Testing\n\nNo testing commands documented yet.\n\n",
  "MEMORY.md": "# Memory\n\nLong-term maintenance facts only. Do not use this as a task log.\n\n"
};

export async function initApeiron(workspaceRoot: string): Promise<InitApeironResult> {
  const created: string[] = [];
  await ensureDir(path.join(workspaceRoot, ".apeiron"), created);
  await ensureDir(path.join(workspaceRoot, ".apeiron", "memory"), created);
  await ensureDir(path.join(workspaceRoot, ".apeiron", "memory", "modules"), created);
  await ensureDir(path.join(workspaceRoot, ".apeiron", "memory", "files"), created);

  await ensureFile(
    path.join(workspaceRoot, ".apeiron", ".gitignore"),
    "sessions/\ncontext-packs/\nattachments/\n",
    created
  );
  await ensureFile(
    path.join(workspaceRoot, ".apeiron", "ignore.md"),
    "# Apeiron ignore rules\n\n# One pattern per line. These rules affect warmup and coverage scan.\n",
    created
  );

  for (const [fileName, content] of Object.entries(MEMORY_TEMPLATES)) {
    await ensureFile(path.join(workspaceRoot, ".apeiron", "memory", fileName), content, created);
  }

  const existingInventory = await readInventory(workspaceRoot);
  if (!existingInventory) {
    await writeInventory(workspaceRoot, createEmptyInventory("unknown", null));
    created.push(".apeiron/memory/inventory.json");
  }

  const inventory = await reconcileInventoryCoverage(workspaceRoot, await readInventory(workspaceRoot));
  await writeInventory(workspaceRoot, inventory);
  return {
    created,
    inventoryFiles: Object.keys(inventory.files).length
  };
}

async function ensureDir(dirPath: string, created: string[]): Promise<void> {
  if (existsSync(dirPath)) {
    return;
  }
  await fs.mkdir(dirPath, { recursive: true });
  created.push(dirPath);
}

async function ensureFile(filePath: string, content: string, created: string[]): Promise<void> {
  if (existsSync(filePath)) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  created.push(filePath);
}
