import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContextPack, createContextItem, enabledContextItems, revalidateContextPack, updateContextPack } from "../dist/memory/context-pack.js";

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

function coverage(status = "ready", issues = []) {
  const currentInventory = inventory({});
  return {
    status,
    issues,
    inventory: currentInventory,
    reconciledInventory: currentInventory
  };
}

function entry(purpose, summaryRef) {
  return {
    kind: "runtime",
    status: "documented",
    summaryRef,
    purpose,
    reason: null,
    hash: "sha256:test",
    lastReadAt: null,
    lastRefreshAt: null
  };
}

test("createContextPack starts as a thin tray instead of task keyword matching summaries", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-context-"));
  await writeMemory(workspaceRoot, "PROJECT.md", "# Project\n");
  await writeMemory(workspaceRoot, "MODULES.md", "# Modules\n");
  await writeMemory(workspaceRoot, "CONVENTIONS.md", "# Conventions\n");
  await writeMemory(workspaceRoot, "TESTING.md", "# Testing\n");
  await writeMemory(workspaceRoot, "MEMORY.md", "# Memory\n");
  await writeMemory(workspaceRoot, "files/src/payments.ts.md", "# Payments\n\nPayment workflow summary.\n");

  const pack = await createContextPack({
    task: "Fix payment workflow",
    workspaceRoot,
    inventory: inventory({
      "src/payments.ts": entry("Payment workflow runtime", ".apeiron/memory/files/src/payments.ts.md")
    }),
    coverage: coverage()
  });

  assert.equal(pack.items.some((item) => item.source === ".apeiron/memory/files/src/payments.ts.md"), false);
  assert.ok(pack.items.some((item) => item.source === ".apeiron/memory/PROJECT.md"));
  assert.ok(pack.tokensEstimate > 0);
});

test("priority paths are pinned context items", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-context-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");
  for (const fileName of ["PROJECT.md", "MODULES.md", "CONVENTIONS.md", "TESTING.md", "MEMORY.md"]) {
    await writeMemory(workspaceRoot, fileName, `# ${fileName}\n`);
  }

  const pack = await createContextPack({
    task: "Inspect src",
    workspaceRoot,
    inventory: inventory({
      "src.ts": entry("Runtime file", ".apeiron/memory/files/src.ts.md")
    }),
    coverage: coverage(),
    priorityPaths: ["src.ts"]
  });

  const pinned = pack.items.find((item) => item.source === "src.ts");
  assert.equal(pinned?.pinned, true);
  assert.equal(pinned?.addedBy, "user");
  assert.equal(pinned?.enabled, true);
});

test("updateContextPack toggles enabled items without deleting them", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-context-"));
  for (const fileName of ["PROJECT.md", "MODULES.md", "CONVENTIONS.md", "TESTING.md", "MEMORY.md"]) {
    await writeMemory(workspaceRoot, fileName, `# ${fileName}\n`);
  }
  const pack = await createContextPack({
    task: "Inspect",
    workspaceRoot,
    inventory: inventory({}),
    coverage: coverage()
  });
  const project = pack.items.find((item) => item.source === ".apeiron/memory/PROJECT.md");
  assert.ok(project);

  const next = updateContextPack(pack, { setEnabled: [{ id: project.id, enabled: false }] });

  assert.ok(next.items.find((item) => item.id === project.id));
  assert.equal(enabledContextItems(next).some((item) => item.id === project.id), false);
});

test("revalidateContextPack disables stale file context", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-context-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");
  const item = createContextItem({
    type: "file",
    source: "src.ts",
    title: "src.ts",
    summary: "source",
    content: "export const value = 1;\n",
    reason: "test"
  });
  const pack = {
    version: 1,
    task: "Inspect",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    workspaceRoot: ".",
    coverageStatus: "ready",
    budgetTokens: 24000,
    tokensEstimate: item.tokensEstimate,
    items: [item]
  };

  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 2;\n", "utf8");
  const next = await revalidateContextPack(workspaceRoot, pack);

  assert.equal(next.items[0].validity, "stale");
  assert.equal(next.items[0].enabled, false);
});

test("revalidateContextPack marks tool results as historical", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-context-"));
  const item = createContextItem({
    type: "tool-result",
    source: "command:npm test",
    title: "Command",
    summary: "old command output",
    content: "ok",
    reason: "test"
  });
  const pack = {
    version: 1,
    task: "Inspect",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    workspaceRoot: ".",
    coverageStatus: "ready",
    budgetTokens: 24000,
    tokensEstimate: item.tokensEstimate,
    items: [item]
  };

  const next = await revalidateContextPack(workspaceRoot, pack);

  assert.equal(next.items[0].validity, "historical");
  assert.equal(next.items[0].enabled, false);
});

async function writeMemory(workspaceRoot, repoPath, content) {
  const absolutePath = path.join(workspaceRoot, ".apeiron", "memory", ...repoPath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}
