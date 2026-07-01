import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCoverage, reconcileInventoryCoverage } from "../dist/memory/coverage.js";

test("inspectCoverage does not mutate or reconcile the input inventory", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-coverage-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");

  const inventory = {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "unknown",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files: {}
  };
  const before = JSON.stringify(inventory);

  const scan = await inspectCoverage(workspaceRoot, inventory);

  assert.equal(JSON.stringify(inventory), before);
  assert.equal(scan.issues.length, 1);
  assert.equal(scan.issues[0].type, "new-file");
  assert.equal(scan.inventory.files["src.ts"], undefined);
  assert.equal(scan.reconciledInventory.files["src.ts"].status, "unread");
});

test("inspectCoverage reports stale files without overwriting documented hash", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-coverage-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 2;\n", "utf8");

  const inventory = {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "unknown",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files: {
      "src.ts": {
        kind: "runtime",
        status: "documented",
        summaryRef: ".apeiron/memory/files/src.ts.md",
        purpose: "test file",
        reason: null,
        hash: "sha256:documented",
        lastReadAt: null,
        lastRefreshAt: null
      }
    }
  };

  await fs.mkdir(path.join(workspaceRoot, ".apeiron", "memory", "files"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, ".apeiron", "memory", "files", "src.ts.md"), "# src.ts\n", "utf8");

  const scan = await inspectCoverage(workspaceRoot, inventory);

  assert.equal(scan.issues.length, 1);
  assert.equal(scan.issues[0].type, "content-changed");
  assert.equal(scan.issues[0].inventoryHash, "sha256:documented");
  assert.match(scan.issues[0].currentHash, /^sha256:/);
  assert.equal(scan.inventory.files["src.ts"].status, "documented");
  assert.equal(scan.inventory.files["src.ts"].reason, null);
  assert.equal(scan.reconciledInventory.files["src.ts"].status, "stale");
  assert.equal(scan.reconciledInventory.files["src.ts"].reason, "content-changed");
  assert.equal(scan.inventory.files["src.ts"].hash, "sha256:documented");
});

test("reconcileInventoryCoverage returns the writable inventory view", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-coverage-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");

  const inventory = {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "unknown",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files: {}
  };

  const reconciled = await reconcileInventoryCoverage(workspaceRoot, inventory);

  assert.equal(reconciled.files["src.ts"].status, "unread");
  assert.equal(inventory.files["src.ts"], undefined);
});

test("inspectCoverage only tracks default focused project files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-coverage-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "logs", "debug.log"), "debug\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "hero.png"), "not really an image\n", "utf8");

  const inventory = {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "unknown",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files: {}
  };

  const scan = await inspectCoverage(workspaceRoot, inventory);

  assert.deepEqual(scan.issues.map((issue) => issue.path).sort(), ["package.json", "src/app.ts"]);
  assert.equal(scan.reconciledInventory.files["src/app.ts"].status, "unread");
  assert.equal(scan.reconciledInventory.files["package.json"].status, "unread");
  assert.equal(scan.reconciledInventory.files["logs/debug.log"], undefined);
  assert.equal(scan.reconciledInventory.files["hero.png"], undefined);
});
