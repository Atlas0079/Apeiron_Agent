import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshContracts } from "../dist/memory/refresh-contract.js";

function inventory(files = {}) {
  return {
    version: 1,
    workspaceRoot: ".",
    coverage: {
      mode: "unknown",
      scope: null,
      createdAt: "2026-06-28T00:00:00.000Z",
      lastFullWarmupAt: null
    },
    files
  };
}

function entry(status, summaryRef = null) {
  return {
    kind: "runtime",
    status,
    summaryRef,
    purpose: "test file",
    reason: null,
    hash: "sha256:test",
    lastReadAt: null,
    lastRefreshAt: null
  };
}

test("contract centralizes modified file refresh obligations", () => {
  const [contract] = createRefreshContracts({
    inventory: inventory({
      "src/a.ts": entry("documented", ".apeiron/memory/files/src/a.ts.md")
    }),
    targets: [
      {
        path: "src/a.ts",
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "git status reports modified file"
      }
    ]
  });

  assert.equal(contract.priority, "must-refresh");
  assert.equal(contract.summaryRef, ".apeiron/memory/files/src/a.ts.md");
  assert.deepEqual(contract.issues, []);
  assert.deepEqual(contract.obligations, {
    inspectInventory: true,
    readSource: true,
    readDiff: true,
    readSummary: true,
    requireFinishCheck: true,
    requireNoUpdateReasonIfClean: true,
    updateInventoryIfUpdated: true
  });
});

test("contract can mark documented read-only opportunistic target as skippable", () => {
  const [contract] = createRefreshContracts({
    inventory: inventory({
      "src/a.ts": entry("documented", ".apeiron/memory/files/src/a.ts.md")
    }),
    targets: [
      {
        path: "src/a.ts",
        kinds: ["read"],
        priority: "opportunistic",
        reason: "file was read during work"
      }
    ]
  });

  assert.equal(contract.priority, "ignore-unless-memory-wrong");
  assert.equal(contract.skipReason, "read-only opportunistic target already has inventory status documented");
  assert.equal(contract.obligations.requireFinishCheck, false);
});
