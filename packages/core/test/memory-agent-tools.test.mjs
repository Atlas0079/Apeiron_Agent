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

test("MemoryAgentTools marks files ignored in batches", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "logs", "debug.log"), "debug\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "snapshot.png"), "not really an image\n", "utf8");
  await writeInventory(
    workspaceRoot,
    inventory({
      "logs/debug.log": entry(),
      "snapshot.png": entry()
    })
  );

  const tools = new MemoryAgentTools({ workspaceRoot });
  const result = await tools.markFilesIgnored(
    ["logs/debug.log", "snapshot.png"],
    "runtime artifact with no long-term maintenance value"
  );

  assert.equal(result.marked.length, 2);
  assert.equal(result.failed.length, 0);
  const after = await readInventory(workspaceRoot);
  assert.equal(after.files["logs/debug.log"].status, "ignored");
  assert.equal(after.files["logs/debug.log"].reason, "runtime artifact with no long-term maintenance value");
  assert.equal(after.files["logs/debug.log"].summaryRef, null);
  assert.equal(after.files["snapshot.png"].status, "ignored");
});

test("MemoryAgentTools writes extension ignore rules without duplicates", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-tools-"));
  await fs.mkdir(path.join(workspaceRoot, ".apeiron"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".apeiron", "ignore.md"),
    "# Apeiron ignore rules\n\n*.png\n",
    "utf8"
  );
  await writeInventory(workspaceRoot, inventory({}));

  const tools = new MemoryAgentTools({ workspaceRoot });
  const result = await tools.ignoreExtensions(
    [".png", "log", "*.zip"],
    "Binary and runtime artifacts do not need long-term memory"
  );

  assert.deepEqual(result.added, ["*.log", "*.zip"]);
  assert.deepEqual(result.skipped, ["*.png"]);
  const ignoreFile = await fs.readFile(path.join(workspaceRoot, ".apeiron", "ignore.md"), "utf8");
  assert.match(ignoreFile, /Binary and runtime artifacts/);
  assert.equal((ignoreFile.match(/\*\.png/g) ?? []).length, 1);
  assert.match(ignoreFile, /\*\.log/);
  assert.match(ignoreFile, /\*\.zip/);
});
