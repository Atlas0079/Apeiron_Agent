import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshPlan } from "../dist/memory/refresh-plan.js";

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

test("refresh plan reports missing facts as issues instead of blocking", () => {
  const plan = createRefreshPlan({
    inventory: inventory(),
    targets: [
      {
        path: "src/a.ts",
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "git status reports modified file"
      }
    ]
  });

  assert.equal("status" in plan, false);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].priority, "must-refresh");
  assert.deepEqual(plan.items[0].issues, ["missing-inventory-entry", "missing-summary-ref"]);
  assert.equal("blockedReason" in plan.items[0], false);
});
