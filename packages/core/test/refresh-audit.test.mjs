import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditRefresh } from "../dist/memory/refresh-audit.js";

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

function entry(summaryRef) {
  return {
    kind: "runtime",
    status: "documented",
    summaryRef,
    purpose: "test file",
    reason: null,
    hash: null,
    lastReadAt: null,
    lastRefreshAt: null
  };
}

test("auditRefresh validates final refresh result without process-tool obligations", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-refresh-audit-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");
  await fs.mkdir(path.join(workspaceRoot, ".apeiron", "memory", "files"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, ".apeiron", "memory", "files", "src.ts.md"), "# src.ts\n", "utf8");

  const result = await auditRefresh({
    workspaceRoot,
    inventory: inventory({
      "src.ts": entry(".apeiron/memory/files/src.ts.md")
    }),
    targets: [
      {
        path: "src.ts",
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "test"
      }
    ],
    events: [],
    finish: {
      checked: [{ path: "src.ts", summaryRef: ".apeiron/memory/files/src.ts.md", updated: false }],
      blocked: []
    }
  });

  assert.equal(result.finishAllowed, true);
  assert.equal(result.remaining.length, 0);
});

test("auditRefresh warns when updated target did not update inventory", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apeiron-refresh-audit-"));
  await fs.writeFile(path.join(workspaceRoot, "src.ts"), "export const value = 1;\n", "utf8");
  await fs.mkdir(path.join(workspaceRoot, ".apeiron", "memory", "files"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, ".apeiron", "memory", "files", "src.ts.md"), "# src.ts\n", "utf8");

  const result = await auditRefresh({
    workspaceRoot,
    inventory: inventory({
      "src.ts": entry(".apeiron/memory/files/src.ts.md")
    }),
    targets: [
      {
        path: "src.ts",
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "test"
      }
    ],
    events: [],
    finish: {
      checked: [{ path: "src.ts", summaryRef: ".apeiron/memory/files/src.ts.md", updated: true }],
      blocked: []
    }
  });

  assert.equal(result.finishAllowed, true);
  assert.equal(result.warnings[0].type, "updated-without-inventory-update");
});
