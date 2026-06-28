import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInventory, writeInventory } from "../dist/memory/inventory.js";
import { MemoryAgentTools } from "../dist/memory/memory-agent-tools.js";

function inventory(files) {
  return {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "scoped",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files
  };
}

function entry() {
  return {
    kind: "runtime",
    status: "unread",
    summaryRef: null,
    purpose: "test file",
    reason: "read-deferred",
    hash: null,
    lastReadAt: null,
    lastRefreshAt: null
  };
}

test("MemoryAgentTools updates lastReadAt and lastRefreshAt", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");
  await writeInventory(
    workspaceRoot,
    inventory({
      "src.ts": entry()
    })
  );

  const tools = new MemoryAgentTools({ workspaceRoot });
  const readResult = await tools.readFile("src.ts");
  assert.equal(readResult.path, "src.ts");

  const afterRead = await readInventory(workspaceRoot);
  assert.match(afterRead.files["src.ts"].lastReadAt, /^\d{4}-/);
  assert.equal(afterRead.files["src.ts"].lastRefreshAt, null);

  await tools.updateInventoryEntry("src.ts", {
    status: "documented",
    summaryRef: ".apeiron/memory/files/src.ts.md"
  });

  const afterUpdate = await readInventory(workspaceRoot);
  assert.match(afterUpdate.files["src.ts"].lastRefreshAt, /^\d{4}-/);
});
