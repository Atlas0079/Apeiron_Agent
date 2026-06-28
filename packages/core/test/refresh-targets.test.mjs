import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefreshTargets } from "../dist/memory/refresh-target-policy.js";

function inventory(files) {
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

function readTarget(path) {
  return {
    path,
    kinds: ["read"],
    priority: "opportunistic",
    reason: "file was read during work"
  };
}

test("drops read targets for documented files with summaryRef", () => {
  const result = resolveRefreshTargets({
    targetGroups: [[readTarget("src/a.ts")]],
    inventory: inventory({
      "src/a.ts": entry("documented", ".apeiron/memory/files/src/a.ts.md")
    })
  });

  assert.deepEqual(result, []);
});

test("keeps unread read targets as opportunistic warmup", () => {
  const result = resolveRefreshTargets({
    targetGroups: [[readTarget("src/a.ts")]],
    inventory: inventory({
      "src/a.ts": entry("unread")
    })
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].priority, "opportunistic");
});

test("upgrades stale read targets to must-refresh", () => {
  const result = resolveRefreshTargets({
    targetGroups: [[readTarget("src/a.ts")]],
    inventory: inventory({
      "src/a.ts": entry("stale", ".apeiron/memory/files/src/a.ts.md")
    })
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].priority, "must-refresh");
});

test("upgrades documented read targets that are missing summaryRef", () => {
  const result = resolveRefreshTargets({
    targetGroups: [[readTarget("src/a.ts")]],
    inventory: inventory({
      "src/a.ts": entry("documented")
    })
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].priority, "must-refresh");
});

test("keeps modified targets as must-refresh even when documented", () => {
  const result = resolveRefreshTargets({
    targetGroups: [[
      {
        path: "src/a.ts",
        kinds: ["modified"],
        priority: "must-refresh",
        reason: "git status reports modified file"
      }
    ]],
    inventory: inventory({
      "src/a.ts": entry("documented", ".apeiron/memory/files/src/a.ts.md")
    })
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].priority, "must-refresh");
});

test("merges duplicate targets from multiple sources before applying inventory policy", () => {
  const result = resolveRefreshTargets({
    targetGroups: [
      [readTarget("src/a.ts")],
      [
        {
          path: "src/a.ts",
          kinds: ["modified"],
          priority: "must-refresh",
          reason: "git status reports modified file"
        }
      ]
    ],
    inventory: inventory({
      "src/a.ts": entry("documented", ".apeiron/memory/files/src/a.ts.md")
    })
  });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].kinds, ["modified", "read"]);
  assert.equal(result[0].priority, "must-refresh");
});
